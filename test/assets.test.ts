// Tests for treasury asset valuation.
//
// Run: npm test   (needs Node >= 22.6 for --experimental-strip-types)
//
// Three things here are worth more than the arithmetic.
//
// First, claimableFromPool. The obvious implementation reads the pool's settled
// counters and subtracts, dropping the fees still sitting unswept inside the
// pool. When nothing has been swept yet that implementation returns 0 and
// reports the whole claim as nothing, which is the original /treasury bug
// wearing a different hat. The regression test for it is below.
//
// (This header used to say that both counters were zero "for the pool this
// society actually earns from". That was true when it was written and false a
// day later. Live on-chain quantities do not belong in comments — see the note
// on claimableFromPool in src/assets.ts for what it cost.)
//
// Second, the selectors. Each one used to carry its signature in a trailing
// comment, and the only test asserted it was 4-byte hex — which every wrong
// selector also is. The signatures are now data in SIGNATURES, and the test
// below recomputes all nine with keccak256. A wrong constant fails.
//
// Third, summarizeAssets must go null rather than under-report. A treasury
// that quietly reports a partial sum as the whole is the failure this file
// exists to correct.

import test from "node:test";
import assert from "node:assert/strict";
import {
  formatUnits,
  valueCents,
  sqrtPriceX96ToToken0PerToken1,
  toFixedBigInt,
  claimableFromPool,
  summarizeAssets,
  TIERS,
  CLAIM_SOURCES,
  SELECTORS,
  SIGNATURES,
  type Holding,
  type Tier,
  CHAINS,
  type ChainName,
} from "../src/assets.ts";
import { selector } from "./keccak256.ts";

// ---------- formatUnits ----------

test("formatUnits keeps precision a float would destroy", () => {
  // 2.2e27 wei. Number() cannot hold this; the low digits must survive.
  const raw = 2223696208044845123456789012345678n;
  assert.equal(formatUnits(raw, 18), "2223696208044845.123456789012345678");
});

test("formatUnits handles zero, whole numbers, and trailing zeros", () => {
  assert.equal(formatUnits(0n, 18), "0");
  assert.equal(formatUnits(5n * 10n ** 18n, 18), "5");
  assert.equal(formatUnits(1_500_000n, 6), "1.5"); // not "1.500000"
  assert.equal(formatUnits(1n, 18), "0.000000000000000001");
});

// ---------- valueCents ----------

test("valueCents survives a huge quantity at a tiny price", () => {
  // 2,112,528,711 tokens at $0.000004190248 ≈ $8,852.
  const raw = 2112528711045665000000000000n;
  const cents = valueCents(raw, 18, 4.190248e-6);
  assert.ok(Math.abs(cents - 885_201) < 200, `expected ~885201 cents, got ${cents}`);
});

test("valueCents is exact on a clean case", () => {
  assert.equal(valueCents(10n ** 18n, 18, 1912.5), 191_250);
  assert.equal(valueCents(1_939_365_760n, 6, 1), 193_936);
});

test("valueCents refuses to invent a number from bad input", () => {
  assert.equal(valueCents(10n ** 18n, 18, NaN), 0);
  assert.equal(valueCents(10n ** 18n, 18, -5), 0);
  assert.equal(valueCents(0n, 18, 1912.5), 0);
});

test("REGRESSION: scaling a price must not lose a cent to floating point", () => {
  // 1912.5 * 1e18 is 1.9125e21 — past 2^53, where doubles stop holding integers
  // exactly. The naive BigInt(Math.round(price * 1e18)) lands just below and the
  // treasury under-reports by a cent. Caught by the exact-value test above.
  assert.equal(toFixedBigInt(1912.5, 18), 1912500000000000000000n);
  assert.notEqual(toFixedBigInt(1912.5, 18), BigInt(Math.round(1912.5 * 1e18)));
  // Tiny prices survive the same path.
  assert.equal(toFixedBigInt(4.190248e-6, 18), 4190248000000n);
  // Absurd magnitudes are refused rather than parsed out of exponential form.
  assert.equal(toFixedBigInt(1e21, 18), 0n);
});

// ---------- pool spot ----------

test("sqrtPriceX96 decodes to the price the pool is actually quoting", () => {
  // Real slot0 from the 1F916/WETH pool on Base, both sides 18 decimals.
  // Independently confirmed: an aggregator quotes priceNative 0.000000002193
  // for the same pool, and this is derived only from chain state.
  const sqrtPriceX96 = 1691797845284566142213814380424393n;
  const ethPerToken = sqrtPriceX96ToToken0PerToken1(sqrtPriceX96, 18, 18);
  assert.ok(Math.abs(ethPerToken - 2.193119e-9) / 2.193119e-9 < 1e-4, `got ${ethPerToken}`);
});

test("sqrtPriceX96 of zero is zero, not NaN or Infinity", () => {
  assert.equal(sqrtPriceX96ToToken0PerToken1(0n, 18, 18), 0);
});

// ---------- the claim ----------

