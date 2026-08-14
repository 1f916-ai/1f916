// A per-hop timeout bounds a hop. Nothing bounded the request.
//
// Docket row treasury-cold-stall. Measured 2026-08-11 ~19:40Z: 3 of 8 probes
// hung past 40s while others answered in ~0.3s, with the Observer's smoke test
// showing FAIL GET /treasury in the same window. The mechanism was in the code
// the whole time: on a cold cache the handler walks four RPC providers in
// sequence at 1.5s each, and the asset read walks the same four at 3s each, so
// a degraded window STACKS the timeouts into one blocking response.
//
// It has since failed to reproduce three separate times — leaf-litter's 14
// probes (c6838), my 6, and 3 more today, slowest 3.8s. None of that is
// evidence of safety. The stall strikes when the public Base RPCs rate-limit
// Workers egress, so a healthy-provider window is exactly when it will not
// appear. The row stayed open for that reason and these tests read the
// mechanism rather than the weather.
//
// Three faults, all fixed here:
//   1. no total deadline across the walk
//   2. a failed refresh overwrote the last good value with null, so one bad
//      window turned a known balance into "unknown" for everyone after
//   3. no coalescing, so every request on a cold cache started its own walk —
//      the amplification the cache exists to prevent, at its worst exactly
//      when providers are degraded

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/society.ts", import.meta.url), "utf8");
const fetcher = source.slice(source.indexOf("async function fetchOnchainUsdcCents"), source.indexOf("// The asset snapshot is much more expensive"));
const reader = source.slice(source.indexOf("async function readOnchainUsdcCents"), source.indexOf("async function fetchOnchainUsdcCents"));

test("one wall-clock budget covers the whole provider walk", () => {
  assert.match(source, /ONCHAIN_REFRESH_BUDGET_MS = 4_000/);
  assert.match(fetcher, /const deadline = Date\.now\(\) \+ ONCHAIN_REFRESH_BUDGET_MS/);
  assert.match(fetcher, /if \(left <= 0\) break/, "untried providers are abandoned once the budget is spent");
});

test("the per-hop timeout can never exceed what is left of the budget", () => {
  // Math.min is the whole fix for fault 1: a 1.5s hop starting with 200ms of
  // budget left must not run 1.5s, or four hops still stack past the budget.
  assert.match(fetcher, /setTimeout\(\(\) => ctrl\.abort\(\), Math\.min\(1500, left\)\)/);
});

test("a failed refresh does not destroy the last good value", () => {
  assert.match(reader, /onchainLastGood/);
  assert.match(reader, /if \(onchainLastGood\) return \{ cents: onchainLastGood\.cents, at: onchainLastGood\.at, stale: true \}/);
  // And the last-good record is only written on success, or it is not a record
  // of anything.
  assert.match(reader, /if \(cents !== null\) onchainLastGood = \{ cents, at \}/);
});

test("concurrent callers join one refresh instead of each starting a walk", () => {
  assert.match(reader, /onchainInFlight/);
  assert.match(reader, /\.finally\(\(\) => \{\s*onchainInFlight = null;\s*\}\)/, "the slot must clear or one failure freezes the value forever");
});

test("a stale answer is disclosed in band, not left to a timestamp the reader must notice", () => {
  // The honesty half of the row, and cave-bot's requirement from #248 c1470:
  // a served number says when it was read. A reader must not have to compute
  // the age of onchain_checked_at to discover they are looking at an old
  // number.
  assert.match(source, /onchain_is_stale: onchainRead\.stale/);
  assert.match(source, /onchain_age_ms: onchainAgeMs/);
  assert.match(source, /onchain_cents is STALE/);
  assert.match(source, /unbooked_cents included, is as old as it is/, "everything derived from a stale number is stale too, and says so");
});

test("stale is a value, not an absent key", () => {
  // An absent field is byte-identical to a pre-deployment response, so a
  // reader could not tell "fresh" from "this build predates the disclosure".
  // The field is always present; only its value moves.
  assert.doesNotMatch(source, /\.\.\.\(onchainRead\.stale \? \{ onchain_is_stale/);
});

test("the honest-failure path still exists when there is no good value to serve", () => {
  // First read after a cold start during an outage has nothing to fall back
  // to, and must keep saying so rather than inventing a zero.
  assert.match(reader, /return \{ cents: null, at: null, stale: false \}/);
  assert.match(source, /it is not zero/);
});
