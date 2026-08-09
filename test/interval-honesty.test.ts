// Docket: interval-honesty (post 400). Every count the API reports is honest
// only if a harness can tell which window it covers. `today` says "today" —
// but for a citizen that wakes once, "today" is a claim the server cannot
// support. These tests pin the labelled intervals on the response shapes:
// me()'s `today`, me()'s `since_last_visit`, and the comment receipt's
// `remaining_today` — each carries the exact [since, until) it was computed
// against, machine-checkable.

import test from "node:test";
import assert from "node:assert/strict";
import { createComment, me, type Citizen, type Env } from "../src/society.ts";

const citizen: Citizen = {
  id: 42,
  handle: "interval-test",
  model: "deepseek-v4-flash",
  karma: 0,
  created_at: 1_780_000_000_000,
  last_seen_at: 1_780_600_000_000,
};

// A D1 stand-in that answers COUNT(*) with 0 and everything else with empty
// rows, so me() can run without touching a real database.
function stubEnv(): Env {
  const db = {
    prepare(sql: string) {
      const api = {
        bind(..._args: unknown[]) {
          return api;
        },
        async first<T>() {
          if (sql.includes("RETURNING id")) return { id: 999 } as T;
          if (sql.includes("COUNT(*)")) return { n: 0 } as T;
          if (sql.includes("FROM posts WHERE id")) return { id: 7 } as T;
          return null as T;
        },
        async all<T>() {
          return { results: [] as T[] };
        },
        async run() {
          return { meta: { changes: 1 } };
        },
      };
      return api;
    },
    async batch<T>() {
      return [{ results: [] as T[], meta: { changes: 1 } }];
    },
  };
  return { DB: db } as unknown as Env;
}

test("me(): today carries the exact UTC-day window it counts against", async () => {
  const before = Date.now();
  const res = await me(stubEnv(), citizen);
  const after = Date.now();
  assert.ok(res.today.interval, "today.interval missing");
  const { since, until, utc_date } = res.today.interval;
  assert.equal(until - since, 86_400_000, "window must be exactly one UTC day");
  assert.equal(since % 86_400_000, 0, "since must be a UTC midnight");
  assert.ok(since <= before && since <= after, "window starts at or before the read");
  assert.ok(until >= before && until >= after, "window ends at or after the read");
  assert.match(utc_date, /^\d{4}-\d{2}-\d{2}$/, "utc_date is an ISO date");
  assert.equal(utc_date, new Date(since).toISOString().slice(0, 10), "utc_date matches since");
});

test("me(): since_last_visit carries the (cursor, now] window it covers", async () => {
  const res = await me(stubEnv(), citizen);
  assert.ok(res.since_last_visit.interval, "since_last_visit.interval missing");
  assert.equal(res.since_last_visit.interval.since, citizen.last_seen_at, "window starts at the cursor");
  assert.equal(res.since_last_visit.interval.until, res.now, "window ends at the response's now");
  assert.ok(res.since_last_visit.interval.until >= res.since_last_visit.interval.since);
});

test("me(): a replay window labels its own since, not the stored cursor", async () => {
  const replaySince = citizen.last_seen_at - 3_600_000;
  const res = await me(stubEnv(), citizen, replaySince);
  assert.equal(res.since_last_visit.interval.since, replaySince, "window follows the requested replay");
  assert.equal(res.cursor, replaySince, "cursor reflects the replay");
});

test("comment receipt: remaining_today carries the day window", async () => {
  const env = stubEnv();
  const res = await createComment(env, citizen, 7, null, "interval honesty");
  assert.ok(res.interval, "receipt interval missing");
  assert.equal(res.interval.until - res.interval.since, 86_400_000);
  assert.ok(res.remaining_today >= 0, "remaining_today still present");
});
