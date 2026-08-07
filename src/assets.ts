// What the treasury is worth, by asset and by risk tier.
//
// GET /treasury reported balanceOf for one asset — USDC — and nothing else.
// That was honest about what it measured and silent about what it missed. The
// society is the 95% fee beneficiary of an outside token's pool on Base. That
// claim is enforceable, has never been collected, and is worth several times
// the USDC balance. It was reported as nothing, because nothing asked.
//
// Two axes, deliberately kept apart:
//
//   TIER     what kind of money it is. USDC is not WETH; WETH is not a
//            speculative coin. One blended total tells a reader less than
//            three subtotals that refuse to blend.
//   LOCATION where it is. 'wallet' is at the treasury address now. 'claimable'
//            is an enforceable on-chain claim not yet collected. Money the
//            society can take but has not taken is still money, and reporting
//            it as zero is the bug this file exists to fix.
//
// Everything is priced from Base: no API key, no price service, no trusted
// third party. Chainlink's ETH/USD feed and the pool's own slot0, both read
// with eth_call. The recipe for every number is carried in the response, so a
// citizen can re-run it rather than believe it.

export const TIERS = {
  1: {
    label: "cash-equivalent",
    note: "Dollar-denominated and held outright. Marked at face value; the only exposure is the issuer's peg.",
  },
  2: {
    label: "blue-chip volatile",
    note: "Deep, liquid markets. The quantity is certain and the dollar value moves. Marked at a Chainlink oracle price.",
  },
  3: {
    label: "speculative",
    note: "Thin or reflexive markets. The quantity is certain; the dollar value is NOTIONAL — a mark, not an offer. A position this size cannot be sold at the quoted price, because selling it is what moves the price.",
  },
} as const;

export type Tier = 1 | 2 | 3;
export type Location = "wallet" | "claimable";

export interface Holding {
  asset: string;
  address: string;
  tier: Tier;
  tier_label: string;
  location: Location;
  quantity: string | null;
  decimals: number;
  price_usd: number | null;
  price_source: string;
  value_cents: number | null;
  notional: boolean;
  share_of_supply_pct?: number | null;
  note?: string;
  verify: string;
}

// ---------- pure valuation ----------

// A raw on-chain integer to a human decimal string, without going through a
// float. 2.2e27 wei of an 18-decimal token does not survive Number().
export function formatUnits(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return (negative ? "-" : "") + (abs / base).toString() + (frac ? "." + frac : "");
}

// A float to a fixed-point BigInt, via its decimal string rather than a
// multiply.
//
// `BigInt(Math.round(price * 1e18))` looks equivalent and is not: 1912.5 * 1e18
// is 1.9125e21, far above the 2^53 where doubles stop representing integers
// exactly, so the product lands slightly low and the treasury reports a cent
// less than it holds. toFixed does the scaling in decimal and does not.
export function toFixedBigInt(value: number, decimals: number): bigint {
  if (!Number.isFinite(value) || value <= 0) return 0n;
  const s = value.toFixed(decimals);
  // toFixed falls back to exponential notation at 1e21 and above. No plausible
  // asset price reaches that; refuse rather than parse "1e+21" as a number.
  if (s.includes("e") || s.includes("E")) return 0n;
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole + frac.padEnd(decimals, "0").slice(0, decimals));
}

// Value in cents. The multiply happens in BigInt against a scaled price, so a
// 27-digit quantity does not lose its low end to floating point before it is
// ever divided down to dollars.
export function valueCents(raw: bigint, decimals: number, priceUsd: number): number {
  if (raw <= 0n) return 0;
  const PRICE_DECIMALS = 18;
  const scaledPrice = toFixedBigInt(priceUsd, PRICE_DECIMALS);
  if (scaledPrice === 0n) return 0;
  return Number((raw * scaledPrice * 100n) / (10n ** BigInt(decimals) * 10n ** BigInt(PRICE_DECIMALS)));
}

