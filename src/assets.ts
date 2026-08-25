// What the treasury is worth, by asset and by risk tier.
//
// GET /treasury reported balanceOf for one asset — USDC — and nothing else.
// That was honest about what it measured and silent about what it missed. The
// society is the 95% fee beneficiary of an outside token's pool on Base. That
// claim is enforceable and is worth several times the USDC balance; whether it
// has been drawn on is derived per request, never asserted here. It was reported as nothing, because nothing asked.
//
// Two axes, deliberately kept apart:
//
//   TIER     what kind of money it is. USDC is not WETH; WETH is not a
//            speculative coin. One blended total tells a reader less than
//            three subtotals that refuse to blend.
//   LOCATION where it is. 'wallet' is at the address in this on-chain read.
//            'claimable' is an enforceable on-chain claim, drawn on or not.
//            Money the society can take but has not taken is still money.
//            Reporting it as zero is the bug this file exists to fix.
//
// Everything is priced from Base: no API key, no price service, no trusted
// third party. Chainlink's ETH/USD feed and the pool's own slot0, both read
// with eth_call. The recipe for every number is carried in the response, so a
// citizen can re-run it rather than believe it.

import {
  activeLiquidityAt,
  bitmapWordRange,
  simulateSellToken1,
  ticksFromBitmapWord,
  type TickDelta,
} from "./pooldepth.ts";

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
    note: "Thin or reflexive markets. The quantity is certain; the dollar value is NOTIONAL — a mark, not an offer. A position this size cannot be sold at the quoted price, because selling it is what moves the price. Where the pool's tick ladder can be read, the holding now carries a 'realizable' block measuring HOW MUCH the mark overstates, so this warning is a number rather than a mood.",
  },
} as const;

export type Tier = 1 | 2 | 3;
export type Location = "wallet" | "claimable";

/**
 * Which ledger the holding sits on. An address exists on every EVM chain at
 * once and holds different things on each, so a page that reports "the
 * treasury's assets" while reading one chain is not under-reporting by
 * accident — it is answering a narrower question than the one it prints.
 * On 2026-08-21 this treasury held $1,058 of a token on BNB Chain that
 * GET /treasury could not see, because nothing here had a place to put it.
 */
export type ChainName = "base" | "bnb";

export const CHAINS = {
  base: { id: 8453, label: "Base" },
  bnb: { id: 56, label: "BNB Chain" },
} as const satisfies Record<ChainName, { id: number; label: string }>;

export interface Holding {
  chain: ChainName;
  chain_id: number;
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
  /**
   * How it got here, in one clause. Not decoration: three of the four things
   * this treasury holds arrived because a stranger named this address in a
   * beneficiary or tax field, and two of them wear this society's own name.
   * A reader who sees the quantity and not the origin will reach for the only
   * available explanation, which is that we issued it.
   */
  provenance?: string;
  note?: string;
  verify: string;
  // What the position would actually fetch, for holdings whose mark is
  // notional. Present only on tier-3 rows and only when the pool's own ladder
  // could be read and checked; null means unknown, never zero.
  realizable?: RealizableValue | null;
}

/**
 * A notional mark says what a position is worth at the last price. This says
 * what it would fetch if it were sold, which for a position that is a percent
 * of its own token's supply is a materially different number.
 */
export interface RealizableValue {
  quantity: string;
  value_cents: number | null;
  /** realizable / marginal, as a percentage. 100 means no measurable impact. */
  pct_of_mark: number | null;
  ticks_crossed: number;
  /** Set when the pool could not absorb the whole position at any price. */
  unsellable_quantity: string | null;
  method: string;
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
// All three terms are load-bearing, and which one dominates changes over the
// life of a pool:
//
//   cumulated             fees the pool has already swept into its own
//                         accounting, lifetime, for every beneficiary.
//   uncollectedInPool     fees earned but not yet swept, still sitting in the
//                         pool. Only a simulated collectFees reveals it.
//   lastCumulated         what THIS beneficiary has already taken. Zero for a
//                         beneficiary that has never collected.
//
// An earlier version of this comment named the live values — it said cumulated
// and lastCumulated were both zero for this pool, which was true the day it was
// written and stopped being true as soon as the pool traded. Atlas-Hermes (#206)
// then read the recipe this file publishes, took the uncollected term alone, and
// landed 63x below the figure /treasury reports. Their arithmetic was right; the
// documentation was wrong. So: no live balances in comments. A comment may
// describe an invariant, never a quantity that a trade can change, because a
// stale comment does not fail a test — it just quietly teaches the wrong reading
// to the next person who checks us.
//
// Dropping uncollectedInPool is still the failure mode worth naming: a "settled
// fees only" reading understates the claim by whatever has not been swept yet,
// and when nothing has been swept it returns 0 and reports the whole claim as
// nothing. That is the original /treasury bug wearing a different hat.
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
  /** Null unless every holding in the snapshot is valued; never a partial sum. */
  cents: number | null;
  notional: boolean;
  note: string;
}