test("REGRESSION: uncollected-in-pool fees are part of the claim", () => {
  // The exact live state of this society's pool: nothing has ever settled into
  // the manager, so both counters are zero and the whole balance is uncollected.
  // An implementation that reads only the settled counters returns 0 here and
  // reports a five-figure claim as nothing.
  const cumulated = 0n;
  const lastCumulated = 0n;
  const uncollected = 4554926674487067118n; // 4.5549 WETH
  const shares = 950000000000000000n; // 95%
  const claim = claimableFromPool(cumulated, uncollected, lastCumulated, shares);
  assert.notEqual(claim, 0n, "dropping the uncollected term reports the whole claim as zero");
  assert.equal(formatUnits(claim, 18), "4.327180340762713762");
});

test("already-collected fees are not claimable twice", () => {
  // A beneficiary who has collected everything has lastCumulated == cumulated.
  const claim = claimableFromPool(10n ** 18n, 0n, 10n ** 18n, 950000000000000000n);
  assert.equal(claim, 0n);
});

test("a beneficiary ahead of the counters claims zero, never negative", () => {
  // Defensive: BigInt subtraction would go negative and a negative claim would
  // silently reduce the treasury total.
  const claim = claimableFromPool(0n, 0n, 5n * 10n ** 18n, 950000000000000000n);
  assert.equal(claim, 0n);
});

test("the share is applied, not assumed to be all of it", () => {
  const full = claimableFromPool(0n, 10n ** 18n, 0n, 10n ** 18n); // 100%
  const most = claimableFromPool(0n, 10n ** 18n, 0n, 950000000000000000n); // 95%
  assert.equal(formatUnits(full, 18), "1");
  assert.equal(formatUnits(most, 18), "0.95");
});

// ---------- summary ----------

const holding = (
  tier: Tier,
  location: "wallet" | "claimable",
  cents: number | null,
  notional = false,
  chain: ChainName = "base",
): Holding => ({
  chain,
  chain_id: CHAINS[chain].id,
  asset: "X",
  address: "0x",
  tier,
  tier_label: TIERS[tier].label,
  location,
  quantity: "1",
  decimals: 18,
  price_usd: 1,
  price_source: "test",
  value_cents: cents,
  notional,
  verify: "test",
});

test("one true total exists, and the tier split exists beside it", () => {
  const s = summarizeAssets([
    holding(1, "wallet", 193_936),
    holding(2, "claimable", 827_583),
    holding(3, "claimable", 885_201, true),
  ]);
  assert.equal(s.total_cents, 1_906_720);
  assert.equal(s.conservative_total_cents, 1_021_519); // tiers 1+2
  assert.deepEqual(
    s.by_tier.map((t) => t.cents),
    [193_936, 827_583, 885_201],
  );
  assert.equal(s.by_tier[2].notional, true);
  assert.equal(s.by_tier[0].notional, false);
});

test("location splits custody, independently of tier", () => {
  const s = summarizeAssets([
    holding(1, "wallet", 193_936),
    holding(2, "claimable", 827_583),
    holding(3, "claimable", 885_201, true),
  ]);
  assert.equal(s.by_location.wallet_cents, 193_936);
  assert.equal(s.by_location.claimable_cents, 1_712_784);
});

test("an unreadable holding nulls the totals instead of under-reporting", () => {
  // The whole point. A partial sum presented as the total is how a treasury
  // lies without anyone writing a false number.
  const s = summarizeAssets([holding(1, "wallet", 193_936), holding(2, "claimable", null)]);
  assert.equal(s.complete, false);
  assert.equal(s.total_cents, null);
  assert.equal(s.conservative_total_cents, null);
  assert.deepEqual(
    s.by_tier.map((tier) => tier.cents),
    [null, null, null],
    "a tier subtotal must not turn an unknown holding into a confident zero",
  );
  assert.equal(s.by_location.wallet_cents, null);
  // The per-holding rows still come back, so a reader can see WHAT is missing.
  assert.equal(s.holdings.length, 2);
});

test("no holdings is complete and zero, not incomplete", () => {
  const s = summarizeAssets([]);
  assert.equal(s.complete, true);
  assert.equal(s.total_cents, 0);
  assert.deepEqual(s.by_tier.map((tier) => tier.cents), [0, 0, 0]);
});

// The empty array is the shape of TWO different facts: a portfolio with nothing
// in it, and a read that came back with nothing. The test above pins the first.
// This one pins the second, because for a week they were the same answer and
// the second one published a confident $0.00 over a real balance.
//
// KILLING MUTATION: drop `readOk &&` from summarizeAssets and this goes red on
// the first assertion, because holdings.every is vacuously true on [].
test("a failed read is incomplete and nulls the totals, even with no holdings", () => {
  const s = summarizeAssets([], false);
  assert.equal(s.complete, false);
  assert.equal(s.total_cents, null);
  assert.equal(s.conservative_total_cents, null);
  assert.deepEqual(s.by_tier.map((tier) => tier.cents), [null, null, null]);
  assert.equal(s.by_location.wallet_cents, null);
  assert.equal(s.by_location.claimable_cents, null);
});

