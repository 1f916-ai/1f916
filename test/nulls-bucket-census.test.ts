// nulls_total for a windowed `since`, counted from maintained buckets.
//
// `SELECT COUNT(*) FROM nulls WHERE created_at > ?1` read 71,743 rows per call
// against production 2026-09-16, on the busiest endpoint on the board, and the
// table grows 11,000+ rows a day, so it got worse daily. countNullsAfter sums
// three DISJOINT terms instead — whole days after `since`'s day, whole hours
// after `since`'s hour inside that day, and the rows in `since`'s own hour that
// are actually after it — of which only the last reads the table, bounded by one
// hour of writes (177 rows measured).
//
// WHY THIS FILE EXISTS SEPARATELY FROM nulls-census-cost.test.ts. Those five
// guards pass against this change without exercising one line of it. They seed
// 40 rows at FLOOR + i*10 — a span of 400 MILLISECONDS — so the fixture never
// crosses an hour or a day, the day and hour terms are never reached, and the
// one test that corrupts table_counts passes through the self-verifying FALLBACK
// rather than through the buckets. A fixture that cannot reach the code it is
// pointed at is not a weak test, it is an absent one, and this session has
// already been misled twice by exactly that. So the first assertion below is a
// PREMISE guard on the fixture itself.
//
// Four guarantees, each with the mutation that kills it:
//
// 1. The fixture spans multiple days and hours. Killing mutation: collapse the
//    seed into one hour and this goes red — before any census assertion can
//    pass vacuously.
// 2. The census equals a real COUNT(*) across every boundary regime: exact day
//    boundaries, one millisecond either side, exact hour boundaries, mid-hour,
//    below the floor and past the end. Killing mutations, each red: delete the
//    `days` term; delete the `hours` term; change the partial's `created_at <
//    ?2` to `<=` (the fixture puts rows exactly on hour boundaries, so the
//    boundary row is then counted by both the partial and its hour bucket).
// 3. Disagreement between the buckets and 0051's counter refuses the fast path
//    and counts for real. Killing mutation: drop the comparison and a corrupted
//    counter silently yields a wrong census.
// 4. A database where migration 0056 has not run counts for real rather than
//    serving a number far below the truth. This is the failure that would look
//    healthy: every bucket sum is 0 and nothing errors. Killing mutation: same
//    as 3 — remove the guard and this returns a small number instead of the
//    truth.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { countNullsAfter, type Env } from "../src/society.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const DAY = 86_400_000;
const HOUR = 3_600_000;
// An exact multiple of DAY, written as the multiplication rather than as a
// literal so the alignment is self-evident. The first draft used
// 1_700_000_000_000, which is 800,000ms past an hour boundary, so NO seeded row
// landed exactly on one and the partial term's `<` vs `<=` was unobservable —
// the premise guard below caught it, which is the whole reason it is there.
const BASE = 19_675 * DAY;

function seeded() {
  const { env, db } = sqliteTestEnv(SCHEMA);
  const ins = db.prepare("INSERT INTO nulls (kind, reason, created_at) VALUES ('refusal', ?, ?)");
  // Six days, every third hour, four rows an hour. k=0 lands EXACTLY on the hour
  // boundary, which is what makes the partial term's `<` vs `<=` observable.
  for (let d = 0; d < 6; d++) {
    for (let h = 0; h < 24; h += 3) {
      for (let k = 0; k < 4; k++) {
        const t = BASE + d * DAY + h * HOUR + k * 137_000;
        ins.run(`r${d}-${h}-${k}`, t);
      }
    }
  }
  // Ties on one stamp: two rows sharing created_at must be counted twice.
  ins.run("tie-a", BASE + 2 * DAY);
  ins.run("tie-b", BASE + 2 * DAY);
  return { env: env as Env, db };
}

const realCount = (db: DatabaseSync, since: number) =>
  Number((db.prepare("SELECT COUNT(*) AS n FROM nulls WHERE created_at > ?").get(since) as { n: number }).n);

test("the fixture spans several days and hours, so the day and hour terms are reachable", () => {
  const { db } = seeded();
  const span = db.prepare("SELECT MIN(created_at) AS lo, MAX(created_at) AS hi FROM nulls").get() as { lo: number; hi: number };
  const days = db.prepare("SELECT COUNT(DISTINCT created_at / 86400000) AS n FROM nulls").get() as { n: number };
  const hours = db.prepare("SELECT COUNT(DISTINCT created_at / 3600000) AS n FROM nulls").get() as { n: number };
  assert.ok(span.hi - span.lo > 2 * DAY, `the seed must span days, spans ${span.hi - span.lo}ms`);
  assert.ok(days.n >= 5, `the day term needs several days to sum, got ${days.n}`);
  assert.ok(hours.n >= 20, `the hour term needs several hours to sum, got ${hours.n}`);
  // And a row sitting EXACTLY on an hour boundary, or the partial's comparison
  // operator is unobservable and mutation 2c passes silently.
  const onBoundary = db.prepare("SELECT COUNT(*) AS n FROM nulls WHERE created_at % 3600000 = 0").get() as { n: number };
  assert.ok(onBoundary.n > 0, "at least one row must sit exactly on an hour boundary");
});

test("the windowed census equals a real count across every boundary regime", async () => {
  const { env, db } = seeded();
  const probes: number[] = [];
  for (let d = -1; d <= 7; d++) {
    const day = BASE + d * DAY;
    probes.push(day, day - 1, day + 1, day + HOUR, day + HOUR + 1, day + 7 * HOUR + 91_000);
  }
  probes.push(0, BASE - 30 * DAY, BASE + 100 * DAY);

  const mismatches: string[] = [];
  for (const since of probes) {
    const got = await countNullsAfter(env, since);
    const want = realCount(db, since);
    if (got !== want) mismatches.push(`since=${since} got=${got} want=${want}`);
  }
  assert.deepEqual(mismatches, [], `bucket census disagreed with a real count:\n  ${mismatches.join("\n  ")}`);
  // The sweep must actually have counted something, or "no mismatches" is the
  // agreement of two zeros.
  assert.ok(await countNullsAfter(env, BASE + 2 * DAY) > 0, "the probes must cover non-empty windows");
});

test("buckets disagreeing with the maintained counter refuse the fast path and count for real", async () => {
  const { env, db } = seeded();
  const since = BASE + 2 * DAY + 5 * HOUR;
  const truth = realCount(db, since);
  // Force them apart. Only a fallback to a real count can still be right.
  db.exec("UPDATE table_counts SET n = 999999 WHERE name = 'nulls'");
  assert.equal(await countNullsAfter(env, since), truth, "a drifted counter must not produce a wrong census");
});

test("a database without migration 0056 counts for real, not from empty buckets", async () => {
  const { env, db } = seeded();
  const since = BASE + 3 * DAY;
  const truth = realCount(db, since);
  assert.ok(truth > 0, "the window must be non-empty for this to mean anything");
  // The shape of a database the migration never touched: the table exists (the
  // schema creates it) but carries no rows. Every bucket sum is then 0 and
  // nothing errors — the census would look healthy and be far too small.
  db.exec("DELETE FROM nulls_buckets");
  assert.equal(await countNullsAfter(env, since), truth, "empty buckets must fall back, never serve a small number");
});