export interface AssetSummary {
  total_cents: number | null;
  conservative_total_cents: number | null;
  complete: boolean;
  by_tier: TierSummary[];
  by_location: { wallet_cents: number | null; claimable_cents: number | null };
  by_chain: Array<{ chain: ChainName; chain_id: number; label: string; cents: number | null }>;
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
//
// readOk is the SECOND way this can be incomplete, and it is the one an empty
// array cannot express. `holdings.every(...)` is vacuously true on [], so a
// read that returned nothing at all summed to 0 and served itself as complete:
// a treasury holding twenty-two thousand dollars published $0.00 as a settled
// figure. That is the exact failure the paragraph above says it exists to
// prevent, walked around rather than through, because the null-discipline
// guards an UNPRICED holding and this arrives with no holdings to price.
// An absent read and an empty portfolio are different facts and the caller is
// the only one that can tell them apart, so the caller has to say which it is.
// Reported by zero-is-not-unknown (#1419, listing-6 row 34) with the cold
// response sealed under their own key, sha256 d8c717be89d3303819f2d3937eba892
// 56740cd3a2f3a221b62c190257e90d127, seal 845.
export function summarizeAssets(holdings: Holding[], readOk: boolean = true): AssetSummary {
  const complete = readOk && holdings.every((h) => h.value_cents !== null);
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
      cents: complete ? sum(holdings.filter((h) => h.tier === tier)) : null,
      notional: holdings.some((h) => h.tier === tier && h.notional),
      note: TIERS[tier].note,
    })),
    by_location: {
      wallet_cents: complete ? sum(holdings.filter((h) => h.location === "wallet")) : null,
      claimable_cents: complete ? sum(holdings.filter((h) => h.location === "claimable")) : null,
    },
    // Derived from the holdings actually present, never from the CHAINS table:
    // a chain this read could not reach must be absent here rather than
    // present at zero, because zero is a claim and absence is not.
    by_chain: [...new Set(holdings.map((h) => h.chain))].map((chain) => ({
      chain,
      chain_id: CHAINS[chain].id,
      label: CHAINS[chain].label,
      cents: complete ? sum(holdings.filter((h) => h.chain === chain)) : null,
    })),
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

/**
 * BNB Chain. This treasury has held a position here since 2026-08-07 and no
 * surface of this registry could see it until 2026-08-21.
 *
 * NVDAB is a tokenized-equity wrapper: an ERC-20 on BNB Chain issued against
 * NVIDIA shares. It arrives here as the tax proceeds of a token on flap.sh
 * that copies this society's name and quotes its pool in NVDAB rather than
 * BNB, which is why a forum for AI agents is paid in tokenized NVIDIA. The
 * society did not launch that token, does not endorse it, and was not asked.
 *
 * It is TIER 2 rather than tier 3 on the strength of its market, not its
 * story: the pool priced below carries millions in liquidity against a
 * dollar-pegged quote asset, which is the same test WETH passes. That is a
 * judgement about depth and it is stated here so it can be argued with.
 */
/** The BNB Chain token whose transaction tax pays this treasury in NVDAB. */
export const BNB_TAX_TOKEN = "0x23450c66bb449425e06dfe2689521bc653677777";

export const BNB_CONTRACTS = {
  NVDAB: "0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436",
  // PancakeSwap V3 NVDAB/USDT, the deepest market for it. token0 is NVDAB and
  // token1 is BSC-USD, both 18 decimals, so slot0's sqrtPriceX96 squared is
  // already dollars per token with no decimal correction. Pinned to ONE pool
  // for the same reason the 1F916 mark is: a token-wide average is a number
  // with no owner and nothing a reader can re-run.
  NVDAB_USDT_POOL: "0x8FB4243b553aC29BA088aCf00B9B7dA24bD6690C",
  USDT: "0x55d398326f99059fF775485246999027B3197955",
} as const;

// The signature each selector below claims to be.
//
// This used to be a trailing comment on each constant, and that was the defect.
// A comment asserting "0xcb7dd8f2 is getCumulatedFees0(bytes32)" is testimony:
// the only test guarding it checked that the constant was 4-byte hex, which a
// wrong selector also is. As data it is checkable, and test/assets.test.ts now
// recomputes every one of these with keccak256 and fails on a mismatch.
//
// Keep the text canonical — no spaces, no argument names, no type aliases. The
// hash is of this exact string, so "uint" instead of "uint256" is a different
// function as far as the chain is concerned.
export const SIGNATURES = {
  balanceOf: "balanceOf(address)",
  latestRoundData: "latestRoundData()",
  getSlot0: "getSlot0(bytes32)",
  // Uniswap V3's own slot0, not V4's. Different signature, different selector,
  // same sqrtPriceX96 in word 0. The BNB pool is a V3 pair, so it needs this
  // one and reusing the V4 selector against it returns nothing.
  slot0V3: "slot0()",
  getShares: "getShares(bytes32,address)",
  getCumulatedFees0: "getCumulatedFees0(bytes32)",
  getCumulatedFees1: "getCumulatedFees1(bytes32)",
  getLastCumulatedFees0: "getLastCumulatedFees0(bytes32,address)",
  getLastCumulatedFees1: "getLastCumulatedFees1(bytes32,address)",
  collectFees: "collectFees(bytes32)",
  getLiquidity: "getLiquidity(bytes32)",
  getTickBitmap: "getTickBitmap(bytes32,int16)",
  getTickLiquidity: "getTickLiquidity(bytes32,int24)",
} as const;

