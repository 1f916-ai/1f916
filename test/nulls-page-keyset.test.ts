// The nulls page on GET /api/changes walks the primary key from a bounded id
// instead of reading the whole table.
//
// Measured against production 2026-09-16, over three days:
//
//   SELECT ... FROM nulls WHERE created_at > ?1 ORDER BY id ASC LIMIT 201
//     23,572,040,640 rows over 316,486 calls — ~74,500 rows to serve 200, and
//     33% of every row D1 billed that period.
//
// The cause is not the size of the page, it is that the page could not bound
// itself: the filter is on created_at and the ORDER BY is on id, so
// idx_nulls_created can serve only half of the statement and SQLite walked the
// table instead (EXPLAIN: a bare `SCAN nulls`), reading every row before the
// LIMIT could apply. Cost was proportional to the TABLE, so it grew every day
// the log grew and no amount of caching in front of it would have stopped that.
//
// The fix seeks one row below the window and walks the primary key from there.
// What makes it delicate is that created_at is NOT monotonic in id — recordNull
// binds a `now` sampled when the REQUEST started, so a request that samples
// early and commits late takes a higher id than one carrying a later stamp.
// Seeking to the first index entry above `since` therefore drops rows. The
// margin (NULLS_BOUNDARY_SKEW_MS) is what makes the start id provably safe: a
// row stamped at or below `since - margin` committed no later than its stamp
// plus one request lifetime, so it committed before `since` and took a lower id
// than every row in the window.
//
// Three guarantees, each with the mutation that kills it:
//
// 1. Nothing serving this stream may scan the table. Killing mutation: restore
//    `WHERE created_at > ?1` (dropping `id >= ?2`) and the plan goes back to a
//    bare `SCAN nulls` — red. This is the guard for the COST; test 2 and 3 pass
//    happily with the slow statement, which is the point of separating them.
// 2. A row whose timestamp disagrees with its id is still served. Killing
//    mutation: seek from `since` instead of `since - NULLS_BOUNDARY_SKEW_MS`
//    and the reordered row falls below the start id and vanishes — red. This is
//    the guard for CORRECTNESS, and it is the one that matters: a dropped row
//    here is silent loss from a stream whose whole purpose is that absences are
//    recorded.
// 3. The page is row-for-row what the replaced statement returned, across the
//    whole range of windows, under inserts deliberately reordered. Killing
//    mutation: any change to the ORDER BY, the LIMIT, or the boundary — red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { changes, NULLS_LIMIT, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

// A real SQLite behind a D1 shim that records the SQL it is handed, so the test
// can EXPLAIN the statements the endpoint ACTUALLY issued rather than a
// hand-copied lookalike that could drift away from the code it certifies.
function recordingEnv() {
  const { db, d1 } = sqliteTestEnv(SCHEMA);
  const seen: string[] = [];
  const DB = {
    prepare(sql: string) {
      seen.push(sql);
      return d1.prepare(sql);
    },
    batch(statements: never) {
      return d1.batch(statements);
    },
  };
  return { env: { DB } as unknown as Env, db, seen };
}

// Ids are assigned in insertion order, so the position in this array IS the row
// id. That is what lets a fixture put a late timestamp on an early id.
function seed(db: DatabaseSync, stamps: number[]) {
  const ins = db.prepare("INSERT INTO nulls (kind, reason, created_at) VALUES ('refusal', ?, ?)");
  stamps.forEach((stamp, i) => ins.run(`seeded refusal ${i + 1}`, stamp));
}

const pageIds = async (env: Env, since: number): Promise<number[]> =>
  ((await changes(env, since, null, null, null)) as { nulls: { id: number }[] }).nulls.map((r) => r.id);

const T = 2_000_000_000;

test("no statement serving the nulls stream may scan the table", async () => {
  const { env, db, seen } = recordingEnv();
  seed(db, Array.from({ length: 3000 }, (_, i) => T + i * 10_000));
  // A window well inside the table: the regime that measured 112,966 rows.
  await changes(env, T + 15_000_000, null, null, null);

  const touching = seen.filter((sql) => /\bFROM nulls\b/.test(sql));
  assert.ok(touching.length > 0, "the window page must actually read the nulls table");

  for (const sql of touching) {
    // EXPLAIN does not evaluate parameters, but the statement still has to be
    // preparable, so the placeholders become a literal.
    const literal = sql.replace(/\?\d*/g, "1");
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${literal}`).all() as { detail: string }[])
      .map((r) => r.detail)
      .join(" | ");
    // A covered scan of the INDEX is fine — it reads index entries for a bounded
    // range. A bare `SCAN nulls` is the defect: it reads table rows without
    // bound, and it is what this endpoint did 316,486 times in three days.
    assert.doesNotMatch(
      plan,
      /SCAN nulls(?! USING)/,
      `unbounded table scan serving the nulls stream:\n  ${literal.replace(/\s+/g, " ")}\n  => ${plan}`,
    );
  }
});

test("a row whose timestamp disagrees with its id is still served", async () => {
  const { env, db } = recordingEnv();
  // Six rows. Ids are insertion order; stamps are what each request sampled when
  // it STARTED. Row 4 sampled 10s before the window opens and committed after
  // row 3, which sampled 30s after it — a 40s lifetime, comfortably inside the
  // 60s margin, so this fixture is a state the margin claims to cover rather
  // than a pathological one it does not.
  seed(db, [
    T - 120_000, // id 1  before the window, below the margin
    T - 90_000, //  id 2  before the window, below the margin — the safe start
    T + 30_000, //  id 3  IN the window, and below the naive boundary
    T - 10_000, //  id 4  before the window, inside the margin: the naive boundary
    T + 40_000, //  id 5  in the window
    T + 90_000, //  id 6  in the window
  ]);

  const served = await pageIds(env, T);
  assert.deepEqual(
    served,
    [3, 5, 6],
    "every row stamped after the window opens is served, including one that took a lower id than a row stamped before it",
  );
  assert.ok(!served.includes(4), "and a row stamped before the window is still excluded");
});

test("the page is row-for-row the statement it replaced, across the range of windows", async () => {
  const { env, db } = recordingEnv();
  // 1,200 rows, each jittered backwards by up to 25s against its neighbours:
  // created_at and id disagree constantly, which is the condition the old
  // statement handled by reading everything.
  const stamps = Array.from({ length: 1200 }, (_, i) => T + (i + 1) * 10_000 - ((i + 1) * 7919) % 25_000);
  seed(db, stamps);

  // The exact statement this change removed, as the oracle.
  const reference = db.prepare(
    `SELECT id FROM nulls WHERE created_at > ? ORDER BY id ASC LIMIT ${NULLS_LIMIT}`,
  );

  let windows = 0;
  for (let step = -10; step <= 1300; step += 7) {
    const since = T + step * 10_000;
    const want = (reference.all(since) as { id: number }[]).map((r) => r.id);
    assert.deepEqual(await pageIds(env, since), want, `window at since=${since} (step ${step})`);
    windows += 1;
  }
  assert.ok(windows > 180, `the sweep must actually cover the range; covered ${windows} windows`);
});