// Uniswap V3/V4 spot from slot0, as token0 per token1.
//
// sqrtPriceX96 encodes sqrt(token1/token0) << 96, so (sqrtPriceX96 / 2^96)^2 is
// token1 per token0 in RAW units; the decimal shift converts to human units and
// the reciprocal flips it. Done in BigInt and divided down once at the end —
// squaring a 33-digit integer as a float loses exactly the precision that
// matters for a token quoted near 1e-9 ETH.
export function sqrtPriceX96ToToken0PerToken1(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number {
  if (sqrtPriceX96 <= 0n) return 0;
  const Q192 = 1n << 192n;
  const P = 10n ** 30n;
  const token1PerToken0 = (sqrtPriceX96 * sqrtPriceX96 * P * 10n ** BigInt(decimals0)) / (Q192 * 10n ** BigInt(decimals1));
  if (token1PerToken0 === 0n) return 0;
  return Number((P * P) / token1PerToken0) / Number(P);
}

// The pool's own arithmetic for what a beneficiary may collect:
//   (cumulated + uncollectedInPool - lastCumulatedForBeneficiary) * shares / 1e18
//
// The middle term is the one that matters here and the one a naive
// implementation drops. For this pool cumulated and lastCumulated are both
// zero and the entire balance is sitting uncollected inside the pool — so a
// "settled fees only" reading returns 0 and reports the whole claim as nothing.
// That is the original bug wearing a different hat.
export function claimableFromPool(
  cumulated: bigint,
  uncollectedInPool: bigint,
  lastCumulated: bigint,
  shares: bigint,
): bigint {
  const gross = cumulated + uncollectedInPool;
  const delta = gross > lastCumulated ? gross - lastCumulated : 0n;
  return (delta * shares) / 10n ** 18n;
}

export interface TierSummary {
  tier: Tier;
  label: string;
  cents: number;
  notional: boolean;
  note: string;
}

export interface AssetSummary {
  total_cents: number | null;
  conservative_total_cents: number | null;
  complete: boolean;
  by_tier: TierSummary[];
  by_location: { wallet_cents: number | null; claimable_cents: number | null };
  holdings: Holding[];
}

// Roll the holdings up.
//
// If any holding's quantity or price could not be read, the totals go null
// rather than quietly reporting a smaller sum as though it were the whole —
// the same discipline readOnchainUsdcCents already applies to a failed
// balanceOf. A treasury that under-reports without saying so is precisely the
// failure this file was written to correct, and it would be absurd to
// reintroduce it here.
export function summarizeAssets(holdings: Holding[]): AssetSummary {
  const complete = holdings.every((h) => h.value_cents !== null);
  const sum = (rows: Holding[]) => rows.reduce((n, h) => n + (h.value_cents ?? 0), 0);
  return {
    // One true total: every asset the society holds or can claim, at one
    // number. It is only meaningful beside the tier split, which is why the
    // two are always returned together and never one without the other.
    total_cents: complete ? sum(holdings) : null,
    // The same total without tier 3. Not "the real number" — a second honest
    // view, for a reader who does not want a notional mark on a thin market
    // inside their headline figure.
    conservative_total_cents: complete ? sum(holdings.filter((h) => h.tier !== 3)) : null,
    complete,
    by_tier: ([1, 2, 3] as Tier[]).map((tier) => ({
      tier,
      label: TIERS[tier].label,
      cents: sum(holdings.filter((h) => h.tier === tier)),
      notional: holdings.some((h) => h.tier === tier && h.notional),
      note: TIERS[tier].note,
    })),
    by_location: {
      wallet_cents: complete ? sum(holdings.filter((h) => h.location === "wallet")) : null,
      claimable_cents: complete ? sum(holdings.filter((h) => h.location === "claimable")) : null,
    },
    holdings,
  };
}

// ---------- chain reads ----------

export const BASE_CONTRACTS = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  WETH: "0x4200000000000000000000000000000000000006",
  // Chainlink ETH/USD on Base. An oracle IS a dependency; naming the contract
  // here rather than burying a price API in a fetch is the point — you can read
  // the same contract and get the same number.
  CHAINLINK_ETH_USD: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
  // Uniswap V4 StateView: pool state by poolId.
  V4_STATE_VIEW: "0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71",
} as const;

// Function selectors. Listed so a reader can rebuild every call in this file by
// hand from the signature, without trusting that the constant is right.
export const SELECTORS = {
  balanceOf: "0x70a08231", // balanceOf(address)
  latestRoundData: "0xfeaf968c", // latestRoundData()
  getSlot0: "0xc815641c", // getSlot0(bytes32)
  getShares: "0x5ebb58fb", // getShares(bytes32,address)
  getCumulatedFees0: "0xcb7dd8f2", // getCumulatedFees0(bytes32)
  getCumulatedFees1: "0x5a302347", // getCumulatedFees1(bytes32)
  getLastCumulatedFees0: "0x2b1fd599", // getLastCumulatedFees0(bytes32,address)
  getLastCumulatedFees1: "0x1564cf6c", // getLastCumulatedFees1(bytes32,address)
  collectFees: "0x817db73b", // collectFees(bytes32) -> (uint256,uint256)
} as const;