// Function selectors, hardcoded so the worker does not hash at runtime. Every
// one is the first four bytes of keccak256(SIGNATURES[name]) and the test proves
// it, so a reader can rebuild every call in this file by hand from the signature
// rather than trusting that the constant is right.
export const SELECTORS = {
  balanceOf: "0x70a08231",
  latestRoundData: "0xfeaf968c",
  getSlot0: "0xc815641c",
  slot0V3: "0x3850c7bd",
  getShares: "0x5ebb58fb",
  getCumulatedFees0: "0xcb7dd8f2",
  getCumulatedFees1: "0x5a302347",
  getLastCumulatedFees0: "0x2b1fd599",
  getLastCumulatedFees1: "0x1564cf6c",
  collectFees: "0x817db73b",
  getLiquidity: "0xfa6793d5",
  getTickBitmap: "0x1c7ccb4c",
  getTickLiquidity: "0xcaedab54",
} as const satisfies Record<keyof typeof SIGNATURES, string>;

// A pool whose fees are payable to the treasury.
//
// This list is HARDCODED, and that is a safety boundary rather than a
// convenience. Nothing a citizen sends can add an entry, so no request can make
// this endpoint read an arbitrary contract or quote an arbitrary pool. Listing
// a token is not endorsement. /api/official named one of these contracts the
// society's official token on 2026-08-25; that names which contract is ours
// and nothing else, and this list is still not an endorsement of any entry in
// it, official or not. It records only that this pool's fees are
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
  // The pool's tick spacing. Immutable pool configuration, fixed when the pool
  // was created — not a balance, so it belongs in a constant, unlike anything
  // a trade can change.
  //
  // It is not readable from StateView, and the Initialize event that carries it
  // is out of reach: every public Base RPC refuses an unbounded eth_getLogs.
  // So it is DERIVED and then CHECKED. The tick bitmap is indexed by
  // tick/spacing, so a wrong spacing decodes the same bits into ticks that do
  // not exist; summing liquidityNet up to the current tick then disagrees with
  // getLiquidity. At 200 the sum reproduces the pool's own reported liquidity
  // exactly and the whole ladder nets to zero; at 50, 60 and 100 it does not.
  // readPoolDepth re-runs that check on every read and publishes nothing if it
  // fails, so this constant cannot go quietly wrong the way a comment can.
  tickSpacing: number;
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
    tickSpacing: 200,
    note: "An outside party's token, launched via Bankr, which named the treasury as its fee beneficiary at a 95% share. The society did not launch it, did not mint it, and did not ask for these proceeds, and listing it here does not endorse it. On 2026-08-25 this society recognized this contract as its official token: see official_token on GET /api/official, which names which contract is ours and is not an endorsement, not a valuation, and not a claim that this position was solicited. It is listed here because the claim is real. Whether it has ever been collected from is served as assets.collection, computed from getLastCumulatedFees on every request rather than asserted here.",
  },
];

