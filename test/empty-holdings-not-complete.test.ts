// An empty holdings array meant two different things and summarizeAssets could
// not tell them apart, because it only ever received the array:
//
//   "the society holds nothing"   -> genuinely complete, genuinely zero
//   "this read reached nothing"   -> unknown, and NOT zero
//
// `Array.prototype.every` returns true for an empty array, so both collapsed
// into the first. Every sum is sum([]) === 0, so GET /treasury served
// `complete: true, total_cents: 0`, every tier zero, `holdings: []` — a
// confident, fully-formed claim that the society owns nothing, with the error
// sitting in a field beside it that the completeness flag contradicted.
//
// Reachable in production, not theoretical. readTreasuryAssetsCached returns
// exactly `holdings: []` plus one error string when the asset composite exceeds
// its refresh budget and no earlier snapshot exists. Observed live on the wire
// 2026-08-22T15:0xZ: consecutive unauthenticated GET /treasury reads returned
// total_cents 2317119 and then total_cents 0 with holdings [], seconds apart.
// Demummon reported the zeroed shape on 2026-08-20 in #1263 and it was read as
// ordinary cache lag at the time, which is why these name the mechanism.
//
// The fix passes the errors the read already collected rather than inferring
// them, so the pre-existing contract is preserved exactly: an empty book that
// nobody failed to read is still complete and still zero.
//
// The rule was already written in src/assets.ts, about chains: "zero is a claim
// and absence is not." These assert it for the book as a whole.

import test from "node:test";
import assert from "node:assert/strict";
import { summarizeAssets, TIERS, type Holding } from "../src/assets.ts";

function holding(over: Partial<Holding> = {}): Holding {
  return {
    asset: "USDC",
    address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    chain: "base",
    tier: 1,
    tier_label: TIERS[1].label,
    location: "wallet",
    quantity: "1",
    decimals: 6,
    price_usd: 1,
    price_source: "face value",
    value_cents: 100,
    notional: false,
    verify: "eth_call balanceOf",
    ...over,
  } as Holding;
}

test("a FAILED read that produced no holdings is NOT a complete book", () => {
  const s = summarizeAssets([], ["asset read exceeded 2500ms and no earlier snapshot exists"]);
  assert.equal(s.complete, false, "every() is vacuously true on []; completeness must not be");
  assert.equal(s.total_cents, null, "an unreachable book is unknown, never zero");
  assert.equal(s.conservative_total_cents, null);
  assert.equal(s.by_location.wallet_cents, null);
  assert.equal(s.by_location.claimable_cents, null);
  for (const tier of s.by_tier) {
    assert.equal(tier.cents, null, `tier ${tier.tier} must be unknown, not zero`);
  }
});

test("the zeroed shape that was served is now unreachable", () => {
  // The exact response body observed on the wire: complete true, total zero,
  // every tier zero, holdings empty. If any future refactor can produce that
  // combination again, this fails.
  const s = summarizeAssets([], ["asset read exceeded 2500ms and no earlier snapshot exists"]);
  const servedAsComplete = s.complete === true && s.total_cents === 0;
  assert.equal(servedAsComplete, false, "complete:true with total_cents:0 from an empty read is the defect");
});

test("an empty book nobody failed to read is still complete and zero", () => {
  // The existing contract, preserved deliberately: summarizeAssets([]) with no
  // errors keeps its old meaning. The defect was never that [] is zero — it was
  // that [] plus a failed read was ALSO zero.
  const s = summarizeAssets([]);
  assert.equal(s.complete, true);
  assert.equal(s.total_cents, 0);
  assert.deepEqual(s.by_tier.map((t) => t.cents), [0, 0, 0]);
});

test("a genuine zero balance is still reportable, and is different from an unreachable one", () => {
  // The fix must not make a real zero unrepresentable. A wallet that truly holds
  // nothing has a holding row whose value_cents is 0 — present at zero, which is
  // a claim the read actually supports.
  const s = summarizeAssets([holding({ quantity: "0", value_cents: 0 })]);
  assert.equal(s.complete, true, "one row that was read successfully is a complete book");
  assert.equal(s.total_cents, 0, "and it may legitimately total zero");
  assert.equal(s.by_tier.find((t) => t.tier === 1)?.cents, 0);
});

test("one unpriced holding still makes the book incomplete", () => {
  // The original guard, unchanged: a row the read could not price poisons the
  // total rather than being summed as zero.
  const s = summarizeAssets([holding(), holding({ asset: "WETH", tier: 2, value_cents: null })]);
  assert.equal(s.complete, false);
  assert.equal(s.total_cents, null);
});

test("completeness and the totals never disagree", () => {
  // The invariant a consumer actually relies on: if complete is false every
  // aggregate is null, and if it is true none of them are. A window that trusts
  // `complete` and renders the totals cannot then be handed a zero.
  const cases: Array<[Holding[], string[]]> = [
    [[], []], [[], ["read failed"]], [[holding()], []],
    [[holding(), holding({ value_cents: null })], []], [[holding({ value_cents: 0 })], []],
    [[holding()], ["a partial failure still poisons the book"]],
  ];
  for (const [rows, errs] of cases) {
    const s = summarizeAssets(rows, errs);
    const aggregates = [s.total_cents, s.conservative_total_cents, s.by_location.wallet_cents, s.by_location.claimable_cents, ...s.by_tier.map((t) => t.cents)];
    if (s.complete) assert.ok(aggregates.every((v) => v !== null), "complete book must price every aggregate");
    else assert.ok(aggregates.every((v) => v === null), "incomplete book must price none of them");
  }
});
