// Read-only rail throughput census, served on GET /api/rail. Inspired by
// identity.md's public activity view. This module is pure: given rows, it
// returns figures and the derivation of each one. It does not touch the
// database and it does not move money.
//
// KILLING MUTATIONS: an empty sample that served zeros instead of nulls
// would read as instant payment of work that was never paid; including an
// unpaid award in time_to_pay would shrink the median; summing the three
// settlement-mode RATES instead of their COUNTS would report 0.6 for a rail
// that awarded 2 of 12; a quiet week served as a row of zeros would be
// indistinguishable from a missing record; a wrong ISO week (Sunday start,
// or calendar year instead of week-year) would mis-bucket the first days
// of January and the last days of December.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { createListing, railCensus } from "../src/society.ts";
import {
  percentile,
  summarizeDurations,
  isoWeekUtc,
  railThroughput,
  RAIL_THROUGHPUT_NOTE,
  type ThroughputAward,
  type ThroughputListing,
  type ThroughputReceipt,
  type ThroughputSubmission,
} from "../src/rail-throughput.ts";

test("percentile interpolates and refuses an empty sample", () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 0), 1);
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(percentile([1, 2, 3, 4, 5], 0.9), 4.6);
  assert.equal(percentile([1, 2, 3, 4, 5], 1), 5);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(percentile([10], 0.5), 10);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9.1);
  assert.throws(() => percentile([], 0.5), /empty sample/);
});

test("summarizeDurations yields nulls on an empty sample, never zeros", () => {
  assert.deepEqual(summarizeDurations([]), {
    n: 0,
    min_ms: null,
    median_ms: null,
    p90_ms: null,
    mean_ms: null,
    max_ms: null,
  });
  assert.deepEqual(summarizeDurations([100, 200, 300, 400, 500]), {
    n: 5,
    min_ms: 100,
    median_ms: 300,
    p90_ms: 460,
    mean_ms: 300,
    max_ms: 500,
  });
});

test("isoWeekUtc uses the ISO week-year and Monday 00:00 UTC", () => {
  const cases: Array<[string, string, string]> = [
    ["2026-11-13T12:00:00Z", "2026-W46", "2026-11-09T00:00:00.000Z"],
    ["2025-12-29T00:00:00Z", "2026-W01", "2025-12-29T00:00:00.000Z"],
    ["2025-12-31T23:59:59Z", "2026-W01", "2025-12-29T00:00:00.000Z"],
    ["2026-01-01T12:00:00Z", "2026-W01", "2025-12-29T00:00:00.000Z"],
    ["2026-12-31T12:00:00Z", "2026-W53", "2026-12-28T00:00:00.000Z"],
    ["2027-01-01T12:00:00Z", "2026-W53", "2026-12-28T00:00:00.000Z"],
    ["2024-12-30T12:00:00Z", "2025-W01", "2024-12-30T00:00:00.000Z"],
  ];
  for (const [iso, week, start] of cases) {
    const got = isoWeekUtc(Date.parse(iso));
    assert.equal(got.week, week, `${iso} should be ${week}, got ${got.week}`);
    assert.equal(new Date(got.start_ms).toISOString(), start, `${iso} week start`);
    assert.equal(got.start_ms % 86_400_000, 0, "week start is midnight UTC");
  }
});

function emptyInput(overrides: Partial<Parameters<typeof railThroughput>[0]> = {}) {
  return {
    now: Date.parse("2026-11-13T17:00:00Z"),
    open: 0,
    overdueAwards: 0,
    listings: [] as ThroughputListing[],
    submissions: [] as ThroughputSubmission[],
    awards: [] as ThroughputAward[],
    receipts: [] as ThroughputReceipt[],
    acceptanceEnded: 0,
    acceptanceAwarded: 0,
    ...overrides,
  };
}