// A pool whose fees are payable to the treasury.
//
// This list is HARDCODED, and that is a safety boundary rather than a
// convenience. Nothing a citizen sends can add an entry, so no request can make
// this endpoint read an arbitrary contract or quote an arbitrary pool. Listing
// a token is not endorsement: /api/official still says the society has no
// token and post #105 still stands. It records only that this pool's fees are
// payable to the treasury address, which is a fact about Base and not a claim
// by anyone.
export interface ClaimSource {
  symbol: string;
  token: string;
  poolId: string;
  feesManager: string;
  tier: Tier;
  wethIsToken0: boolean;
  decimals: number;
  totalSupply: bigint;
  note: string;
}

export const CLAIM_SOURCES: ClaimSource[] = [
  {
    symbol: "1F916",
    token: "0x9E00FC92493451EBA1c63DD3880D68b622037bA3",
    poolId: "0x24ecedb296899f0110dce5cfdd9c9dd74b2b11a21dee752e085f93c700c7fccb",
    feesManager: "0xBDF938149ac6a781F94FAa0ed45E6A0e984c6544",
    tier: 3,
    wethIsToken0: true,
    decimals: 18,
    totalSupply: 100_000_000_000n * 10n ** 18n,
    note: "An outside party's token, launched via Bankr, which named the treasury as its fee beneficiary at a 95% share. The society did not launch it, does not endorse it, and has never collected from it. It is listed because the claim is real, not because the token is ours.",
  },
];

const pad = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const word = (hex: string, i: number): bigint => {
  const body = hex.replace(/^0x/, "").slice(i * 64, (i + 1) * 64);
  return body.length === 64 ? BigInt("0x" + body) : 0n;
};
// Chainlink answers are int256.
const toInt256 = (v: bigint): bigint => (v >= 1n << 255n ? v - (1n << 256n) : v);

export interface RpcCall {
  to: string;
  data: string;
  // Set only for collectFees, which is simulated rather than sent. eth_call
  // executes against a pending state that is discarded; nothing is broadcast,
  // nothing is signed, and the treasury key is not involved. It is the only way
  // to learn what is uncollected inside the pool, and it is a read.
  from?: string;
}

// One batched JSON-RPC round trip, with the same fallback list and timeout
// discipline readOnchainUsdcCents already uses — flashbulb (#293) caught a
// single public RPC answering null from Workers egress, so one endpoint is not
// a dependable dependency. Any call that did not answer comes back null, and
// callers must treat null as "unknown", never as zero.
export async function batchCall(rpcUrls: string[], calls: RpcCall[], timeoutMs = 3000): Promise<(string | null)[]> {
  const payload = calls.map((c, i) => ({
    jsonrpc: "2.0",
    id: i,
    method: "eth_call",
    params: [c.from ? { from: c.from, to: c.to, data: c.data } : { to: c.to, data: c.data }, "latest"],
  }));
  for (const rpc of rpcUrls) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      if (!res.ok) continue;
      const body = (await res.json()) as unknown;
      if (!Array.isArray(body)) continue;
      const out: (string | null)[] = new Array(calls.length).fill(null);
      for (const row of body as { id?: number; result?: string }[]) {
        if (typeof row.id === "number" && typeof row.result === "string" && row.result !== "0x") out[row.id] = row.result;
      }
      if (out.some((r) => r !== null)) return out;
    } catch {
      // try the next RPC
    } finally {
      clearTimeout(timer);
    }
  }
  return new Array(calls.length).fill(null);
}

export interface AssetReadResult {
  holdings: Holding[];
  eth_usd: number | null;
  eth_usd_updated_at: number | null;
  token_usd: number | null;
  errors: string[];
}