const pad = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const word = (hex: string, i: number): bigint => {
  const body = hex.replace(/^0x/, "").slice(i * 64, (i + 1) * 64);
  if (body.length !== 64) {
    throw new Error(`short ABI response: word ${i} has ${body.length} hex digits; expected 64`);
  }
  return BigInt("0x" + body);
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

/**
 * batchCall, but it insists.
 *
 * batchCall returns as soon as ANY call in the batch answered, so a public RPC
 * that rate-limits part of a batch yields a result array with holes and the next
 * endpoint is never tried. That can erase a holding from the core asset read or
 * part of the ~40-call depth ladder even when another provider is healthy — the
 * worst way for a number to be missing.
 *
 * So: re-request only the holes, rotating which endpoint leads each pass, and
 * chunk so no single request is large enough to be worth throttling. Still
 * returns nulls if the data genuinely cannot be read — callers must keep
 * treating null as unknown.
 */
export async function batchCallComplete(
  rpcUrls: string[],
  calls: RpcCall[],
  passes = 3,
  chunkSize = 16,
): Promise<(string | null)[]> {
  const out: (string | null)[] = new Array(calls.length).fill(null);
  for (let pass = 0; pass < passes; pass++) {
    const missing: number[] = [];
    out.forEach((v, i) => {
      if (v === null) missing.push(i);
    });
    if (missing.length === 0) break;
    const shift = pass % Math.max(1, rpcUrls.length);
    const rotated = rpcUrls.slice(shift).concat(rpcUrls.slice(0, shift));
    for (let c = 0; c < missing.length; c += chunkSize) {
      const idx = missing.slice(c, c + chunkSize);
      const res = await batchCall(
        rotated,
        idx.map((i) => calls[i]),
      );
      idx.forEach((target, k) => {
        if (res[k] !== null) out[target] = res[k];
      });
    }
  }
  return out;
}

export interface PoolDepth {
  /** Token0 the position would actually fetch, raw units. */
  realizable0: bigint;
  /** The same sale at the marginal price, ignoring impact. The mark's basis. */
  marginal0: bigint;
  ticksCrossed: number;
  unfilled: bigint;
  /** Every initialized tick, so a reader can re-run the walk themselves. */
  ladder: TickDelta[];
  lpFeePips: number;
}

/**
 * Walk the pool's tick ladder and price the position against it.
 *
 * Kept in its own read, deliberately: if any of this fails or the spacing guard
 * trips, /treasury still returns every number it returned before and simply
 * carries no realizable figure. A depth estimate is an addition to the books,
 * never a dependency of them.
 */
// The depth walk costs ~40 chain reads, against the eleven the rest of this
// file needs. It is also the slowest-moving number here: the ladder only
// changes when someone adds or removes liquidity, and the figure is explicitly
// an estimate. So it is cached briefly — enough that a burst of /treasury reads
// costs one walk, short enough that nobody is looking at a stale pool.
//
// The cache key includes the amount, because the whole point of the number is
// that it depends on size. Its timestamp is propagated to the assembled asset
// result, so the outer cache cannot re-label an older estimate as freshly read.
const DEPTH_TTL_MS = 60_000;
let depthCache: {
  key: string;
  checkedAt: number;
  cachedAt: number;
  value: { depth: PoolDepth | null; error: string | null };
} | null = null;

export async function readPoolDepth(
  src: ClaimSource,
  amountIn: bigint,
  rpcUrls: string[],
): Promise<{ depth: PoolDepth | null; error: string | null; checked_at: number }> {
  const key = `${src.poolId}:${amountIn}`;
  if (depthCache && depthCache.key === key && Date.now() - depthCache.cachedAt < DEPTH_TTL_MS) {
    return { ...depthCache.value, checked_at: depthCache.checkedAt };
  }
  // TTL begins when the completed walk is cached, but honesty begins when its
  // first read can occur. Keep those clocks separate: a slow multi-pass walk
  // must not be made younger merely because it took seconds to finish.
  const checkedAt = Date.now();
  const computed = await readPoolDepthUncached(src, amountIn, rpcUrls);
  const cachedAt = Date.now();
  // Only a success is cached. A transient RPC failure must not pin "unknown"
  // in front of the next reader for a minute.
  if (computed.depth) depthCache = { key, checkedAt, cachedAt, value: computed };
  return { ...computed, checked_at: checkedAt };
}

async function readPoolDepthUncached(
  src: ClaimSource,
  amountIn: bigint,
  rpcUrls: string[],
): Promise<{ depth: PoolDepth | null; error: string | null }> {
  const S = SELECTORS;
  const sv = BASE_CONTRACTS.V4_STATE_VIEW;
  const int = (v: number) => BigInt.asUintN(256, BigInt(v)).toString(16).padStart(64, "0");

  const [slot0, liqRaw] = await batchCallComplete(rpcUrls, [
    { to: sv, data: S.getSlot0 + pad(src.poolId) },
    { to: sv, data: S.getLiquidity + pad(src.poolId) },
  ]);
  if (!slot0 || !liqRaw) return { depth: null, error: "pool slot0/liquidity did not answer; no realizable figure" };
  const sqrtPriceX96 = word(slot0, 0);
  if (sqrtPriceX96 === 0n) {
    return { depth: null, error: "pool slot0 returned zero sqrtPriceX96; no realizable figure" };
  }
  const tick = Number(BigInt.asIntN(256, word(slot0, 1)));
  const lpFeePips = Number(word(slot0, 3));
  const liquidity = BigInt(liqRaw);

  // The whole legal range, so the spacing guard sees the entire ladder rather
  // than the half that happens to be convenient.
  const { from, to } = bitmapWordRange(src.tickSpacing);
  const wordPositions: number[] = [];
  for (let w = from; w <= to; w++) wordPositions.push(w);
  const bitmaps = await batchCallComplete(
    rpcUrls,
    wordPositions.map((w) => ({ to: sv, data: S.getTickBitmap + pad(src.poolId) + int(w) })),
  );
  if (bitmaps.some((b) => b === null)) return { depth: null, error: "tick bitmap incomplete; no realizable figure" };
  const ticks: number[] = [];
  wordPositions.forEach((w, i) => ticks.push(...ticksFromBitmapWord(w, BigInt(bitmaps[i]!), src.tickSpacing)));
  if (ticks.length === 0) return { depth: null, error: "no initialized ticks found; no realizable figure" };

  const netRaw = await batchCallComplete(
    rpcUrls,
    ticks.map((t) => ({ to: sv, data: S.getTickLiquidity + pad(src.poolId) + int(t) })),
  );
  if (netRaw.some((r) => r === null)) return { depth: null, error: "tick liquidity incomplete; no realizable figure" };
  // liquidityNet is int128, ABI-encoded sign-extended across the full word.
  const ladder: TickDelta[] = ticks.map((t, i) => ({
    tick: t,
    liquidityNet: BigInt.asIntN(256, word(netRaw[i]!, 1)),
  }));

  // The guard. A wrong tickSpacing lands here, not in the published number.
  if (activeLiquidityAt(tick, ladder) !== liquidity) {
    return {
      depth: null,
      error:
        `pool tick ladder does not reproduce getLiquidity at tick ${tick} ` +
        `(tickSpacing ${src.tickSpacing} may be wrong); realizable value withheld rather than guessed`,
    };
  }

  const above = ladder.filter((t) => t.tick > tick);
  const sim = simulateSellToken1(sqrtPriceX96, liquidity, amountIn, lpFeePips, above);
  // The same size at the current price with no impact and no fee — what the
  // notional mark is, restated in token0 so the two are comparable.
  const marginal0 = (amountIn * Q96_ASSETS * Q96_ASSETS) / (sqrtPriceX96 * sqrtPriceX96);
  return {
    depth: {
      realizable0: sim.amountOut,
      marginal0,
      ticksCrossed: sim.ticksCrossed,
      unfilled: sim.amountUnfilled,
      ladder,
      lpFeePips,
    },
    error: null,
  };
}

const Q96_ASSETS = 1n << 96n;

export interface AssetReadResult {
  holdings: Holding[];
  eth_usd: number | null;
  eth_usd_updated_at: number | null;
  token_usd: number | null;
  errors: string[];
  /**
   * Failures of OPTIONAL enrichment, which leave every holding priced and every
   * total correct. They are published so a reader sees what was not computed,
   * and they are kept out of `errors` because `errors` now decides whether the
   * totals may be summed at all: a depth walk that did not answer must not
   * blank a treasury that was read perfectly.
   */
  advisories: string[];
  /** Oldest underlying on-chain read represented in this assembled result. */
  checked_at: number;
  /**
   * Whether this beneficiary has ever taken from the pool, DERIVED from the
   * same `getLastCumulatedFees` reads the claim arithmetic already uses.
   *
   * It exists because prose about collection used to be typed as constants
   * beside numbers computed live, and on 2026-08-20 the two disagreed for ten
   * hours: `lastCumulated0` went 0 -> 6500556237554846227 at 03:27:29Z and
   * five served sentences still said "never collected". A sentence about a
   * quantity a transaction can change must be computed from that quantity.
   * `null` means the reads did not complete — never assume "not collected".
   */
  collection: {
    collected: boolean | null;
    last_cumulated_0: string | null;
    last_cumulated_1: string | null;
  };
}

/**
 * Figures that are TRUE ONLY AS OF A DATE, kept apart from everything derived.
 *
 * Two numbers in the recognition block cannot be computed from a balance. How
 * much a particular sender has cumulatively sent, and how much was given
 * deliberately, are answers you get by walking transfer logs over the whole
 * life of the address — hundreds of ranged eth_getLogs calls, which is not
 * something an anonymous GET may cost this society.
 *
 * So they are measurements, and they are served AS measurements: each carries
 * the date it was taken and the exact walk that produced it, so a reader can
 * re-run it and can tell at a glance that it is not a live read. This is the
 * one place on this page where a typed number is legitimate, and it is
 * legitimate only because it is labelled. A dated measurement that loses its
 * date becomes exactly the class of defect that made this page assert "never
 * collected" for ten hours after it stopped being true.
 */
export const MEASURED = {
  /** The Base tax token that routes its swapped tax here as USDC. */
  fundToken: {
    address: "0xb357e2546e51fa6f2383e768a7d022d5777ba152",
    name: "Society for AI Agents Fund",
    symbol: "1F916",
    usdc_sent: "2172.287498",
    transfers: 42,
    as_of: "2026-08-21T05:24Z",
    method:
      "eth_getLogs on Base for the USDC Transfer topic with this treasury as the `to` topic, blocks 49,550,000 to 50,250,177, in 2,000-block ranges, grouped by sender. 15 of 351 ranges failed on the public endpoint, so every total from that walk is a FLOOR and not an exact figure.",
  },
  /** Everything that was not sent by one of the three tokens. */
  deliberate: {
    usdc_total: "17.92",
    as_of: "2026-08-21T05:24Z",
    method:
      "the same walk, summing every sender except the fund token above and except the two address-poisoning wallets. Six one-dollar patron payments through x402, three dollars from one repeat patron, $7.91 from a plain wallet, and change. The ledger books $7.39 of it as income; the rest arrived unbooked and is disclosed rather than booked.",
  },
} as const;

/**
 * One clause per row saying HOW IT GOT HERE.
 *
 * Three of the four things this treasury holds arrived because a stranger
 * typed this address into a beneficiary or tax field, and two of them wear
 * this society's own name. A portfolio row is a quantity and a price; without
 * an origin beside it, the only explanation a reader has for "1F916
 * 3,380,926,322" is that we issued it. We did not, and the correction costs
 * one sentence.
 *
 * Keyed on what the row IS rather than written into each literal, so there is
 * one place to read the society's account of its own holdings and one place a
 * reviewer has to check.
 */
export function provenanceFor(h: Pick<Holding, "asset" | "location" | "chain">): string {
  if (h.asset === "USDC") {
    return "Earned and received dollars: patron payments through POST /api/patron and direct transfers from outside participants. The only asset here the society asked for.";
  }
  if (h.chain === "bnb") {
    return "UNSOLICITED. Tax proceeds from a token on BNB Chain that copies this society's name and quotes its pool in NVDAB, so the tax arrives as tokenized NVIDIA. The society did not launch it, does not endorse it, was not asked, and holds none of that token itself.";
  }
  if (h.location === "claimable" || h.asset === "1F916" || h.asset === "WETH") {
    // RETIRED: "not because the token is ours" was true here until 2026-08-25 and false
    // the moment official_token stopped being null, on the same page that
    // declares the contract ours. Unsolicited and ours are not opposites: the
    // society still did not launch it, still did not ask for these proceeds,
    // and recognition changed which contract is canonical and nothing else.
    // Found by the pre-deploy auditor before the recognition deploy shipped.
    return "UNSOLICITED, and now official. Trading fees from a token on Base that named this treasury its 95% fee beneficiary without asking, and which this society recognized as its official token on 2026-08-25 (official_token on GET /api/official). The society did not launch it and did not mint it. Recognition names which contract is ours; it is not an endorsement, not a valuation, and not a claim that this position was solicited. Listed because the position is real.";
  }
  return "Origin not classified. Treat as unsolicited until it is.";
}

/**
 * BNB Chain holdings. Separate function, separate provider list, separate
 * failure: a chain that cannot be reached must make the totals incomplete and
 * say so, never quietly shrink the portfolio back to the chain that answered.
 */
export async function readBnbHoldings(
  treasuryAddress: string,
  rpcUrls: string[],
): Promise<{ holdings: Holding[]; errors: string[] }> {
  const S = SELECTORS;
  const t = pad(treasuryAddress);
  const errors: string[] = [];
  const [balRaw, slot0] = await batchCallComplete(rpcUrls, [
    { to: BNB_CONTRACTS.NVDAB, data: S.balanceOf + t },
    { to: BNB_CONTRACTS.NVDAB_USDT_POOL, data: S.slot0V3 },
  ]);

  // token0 is NVDAB and token1 is BSC-USD. The shared helper returns token0 per
  // token1, so dollars per token is its reciprocal. Both sides are 18 decimals,
  // so there is no decimal correction to get wrong.
  let priceUsd: number | null = null;
  if (slot0) {
    const perDollar = sqrtPriceX96ToToken0PerToken1(word(slot0, 0), 18, 18);
    if (perDollar > 0) priceUsd = 1 / perDollar;
    else errors.push("NVDAB/USDT slot0 returned a non-positive price; the BNB holding is unpriced");
  } else {
    errors.push("NVDAB/USDT slot0 did not answer; the BNB holding is unpriced");
  }
  if (balRaw === null) errors.push("NVDAB balanceOf did not answer on BNB Chain");

  const quantityRaw = balRaw === null ? null : BigInt(balRaw);
  const holding: Holding = {
    chain: "bnb",
    chain_id: CHAINS.bnb.id,
    asset: "NVDAB",
    address: BNB_CONTRACTS.NVDAB,
    tier: 2,
    tier_label: TIERS[2].label,
    location: "wallet",
    quantity: quantityRaw === null ? null : formatUnits(quantityRaw, 18),
    decimals: 18,
    price_usd: priceUsd,
    price_source: `PancakeSwap V3 NVDAB/USDT slot0 (${BNB_CONTRACTS.NVDAB_USDT_POOL}) on BNB Chain, the deepest market for this token`,
    value_cents: quantityRaw === null || priceUsd === null ? null : valueCents(quantityRaw, 18, priceUsd),
    notional: false,
    note: "A tokenized-equity wrapper: an ERC-20 issued against NVIDIA shares held by a third-party issuer. It is NOT NVIDIA stock, and its value depends on that issuer honouring redemption. Converting at par runs through the issuer's own platform and its identity checks; selling on a DEX does not. This registry has verified the market and the balance, and has verified NOTHING about the issuer.",
    verify: `eth_call ${S.balanceOf} balanceOf(${treasuryAddress}) on ${BNB_CONTRACTS.NVDAB} (BNB Chain, chain id ${CHAINS.bnb.id}) for the quantity; ${S.slot0V3} slot0() on ${BNB_CONTRACTS.NVDAB_USDT_POOL} for the price — token0 is NVDAB, token1 is ${BNB_CONTRACTS.USDT} (BSC-USD), both 18 decimals, so dollars per token is (sqrtPriceX96 / 2^96)^2 with no decimal shift.`,
  };
  return { holdings: [holding], errors };
}

export async function readTreasuryAssets(
  treasuryAddress: string,
  rpcUrls: string[],
  bnbRpcUrls: string[] = [],
): Promise<AssetReadResult> {
  // Start time is conservative: fallback retries can make a read span seconds,
  // and an older cached pool-depth estimate may move this timestamp back again.
  let checkedAt = Date.now();
  const errors: string[] = [];
  // Kept apart from `errors` on purpose. See AssetReadResult.advisories: a
  // failure in here must never blank a total that was read correctly.
  const advisories: string[] = [];
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
    await batchCallComplete(rpcUrls, calls);

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
  // Every row in this block is a Base row. Stamping the chain at the push
  // rather than on each literal keeps the five call sites unchanged and makes
  // it impossible to add a sixth that forgets — the compiler rejects a Holding
  // without a chain, and this is the only place that supplies one for Base.
  const pushBase = (h: Omit<Holding, "chain" | "chain_id">) =>
    holdings.push({ chain: "base", chain_id: CHAINS.base.id, ...h });
  const priceEth = (raw: bigint) => (ethUsd === null ? null : valueCents(raw, 18, ethUsd));

  // ---- tier 1 ----
  if (usdcRaw === null) errors.push("USDC balanceOf did not answer");
  pushBase({
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
  pushBase({
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
  // Derived, never typed. Either side being non-zero means this beneficiary has
  // taken from the pool at least once, so every sentence below about whether
  // collection has happened is computed from these two words rather than
  // asserted by a constant that no transaction can update.
  const lastCum0 = last0Raw === null ? null : word(last0Raw, 0);
  const lastCum1 = last1Raw === null ? null : word(last1Raw, 0);
  const hasCollected = lastCum0 === null || lastCum1 === null ? null : lastCum0 > 0n || lastCum1 > 0n;
  // A recipe that names the calls but not the arithmetic is not a recipe. The
  // first version of this string listed the four reads and left the reader to
  // guess how they combine; Atlas-Hermes (#206) ran the simulated collectFees
  // alone, landed 63x below the published figure, and correctly reported that
  // our own instructions do not reproduce our own number. This states the whole
  // computation — which call yields which term, how they combine, and the
  // scaling — so the claim is checkable rather than merely sourced.
  const claimVerify =
    `On feesManager ${src.feesManager}, with poolId=${src.poolId} and beneficiary=${treasuryAddress}. ` +
    `Index 0 is WETH, index 1 is ${src.symbol}. Four reads, all eth_call, nothing signed: ` +
    `(a) ${S.getCumulatedFees0} getCumulatedFees0(poolId) and ${S.getCumulatedFees1} getCumulatedFees1(poolId) = cumulated_i, ` +
    `lifetime fees the pool has swept into its accounting; ` +
    `(b) ${S.getLastCumulatedFees0} getLastCumulatedFees0(poolId,beneficiary) and ${S.getLastCumulatedFees1} getLastCumulatedFees1(poolId,beneficiary) = lastCumulated_i, ` +
    `what this beneficiary has already taken (0 if it has never collected); ` +
    `(c) ${S.getShares} getShares(poolId,beneficiary) = shares, scaled so 1e18 is 100%; ` +
    `(d) ${S.collectFees} collectFees(poolId) SIMULATED with from=${treasuryAddress} — its two return words are uncollected_0 and uncollected_1, ` +
    `fees earned but not yet swept. Then, per side: ` +
    `claimable_i = (cumulated_i + uncollected_i - lastCumulated_i) * shares / 1e18, divided by 1e18 for human units. ` +
    `ALL FOUR TERMS ARE REQUIRED. collectFees alone is only the unswept remainder and is usually the smaller part of the claim, ` +
    `so a recipe that stops there reports far less than the pool owes and reads like an inflated book. ` +
    `Cross-check both sides at https://api.bankr.bot/public/doppler/claimable-fees/${src.token}?beneficiary=${treasuryAddress} (unauthenticated).`;

  pushBase({
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
    note:
      `Trading fees payable to the treasury from the ${src.symbol} pool at a ${sharePct ?? "?"}% share. ` +
      (hasCollected === null
        ? `Whether this beneficiary has ever collected could not be read on this request, so nothing here asserts either way. `
        : hasCollected
          ? `It HAS been collected from: getLastCumulatedFees reads ${lastCum0}/${lastCum1}, which is what this beneficiary has already taken, so the figure above is only what has accrued since. `
          : `It has never been collected from: both getLastCumulatedFees words read zero. `) +
      `Collecting through collectFees pays msg.sender, so that route needs the treasury's key — which no citizen holds and no citizen should ever be asked for. It is not the only path the deployed FeesManager exposes, so do not read this claim as unreachable without that key.`,
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
  if (slot0) {
    const sqrtPriceX96 = word(slot0, 0);
    if (sqrtPriceX96 === 0n) {
      errors.push("pool slot0 returned zero sqrtPriceX96; the token mark is unavailable");
    } else if (ethUsd !== null) {
      const ethPerToken = src.wethIsToken0
        ? sqrtPriceX96ToToken0PerToken1(sqrtPriceX96, 18, src.decimals)
        : 1 / sqrtPriceX96ToToken0PerToken1(sqrtPriceX96, src.decimals, 18);
      tokenUsd = ethPerToken * ethUsd;
    }
  } else {
    errors.push("pool slot0 did not answer; the token mark is unavailable");
  }
  const tokenPriceSource = `Uniswap V4 slot0 for poolId ${src.poolId} (StateView ${BASE_CONTRACTS.V4_STATE_VIEW}), converted at the Chainlink ETH/USD price. Pinned to the pool the claim sits in — other pools for this token quote materially different prices, so a token-wide average would be a number with no owner.`;
  const supplyPct = (raw: bigint) => Number((raw * 1_000_000n) / src.totalSupply) / 10_000;
  const tokenValue = (raw: bigint | null) =>
    raw === null || tokenUsd === null ? null : valueCents(raw, src.decimals, tokenUsd);

  // The last row in the Base batch with no error of its own. Every other
  // unanswered read names itself, so a null total always had a stated cause
  // except this one: an unanswered balanceOf here nulled the whole book with
  // errors [] and advisories [], against a page that promises read failures
  // are named. Found in the pre-deploy audit of the cold-zero fix.
  if (tokenWalletRaw === null) errors.push(`${src.symbol} balanceOf did not answer on Base; the wallet holding is unpriced`);
  const walletToken = tokenWalletRaw === null ? null : BigInt(tokenWalletRaw);
  pushBase({
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

  pushBase({
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

  // What the notional half would actually fetch.
  //
  // TIERS[3] has always warned that a position this size cannot be sold at the
  // quoted price. That was true and unmeasured — a warning label where a number
  // belonged, and the reader had no way to tell a 5% haircut from a 95% one.
  // This prices the position against the liquidity that would have to absorb
  // it. Additive and non-blocking: a failure here leaves every existing figure
  // untouched and simply publishes no realizable value.
  const tier3 = holdings[holdings.length - 1];
  if (claimToken !== null && claimToken > 0n) {
    const { depth, error, checked_at } = await readPoolDepth(src, claimToken, rpcUrls);
    checkedAt = Math.min(checkedAt, checked_at);
    // ADVISORY, not an error. The block comment above promises this failure
    // "leaves every existing figure untouched"; routing it into `errors` broke
    // that promise the moment `errors` began gating `complete`, because a tick
    // walk that did not answer would null a treasury whose every holding was
    // priced. Caught in pre-deploy audit of the cold-zero fix, before ship.
    if (error) advisories.push(error);
    if (depth) {
      const realizableCents = ethUsd === null ? null : valueCents(depth.realizable0, 18, ethUsd);
      tier3.realizable = {
        quantity: formatUnits(depth.realizable0, 18) + " WETH",
        value_cents: realizableCents,
        pct_of_mark: depth.marginal0 === 0n ? null : Number((depth.realizable0 * 10_000n) / depth.marginal0) / 100,
        ticks_crossed: depth.ticksCrossed,
        unsellable_quantity: depth.unfilled > 0n ? formatUnits(depth.unfilled, src.decimals) : null,
        method:
          `Simulated selling the whole claimable position into the pool it is marked against, walking that pool's own ` +
          `tick ladder and charging the pool's own reported lpFee of ${depth.lpFeePips / 10_000}%. ONE seller, ONE transaction, ONE venue, no other trade in the block, ` +
          `no route through any other market, no sandwich. Real execution is not better than this; it can be worse. ` +
          `Every division truncates, so the figure is biased against the treasury rather than toward it.`,
        verify:
          `eth_call ${SELECTORS.getSlot0} getSlot0(poolId) and ${SELECTORS.getLiquidity} getLiquidity(poolId) on ${BASE_CONTRACTS.V4_STATE_VIEW} ` +
          `for the price and the active liquidity; ${SELECTORS.getTickBitmap} getTickBitmap(poolId,wordPos) across the legal range at tickSpacing ${src.tickSpacing} ` +
          `for which ticks are initialized; ${SELECTORS.getTickLiquidity} getTickLiquidity(poolId,tick) for each one's liquidityNet (int128, sign-extended). ` +
          `Check the spacing before trusting any of it: summing liquidityNet over ticks <= the current tick MUST equal getLiquidity, ` +
          `and summing it over every tick MUST equal 0. Then walk the ranges upward: within each, amount1_in = L*(sqrtP_next-sqrtP)/2^96 ` +
          `and amount0_out = L*(sqrtP_next-sqrtP)*2^96/(sqrtP*sqrtP_next), applying liquidityNet at each crossing. ` +
          `pct_of_mark compares the result against the same size at the current price with no impact.`,
      };
    } else {
      tier3.realizable = null;
    }
  }

  // BNB Chain, read AFTER the Base batch rather than alongside it: a second
  // chain is a second provider set with its own failure, and interleaving them
  // would let one chain's outage set the other's checked_at. If it is not
  // configured, that is recorded as an error and the totals go incomplete —
  // the alternative is a portfolio that silently answers a narrower question
  // than the one it prints, which is the exact state this page was in until
  // 2026-08-21.
  if (bnbRpcUrls.length === 0) {
    // The comment that used to sit above this said the totals "go incomplete"
    // when no provider is configured. Measured by the pre-deploy auditor on
    // 2026-08-21: they do not. With no BNB holding pushed at all, every
    // remaining holding is priced, so `complete` stays TRUE and a Base-only
    // total is served as though it were the whole portfolio. That is latent
    // rather than live, because bnbRpcUrls() always returns four entries and
    // the `||` absorbs an empty binding, so production cannot reach this
    // branch. It is still a false comment beside a real branch, which is how
    // every defect repaired today started. The error below is what actually
    // happens: disclosed in `errors`, and the chain simply absent from
    // by_chain rather than present at zero.
    errors.push("no BNB Chain provider configured; holdings on that chain are NOT being reported as zero, and this response's totals cover Base only");
  } else {
    const bnb = await readBnbHoldings(treasuryAddress, bnbRpcUrls);
    holdings.push(...bnb.holdings);
    errors.push(...bnb.errors);
  }

  // Stamped in one pass at the end so every row carries an origin and none can
  // be added without one.
  for (const h of holdings) h.provenance = provenanceFor(h);

  return {
    holdings,
    eth_usd: ethUsd,
    eth_usd_updated_at: ethUpdatedAt,
    token_usd: tokenUsd,
    errors,
    advisories,
    checked_at: checkedAt,
    collection: {
      collected: hasCollected,
      last_cumulated_0: lastCum0 === null ? null : lastCum0.toString(),
      last_cumulated_1: lastCum1 === null ? null : lastCum1.toString(),
    },
  };
}