test("railThroughput: empty rail serves null time-to-pay and a null acceptance rate, not zeros", () => {
  const t = railThroughput(emptyInput());
  assert.equal(t.time_to_pay.award_to_paid.n, 0);
  assert.equal(t.time_to_pay.award_to_paid.median_ms, null);
  assert.equal(t.time_to_pay.submission_to_paid.mean_ms, null);
  assert.equal(t.acceptance.rate, null);
  assert.equal(t.acceptance.listings_ended_with_scored_submissions, 0);
  assert.equal(t.open, 0);
  assert.equal(t.overdue.awards, 0);
  assert.deepEqual(t.jobs_per_week.weeks, []);
  assert.deepEqual(t.jobs_per_week.all_time, {
    listings_posted: 0,
    submissions: 0,
    awards: 0,
    awards_paid: 0,
    receipts: 0,
  });
  assert.equal(t.note, RAIL_THROUGHPUT_NOTE);
});

test("railThroughput: time_to_pay uses only paid awards, and unpaid rows do not shrink the median", () => {
  const submissions: ThroughputSubmission[] = [
    { id: 1, listing_id: 1, created_at: 1_000 },
    { id: 2, listing_id: 1, created_at: 1_000 },
    { id: 3, listing_id: 2, created_at: 2_000 },
  ];
  const awards: ThroughputAward[] = [
    { listing_id: 1, submission_id: 1, state: "paid", awarded_at: 2_000, paid_at: 5_000, overdue_at: null },
    { listing_id: 1, submission_id: 2, state: "paid", awarded_at: 2_000, paid_at: 8_000, overdue_at: null },
    { listing_id: 2, submission_id: 3, state: "overdue_unpaid", awarded_at: 3_000, paid_at: null, overdue_at: 4_000 },
  ];
  const t = railThroughput(emptyInput({ submissions, awards, overdueAwards: 1, open: 0 }));
  // Two paid awards: lags 3000 and 6000, median 4500. If the unpaid row
  // entered as a zero lag, the median would be 3000.
  assert.equal(t.time_to_pay.award_to_paid.n, 2);
  assert.equal(t.time_to_pay.award_to_paid.min_ms, 3_000);
  assert.equal(t.time_to_pay.award_to_paid.max_ms, 6_000);
  assert.equal(t.time_to_pay.award_to_paid.median_ms, 4_500);
  assert.equal(t.time_to_pay.award_to_paid.mean_ms, 4_500);
  // submission lags: 4000 and 7000.
  assert.equal(t.time_to_pay.submission_to_paid.n, 2);
  assert.equal(t.time_to_pay.submission_to_paid.min_ms, 4_000);
  assert.equal(t.time_to_pay.submission_to_paid.max_ms, 7_000);
  assert.equal(t.time_to_pay.submission_to_paid.median_ms, 5_500);
  assert.equal(t.overdue.awards, 1);
});

test("railThroughput: acceptance sums counts across partitions, never the rates", () => {
  // Requester 1/2 (0.5) and delegated 1/10 (0.1): summing rates is 0.6,
  // summing counts is 2/12 ≈ 0.1667. This function is handed the already-
  // summed counts (railCensus sums the three groups); the test pins that
  // the rate is awarded/ended and that 0/0 is null, not 0.
  const summed = railThroughput(emptyInput({ acceptanceEnded: 12, acceptanceAwarded: 2 }));
  assert.equal(summed.acceptance.listings_ended_with_scored_submissions, 12);
  assert.equal(summed.acceptance.listings_ended_with_scored_submissions_awarded, 2);
  assert.equal(summed.acceptance.rate, 2 / 12);
  assert.notEqual(summed.acceptance.rate, 0.5 + 0.1);
  const empty = railThroughput(emptyInput({ acceptanceEnded: 0, acceptanceAwarded: 0 }));
  assert.equal(empty.acceptance.rate, null);
});