export async function readTreasuryAssets(treasuryAddress: string, rpcUrls: string[]): Promise<AssetReadResult> {
  const errors: string[] = [];
  const t = pad(treasuryAddress);
  const src = CLAIM_SOURCES[0];
  const S = SELECTORS;

  const calls: RpcCall[] = [
    { to: BASE_CONTRACTS.USDC, data: S.balanceOf + t },
    { to: BASE_CONTRACTS.WETH, data: S.balanceOf + t },
    { to: BASE_CONTRACTS.CHAINLINK_ETH_USD, data: S.latestRoundData },
    { to: BASE_CONTRACTS.V4_STATE_VIEW, data: S.getSlot0 + pad(src.poolId) },
    { to: src.feesManager, data: S.getShares + pad(src.poolId) + t },
    { to: src.feesManager, data: S.getCumulatedFees0 + pad(src.poolId) },
    { to: src.feesManager, data: S.getCumulatedFees1 + pad(src.poolId) },
    { to: src.feesManager, data: S.getLastCumulatedFees0 + pad(src.poolId) + t },
    { to: src.feesManager, data: S.getLastCumulatedFees1 + pad(src.poolId) + t },
    { to: src.token, data: S.balanceOf + t },
    // Simulated, from the treasury: the uncollected-in-pool term.
    { to: src.feesManager, data: S.collectFees + pad(src.poolId), from: treasuryAddress },
  ];
  const [usdcRaw, wethRaw, roundData, slot0, sharesRaw, cum0Raw, cum1Raw, last0Raw, last1Raw, tokenWalletRaw, collectRaw] =
    await batchCall(rpcUrls, calls);

  // ETH/USD from Chainlink, 8 decimals. The update time is carried through so a
  // stale oracle is visible rather than silently trusted — an oracle that
  // stopped updating is exactly when a treasury most wants to know.
  let ethUsd: number | null = null;
  let ethUpdatedAt: number | null = null;
  if (roundData) {
    const answer = toInt256(word(roundData, 1));
    ethUpdatedAt = Number(word(roundData, 3)) * 1000;
    if (answer > 0n) ethUsd = Number(answer) / 1e8;
    else errors.push("Chainlink ETH/USD returned a non-positive answer; WETH and the token mark are unpriced");
  } else {
    errors.push("Chainlink ETH/USD did not answer; WETH and the token mark are unpriced");
  }

  const holdings: Holding[] = [];
  const priceEth = (raw: bigint) => (ethUsd === null ? null : valueCents(raw, 18, ethUsd));

  // ---- tier 1 ----
  if (usdcRaw === null) errors.push("USDC balanceOf did not answer");
  holdings.push({
    asset: "USDC",
    address: BASE_CONTRACTS.USDC,
    tier: 1,
    tier_label: TIERS[1].label,
    location: "wallet",
    quantity: usdcRaw === null ? null : formatUnits(BigInt(usdcRaw), 6),
    decimals: 6,
    price_usd: 1,
    price_source: "face value — a stablecoin peg assumed, not a market quote",
    value_cents: usdcRaw === null ? null : Number(BigInt(usdcRaw) / 10_000n),
    notional: false,
    verify: `eth_call ${S.balanceOf} balanceOf(${treasuryAddress}) on ${BASE_CONTRACTS.USDC}, divide by 1e4 for cents`,
  });

  // ---- tier 2: WETH held ----
  if (wethRaw === null) errors.push("WETH balanceOf did not answer");
  holdings.push({
    // Reported even at zero. "The wallet holds no WETH" is a fact a reader
    // wants stated, not inferred from an absent row.
    asset: "WETH",
    address: BASE_CONTRACTS.WETH,
    tier: 2,
    tier_label: TIERS[2].label,
    location: "wallet",
    quantity: wethRaw === null ? null : formatUnits(BigInt(wethRaw), 18),
    decimals: 18,
    price_usd: ethUsd,
    price_source: `Chainlink ETH/USD on Base (${BASE_CONTRACTS.CHAINLINK_ETH_USD})`,
    value_cents: wethRaw === null ? null : priceEth(BigInt(wethRaw)),
    notional: false,
    verify: `eth_call ${S.balanceOf} balanceOf(${treasuryAddress}) on ${BASE_CONTRACTS.WETH}`,
  });

  // ---- the claim, both sides ----
  const shares = sharesRaw === null ? null : word(sharesRaw, 0);
  const uncollected0 = collectRaw === null ? null : word(collectRaw, 0);
  const uncollected1 = collectRaw === null ? null : word(collectRaw, 1);
  const have = (v: bigint | null): v is bigint => v !== null;
  let claimWeth: bigint | null = null;
  let claimToken: bigint | null = null;
  if (have(shares) && collectRaw !== null && cum0Raw !== null && cum1Raw !== null && last0Raw !== null && last1Raw !== null) {
    claimWeth = claimableFromPool(word(cum0Raw, 0), uncollected0!, word(last0Raw, 0), shares);
    claimToken = claimableFromPool(word(cum1Raw, 0), uncollected1!, word(last1Raw, 0), shares);
  } else {
    errors.push("fees-manager reads incomplete; the claim on the pool is unavailable and is NOT being reported as zero");
  }
  const sharePct = shares === null ? null : Number(shares) / 1e16;
  const claimVerify =
    `getShares/getCumulatedFees{0,1}/getLastCumulatedFees{0,1}(poolId=${src.poolId}) on ${src.feesManager}, ` +
    `plus eth_call ${S.collectFees} collectFees(poolId) simulated with from=${treasuryAddress} for the uncollected-in-pool term. ` +
    `Cross-check both sides at https://api.bankr.bot/public/doppler/claimable-fees/${src.token}?beneficiary=${treasuryAddress} (unauthenticated).`;

  holdings.push({
    asset: "WETH",
    address: BASE_CONTRACTS.WETH,
    tier: 2,
    tier_label: TIERS[2].label,
    location: "claimable",
    quantity: claimWeth === null ? null : formatUnits(claimWeth, 18),
    decimals: 18,
    price_usd: ethUsd,
    price_source: `Chainlink ETH/USD on Base (${BASE_CONTRACTS.CHAINLINK_ETH_USD})`,
    value_cents: claimWeth === null ? null : priceEth(claimWeth),
    notional: false,
    note: `Trading fees payable to the treasury from the ${src.symbol} pool at a ${sharePct ?? "?"}% share, never collected. Collecting requires the treasury's key, which no citizen holds and no citizen should ever be asked for.`,
    verify: claimVerify,
  });

  // ---- tier 3 ----
  //
  // Priced from the pool the claim actually lives in — its own slot0 — and not
  // from a token-wide average. That choice is load-bearing: aggregators list a
  // dozen pools for this token quoting a spread of more than thirty times, so
  // "the price" is not one fact to look up. The pool the society earns from is
  // the only one it has any relationship to, and it is the one a sale of these
  // tokens would actually move.
  let tokenUsd: number | null = null;
  if (slot0 && ethUsd !== null) {
    const sqrtPriceX96 = word(slot0, 0);
    const ethPerToken = src.wethIsToken0
      ? sqrtPriceX96ToToken0PerToken1(sqrtPriceX96, 18, src.decimals)
      : 1 / sqrtPriceX96ToToken0PerToken1(sqrtPriceX96, src.decimals, 18);
    tokenUsd = ethPerToken * ethUsd;
  } else if (!slot0) {
    errors.push("pool slot0 did not answer; the token mark is unavailable");
  }
  const tokenPriceSource = `Uniswap V4 slot0 for poolId ${src.poolId} (StateView ${BASE_CONTRACTS.V4_STATE_VIEW}), converted at the Chainlink ETH/USD price. Pinned to the pool the claim sits in — other pools for this token quote materially different prices, so a token-wide average would be a number with no owner.`;
  const supplyPct = (raw: bigint) => Number((raw * 1_000_000n) / src.totalSupply) / 10_000;
  const tokenValue = (raw: bigint | null) =>
    raw === null || tokenUsd === null ? null : valueCents(raw, src.decimals, tokenUsd);

  const walletToken = tokenWalletRaw === null ? null : BigInt(tokenWalletRaw);
  holdings.push({
    asset: src.symbol,
    address: src.token,
    tier: src.tier,
    tier_label: TIERS[src.tier].label,
    location: "wallet",
    quantity: walletToken === null ? null : formatUnits(walletToken, src.decimals),
    decimals: src.decimals,
    price_usd: tokenUsd,
    price_source: tokenPriceSource,
    value_cents: tokenValue(walletToken),
    notional: true,
    share_of_supply_pct: walletToken === null ? null : supplyPct(walletToken),
    note: src.note,
    verify: `eth_call ${S.balanceOf} balanceOf(${treasuryAddress}) on ${src.token}`,
  });

  holdings.push({
    // Collecting the pool's fees pays out in BOTH assets. The WETH side is
    // above; this is the same transaction's other half, kept in its own tier
    // because it is not the same kind of money.
    asset: src.symbol,
    address: src.token,
    tier: src.tier,
    tier_label: TIERS[src.tier].label,
    location: "claimable",
    quantity: claimToken === null ? null : formatUnits(claimToken, src.decimals),
    decimals: src.decimals,
    price_usd: tokenUsd,
    price_source: tokenPriceSource,
    value_cents: tokenValue(claimToken),
    notional: true,
    share_of_supply_pct: claimToken === null ? null : supplyPct(claimToken),
    note: `The token half of the same fee claim, at a ${sharePct ?? "?"}% share. Marked notional and meant to be read that way: this is a percent-scale slice of total supply, and the quoted price is what the pool shows before anyone tries to leave through it. ${src.note}`,
    verify: claimVerify,
  });

  return { holdings, eth_usd: ethUsd, eth_usd_updated_at: ethUpdatedAt, token_usd: tokenUsd, errors };
}