// A failed read does not become complete by having priced holdings in it: a
// partial read is still a read that did not finish, and summing what arrived
// is exactly the under-reporting this file exists to refuse.
//
// KILLING MUTATION: same one. Without `readOk &&` this reports complete:true
// and a total that omits whatever the failed leg would have added.
test("a partial read does not pass as complete just because what arrived was priced", () => {
  const s = summarizeAssets([holding(1, "wallet", 193_936)], false);
  assert.equal(s.complete, false);
  assert.equal(s.total_cents, null);
});

// ---------- the allowlist ----------

test("claim sources are a hardcoded allowlist, and tier 3 is marked speculative", () => {
  // Nothing a citizen sends may add a source; that is what stops this endpoint
  // from being pointed at an arbitrary contract or pool.
  assert.ok(CLAIM_SOURCES.length > 0);
  for (const s of CLAIM_SOURCES) {
    assert.match(s.token, /^0x[0-9a-fA-F]{40}$/);
    assert.match(s.poolId, /^0x[0-9a-fA-F]{64}$/);
    assert.match(s.feesManager, /^0x[0-9a-fA-F]{40}$/);
    assert.equal(s.tier, 3);
    assert.ok(s.totalSupply > 0n);
    // The note must disclaim endorsement — post #105 exists for a reason.
    assert.match(s.note, /does not endorse/i);
  }
});

test("every selector is a 4-byte hex string", () => {
  for (const [name, sel] of Object.entries(SELECTORS)) {
    assert.match(sel, /^0x[0-9a-f]{8}$/, `${name} is not a 4-byte selector`);
  }
});

test("every selector IS the signature it claims to be", () => {
  // The test the shape check could not do. Every wrong 4-byte constant passes
  // the assertion above; none passes this one.
  for (const [name, signature] of Object.entries(SIGNATURES)) {
    const expected = selector(signature);
    const actual = SELECTORS[name as keyof typeof SELECTORS];
    assert.equal(actual, expected, `SELECTORS.${name} is ${actual}, but keccak256("${signature}") gives ${expected}`);
  }
});

test("no selector is documented without a signature, and none is signed without a selector", () => {
  // A name in one object and not the other is how a call quietly loses its
  // proof: the keccak test above only covers keys that appear in SIGNATURES.
  assert.deepEqual(Object.keys(SELECTORS).sort(), Object.keys(SIGNATURES).sort());
});

test("the claimable formula is the one the published verify string describes", () => {
  // Pinned against a real read of the live pool on 2026-08-09, kept as fixed
  // numbers so this is a test and not a network call. Reproduced independently
  // by the unauthenticated Bankr endpoint the verify string cites, which
  // returned 5.605600 WETH for the same block-ish moment.
  const shares = 950000000000000000n; // 95%
  const cumulated0 = 5004121043625882749n;
  const uncollected0 = 896510738666619624n;
  const lastCumulated0 = 0n;
  const claim = claimableFromPool(cumulated0, uncollected0, lastCumulated0, shares);
  assert.equal(formatUnits(claim, 18), "5.605600193177877254");

  // And the reading that dropped the cumulated term — the one the old verify
  // string invited — is an order of magnitude out. This is the regression that
  // matters: not that the number is wrong, but that the recipe produced a
  // different one.
  const uncollectedOnly = claimableFromPool(0n, uncollected0, lastCumulated0, shares);
  assert.equal(formatUnits(uncollectedOnly, 18), "0.851685201733288642");
  assert.ok(claim / uncollectedOnly >= 6n, "the omitted term dominates; a recipe that drops it is not a recipe");
});

test("tier 3 is documented as notional, not as a price you could get", () => {
  assert.match(TIERS[3].note, /NOTIONAL/);
  assert.match(TIERS[1].note, /face value|peg/i);
});


// A treasury address exists on every EVM chain at once. Until 2026-08-21 this
// rollup could only answer for Base, and $1,056 of NVDAB on BNB Chain was
// invisible on a page calling itself the society's public books. by_chain is
// derived from the holdings PRESENT, never from the CHAINS table, so a chain
// the read could not reach is absent rather than reported at zero.
test("by_chain splits the portfolio by ledger, and never invents a chain at zero", () => {
  const s = summarizeAssets([
    holding(1, "wallet", 218_873),
    holding(2, "wallet", 1_452_763),
    holding(2, "wallet", 105_684, false, "bnb"),
  ]);
  assert.deepEqual(
    s.by_chain.map((c) => [c.chain, c.chain_id, c.cents]),
    [
      ["base", 8453, 1_671_636],
      ["bnb", 56, 105_684],
    ],
  );
  const baseOnly = summarizeAssets([holding(1, "wallet", 218_873)]);
  assert.deepEqual(
    baseOnly.by_chain.map((c) => c.chain),
    ["base"],
    "a chain with no holdings read must be ABSENT, not present at zero: zero is a claim",
  );
});
