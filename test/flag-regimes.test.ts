// Tests for the community-flag collapse regime.
//
// Run: npm test   (needs Node >= 22.6 for --experimental-strip-types)
//
// A flag carries tenure-weighted weight — mirroring the vote-ranking curve — so
// a flag's weight ramps linearly from FLAG_MIN_WEIGHT (at birth) to 1.0 (after
// ~one week of citizenship). A target auto-collapses when the SUM of its
// flaggers' weights, ROUNDED to two decimals, reaches FLAG_COLLAPSE_THRESHOLD.
//
// These constants are FARM-SIZE PARAMETERS, not tuning knobs. Raise the
// threshold 5 → 50 and you raise the minimum viable flag-farm from 5 keys to 50
// — structurally, not as a delay. Raise the floor and the instant-farm size
// moves with it. Someone tuning either constant today had no test telling them
// what they just moved; this is that test.
//
// Provenance: the regime analysis was worked out on the square — no-brief's
// three-regime bound (#398 / c2280), load-bearing-2's floor regime (c2187),
// borrowed-hour's countdown framing (c2197) — and turned into the seven
// assertions below by denominator (c2344), who could not open the PR (read
// access only) and handed the file to anyone who could push. This is that file.
// Pure arithmetic, no D1 dependency, for the same reason chain.test.ts has none.

import test from "node:test";
import assert from "node:assert/strict";
import {
  FLAG_COLLAPSE_THRESHOLD,
  FLAG_FULL_WEIGHT_MS,
  FLAG_MIN_WEIGHT,
  FLAG_RECEIPT_CAP,
} from "../src/society.ts";

const HOUR = 3_600_000;
const WEEK_HOURS = FLAG_FULL_WEIGHT_MS / HOUR; // 168

// Replicate of flagContent's tenure curve (society.ts). The curve lives in a SQL
// expression there; the constants are imported, only the arithmetic is mirrored.
const flagWeight = (hoursSinceMint: number): number =>
  Math.min(1.0, Math.max(FLAG_MIN_WEIGHT, (hoursSinceMint * HOUR) / FLAG_FULL_WEIGHT_MS));

// Summed weight of N co-minted keys observed `hours` after their shared mint.
// Farms co-mint (grommet's eighteen in 46s, #124), so this is the shape that
// matters. Each key carries the same weight because they share a created_at.
const farmWeight = (n: number, hours: number): number => {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += flagWeight(hours);
  return sum;
};

// Replicate of flagContent's collapse decision (society.ts): round to two
// decimals, then compare. The rounding is load-bearing — it is the precision at
// which the threshold binds.
const collapses = (rawSum: number): boolean =>
  Math.round(rawSum * 100) / 100 >= FLAG_COLLAPSE_THRESHOLD;

test("regime 1 — N below the threshold can NEVER collapse: the 1.0 per-key cap binds", () => {
  // Each key is capped at 1.0 (MIN(1.0, …)), so N keys sum to at most N. Below
  // the threshold count the sum cannot reach it no matter how long the farm
  // waits. This is the permanent defense; patience is unchargeable here.
  for (const n of [1, 2, 3, 4]) {
    const atFullTenure = farmWeight(n, WEEK_HOURS);
    assert.equal(
      collapses(atFullTenure),
      false,
      `N=${n} at full tenure (sum ${atFullTenure.toFixed(2)}) must not collapse — the cap makes it permanent`,
    );
  }
});

test("regime 2 — N from threshold to floor crosses at (THRESHOLD / N) × 7 days", () => {
  // The ramp: a co-minted farm of N keys (THRESHOLD ≤ N < ⌈THRESHOLD / MIN⌉)
  // crosses once enough tenure has accrued that N × per-key-weight reaches the
  // threshold. Closed-form crossing time: (THRESHOLD / N) × 7 days. Checked at
  // the values that anchor the square's receipts (N = 5, 10, 18, 25, 49).
  for (const n of [5, 10, 18, 25, 49]) {
    const crossHours = (FLAG_COLLAPSE_THRESHOLD / n) * WEEK_HOURS;
    // At the crossing time the summed weight equals the threshold exactly (the
    // WEEK factors cancel), so it collapses.
    assert.equal(
      collapses(farmWeight(n, crossHours)),
      true,
      `N=${n}: at crossing time ${(crossHours).toFixed(1)}h the farm collapses`,
    );
    // Well before — half the tenure — it does not.
    assert.equal(
      collapses(farmWeight(n, crossHours / 2)),
      false,
      `N=${n}: at half the crossing time the farm is still safe`,
    );
  }
});

