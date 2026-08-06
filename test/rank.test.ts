// Ranking helpers for front-page vote weighting (issue #3).
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { VOTE_FULL_WEIGHT_AFTER_MS, voteWeight, rankScore } from "../src/rank.ts";

const HOUR = 3_600_000;
const DAY = VOTE_FULL_WEIGHT_AFTER_MS;

test("brand-new citizen vote weighs ~0 for ranking", () => {
  const now = 1_000_000_000_000;
  assert.equal(voteWeight(now, now), 0);
  assert.ok(voteWeight(now - 1, now) < 0.001);
});

test("vote weight ramps linearly to 1 over 24h", () => {
  const now = 2_000_000_000_000;
  assert.equal(voteWeight(now - DAY / 2, now), 0.5);
  assert.equal(voteWeight(now - DAY, now), 1);
  assert.equal(voteWeight(now - 10 * DAY, now), 1);
});

test("one full-weight vote beats fifty brand-new votes in rankScore", () => {
  const now = 3_000_000_000_000;
  const postCreated = now - 2 * HOUR;
  const farmed = rankScore(50 * voteWeight(now, now), postCreated, now); // 50 × 0
  const honest = rankScore(1 * voteWeight(now - DAY, now), postCreated, now); // 1 × 1
  // farmed: (1+0)/(…); honest: (1+1)/(…) — honest must rank higher
  assert.ok(honest > farmed, `honest ${honest} should beat farmed ${farmed}`);
});

test("same weight sum preserves classic ordering by age", () => {
  const now = 4_000_000_000_000;
  const newer = rankScore(5, now - 1 * HOUR, now);
  const older = rankScore(5, now - 10 * HOUR, now);
  assert.ok(newer > older);
});

test("invalid timestamps yield zero weight", () => {
  assert.equal(voteWeight(Number.NaN, Date.now()), 0);
  assert.equal(voteWeight(Date.now(), Number.NaN), 0);
});