test("railThroughput: jobs_per_week buckets by ISO week and omits a quiet week", () => {
  const w46 = Date.parse("2026-11-13T12:00:00Z"); // 2026-W46, Monday 11-09
  const w44 = Date.parse("2026-10-28T12:00:00Z"); // 2026-W44, Monday 10-26 (W45 is quiet)
  const listings: ThroughputListing[] = [
    { id: 1, created_at: w44 },
    { id: 2, created_at: w46 },
    { id: 3, created_at: w46 },
  ];
  const submissions: ThroughputSubmission[] = [{ id: 1, listing_id: 2, created_at: w46 }];
  const awards: ThroughputAward[] = [
    { listing_id: 2, submission_id: 1, state: "paid", awarded_at: w46, paid_at: w46 + 3_600_000, overdue_at: null },
  ];
  const receipts: ThroughputReceipt[] = [{ created_at: w46 + 3_600_000 }];
  const t = railThroughput(emptyInput({ listings, submissions, awards, receipts, open: 2 }));
  assert.deepEqual(t.jobs_per_week.weeks.map((w) => w.week), ["2026-W44", "2026-W46"]);
  assert.ok(!t.jobs_per_week.weeks.some((w) => w.week === "2026-W45"), "a quiet week is a gap, not a zero row");
  assert.equal(t.jobs_per_week.weeks[0]!.listings_posted, 1);
  assert.equal(t.jobs_per_week.weeks[1]!.listings_posted, 2);
  assert.equal(t.jobs_per_week.weeks[1]!.submissions, 1);
  assert.equal(t.jobs_per_week.weeks[1]!.awards, 1);
  assert.equal(t.jobs_per_week.weeks[1]!.awards_paid, 1);
  assert.equal(t.jobs_per_week.weeks[1]!.receipts, 1);
  assert.equal(new Date(t.jobs_per_week.weeks[1]!.start_ms).toISOString(), "2026-11-09T00:00:00.000Z");
  assert.deepEqual(t.jobs_per_week.all_time, {
    listings_posted: 3,
    submissions: 1,
    awards: 1,
    awards_paid: 1,
    receipts: 1,
  });
  assert.equal(t.open, 2);
});

test("GET /api/rail serves throughput derived from the same listings the census already walks", async () => {
  const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
  const { env, db } = sqliteTestEnv(schema);
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at) VALUES
      (1, 'context-gardener', 'test', 's1', 0, 0, 0);
    INSERT INTO keys (id, citizen_id, public_key, thumbprint, custody, status, bound_at) VALUES
      (1, 1, 'pk1', 'funder-tp', 'undeclared', 'active', 0);
  `);
  const empty = await railCensus(env);
  assert.equal(empty.throughput.time_to_pay.award_to_paid.n, 0);
  assert.equal(empty.throughput.time_to_pay.award_to_paid.median_ms, null);
  assert.equal(empty.throughput.acceptance.rate, null);
  assert.equal(empty.throughput.open, 0);
  assert.equal(empty.throughput.overdue.awards, 0);
  assert.deepEqual(empty.throughput.jobs_per_week.weeks, []);
  assert.equal(empty.throughput.note, RAIL_THROUGHPUT_NOTE);
  assert.ok(typeof empty.derivations.throughput === "string" && empty.derivations.throughput.includes("throughput"));

  const FUNDER = { id: 1, handle: "context-gardener", model: "test", karma: 0, created_at: 0, last_seen_at: 0 };
  const CONDITION =
    "Clone the repository at the named commit, run `npm test`, and the file test/listings.test.ts reports 0 failures.";
  await createListing(env, FUNDER as never, {
    title: "A listing the throughput census must count",
    condition: CONDITION,
    amount_atomic: "1000000",
    expiry: Math.floor(Date.now() / 1000) + 7 * 86400,
  });
  const census = await railCensus(env);
  assert.equal(census.throughput.open, 1);
  assert.equal(census.throughput.jobs_per_week.all_time.listings_posted, 1);
  assert.equal(census.throughput.jobs_per_week.weeks.length, 1);
  assert.equal(census.throughput.jobs_per_week.weeks[0]!.listings_posted, 1);
  assert.match(census.throughput.jobs_per_week.weeks[0]!.week, /^\d{4}-W\d{2}$/);
  // An unpaid rail still has null time-to-pay, not a zero.
  assert.equal(census.throughput.time_to_pay.award_to_paid.n, 0);
  assert.equal(census.throughput.time_to_pay.award_to_paid.median_ms, null);
});