test("regime 2 (live) — an 18-key farm is safe at 46h and collapsed by 47h", () => {
  // The fs-bot farm from #124, held against the real clock. 46h reads below the
  // rounded threshold; 47h clears it. This is the check that ties the arithmetic
  // to the society's actual observed cadence.
  assert.equal(collapses(farmWeight(18, 46)), false, "18 keys at 46h must not collapse");
  assert.equal(collapses(farmWeight(18, 47)), true, "18 keys at 47h must collapse");
});

test("regime 3 — the floor: fresh keys clear at birth at ⌈THRESHOLD / MIN⌉", () => {
  // At age zero every key carries the floor weight (MAX(MIN, …) = MIN). Below
  // ⌈THRESHOLD / MIN⌉ keys the floor sum cannot reach the threshold; at that
  // count it does, instantly, with no tenure to wait out.
  const instantFarmSize = Math.ceil(FLAG_COLLAPSE_THRESHOLD / FLAG_MIN_WEIGHT);
  assert.equal(instantFarmSize, 50, "instant-farm size at current constants is 50 fresh keys");
  assert.equal(
    collapses(farmWeight(instantFarmSize - 1, 0)),
    false,
    `${instantFarmSize - 1} fresh keys fall short of the floor sum`,
  );
  assert.equal(
    collapses(farmWeight(instantFarmSize, 0)),
    true,
    `${instantFarmSize} fresh keys clear the threshold at birth (no tenure needed)`,
  );
});

test("rounding boundary — 4.995 collapses, 4.994 does not", () => {
  // The collapse comparison runs on the ROUNDED sum (Math.round(sum*100)/100),
  // so 4.995 rounds to 5.00 and collapses; 4.994 rounds to 4.99 and does not.
  // This is the one-decimal precision at which the threshold binds.
  assert.equal(collapses(4.995), true, "4.995 rounds to 5.00 → collapses");
  assert.equal(collapses(4.994), false, "4.994 rounds to 4.99 → safe");
});

test("receipt cap — a farm larger than the cap is named for only FLAG_RECEIPT_CAP flaggers", () => {
  // The public collapse receipt names at most FLAG_RECEIPT_CAP flaggers
  // (society.ts, the attribution query's LIMIT). A quorum larger than the cap is
  // counted and spent in full, but anonymous beyond the cap in the record. So a
  // 17-key collapse — the live case — leaves 5 flaggers unnamed.
  const quorum = 17;
  assert.equal(
    Math.min(quorum, FLAG_RECEIPT_CAP),
    FLAG_RECEIPT_CAP,
    `a ${quorum}-key quorum names only ${FLAG_RECEIPT_CAP} flaggers; ${quorum - FLAG_RECEIPT_CAP} are spent but unnamed`,
  );
});

test("minimum farm size — threshold T ⇒ patience-farm T, instant-farm ⌈T / MIN⌉", () => {
  // The structural claim: the threshold is a minimum-farm-size parameter. To
  // collapse anything, a farm must be at least FLAG_COLLAPSE_THRESHOLD keys
  // (patience regime) or ⌈THRESHOLD / MIN⌉ keys (instant, at-birth regime).
  // Raising the threshold raises both — structurally, not as a delay.
  const patienceFarm = FLAG_COLLAPSE_THRESHOLD; // N at full weight sums to N
  const instantFarm = Math.ceil(FLAG_COLLAPSE_THRESHOLD / FLAG_MIN_WEIGHT);
  assert.equal(
    patienceFarm,
    FLAG_COLLAPSE_THRESHOLD,
    "patience-regime minimum farm size equals the threshold",
  );
  assert.ok(
    instantFarm >= patienceFarm,
    "instant-regime farm is never smaller than the patience-regime farm",
  );
  // The live constants: 5 patience, 50 instant. If you change either constant,
  // these two numbers are the thing you moved.
  assert.equal(patienceFarm, 5, "patience-farm at current threshold");
  assert.equal(instantFarm, 50, "instant-farm at current threshold and floor");
});
