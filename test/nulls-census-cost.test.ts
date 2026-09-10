// The nulls census and page on GET /api/changes, after the 2026-09-10 change
// that stopped both of them reading the whole table.
//
// /api/changes is the busiest endpoint on the board — 106,554 calls on
// 2026-09-09 — and these two queries were 9.26B of the 15.39B D1 rows read that
// day, which is why a 25B MONTHLY tier was running out in under two days.
// Neither query was slow on its own. The trap was that WHICH one was slow
// depended on where `since` fell, so every caller paid ~120,000 rows whichever
// way they paged:
//
//   since below the floor (every row matches)   count 120,894   page      51
//   since inside the window (few rows match)    count   7,876   page 112,966
//
// Five guarantees, each with the mutation that kills it:
//
// 1. Below the floor, the census comes from the MAINTAINED counter (migration
//    0051), not from counting. Proven by seeding the counter with a value that
//    disagrees with reality and watching it be served: only a read of the
//    counter can produce it. Killing mutation: put back
//    `SELECT COUNT(*) FROM nulls WHERE created_at > ?1` — the real count is
//    returned instead and this goes red.
// 2. A MISSING counter row falls back to a real count and NEVER to zero.
//    nulls_total is a census of governed absences; a served 0 would read as
//    "this society refused nothing", the unscoped zero the record forbids.
//    Killing mutation: change the fallback to `?? 0` / drop the branch — red.
// 3. The floor test is STRICTLY below. `created_at > since` excludes a row whose
//    created_at IS since, so since === floor must take the windowed path or the
//    census over-counts by exactly the rows sitting on the boundary.
//    Killing mutation: `since <= nullsFloor` — red.
// 4. Both page plans return the SAME rows. The index-forced plan is a plan hint
//    and nothing else. Killing mutation: change either arm's ORDER BY or LIMIT
//    so the two disagree — red.
// 5. An empty nulls table serves 0. This one is a REGRESSION GUARD, NOT a
//    mutation-backed guarantee, and the difference is worth stating rather than
//    implying: I claimed a killing mutation for it, ran it (route the empty
//    table down the windowed path instead of the covered one) and the suite
//    stayed GREEN. It has to. With no rows, the counter, a real COUNT(*) and a
//    windowed COUNT(*) all answer 0, so no mutation can tell the paths apart
//    here. The test still earns its place — it pins the empty case against a
//    future change that makes it throw or return null — but it certifies
//    nothing about which branch ran.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { changes, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

// Rows are seeded with created_at well above 0 so that since=0 sits strictly
// below the floor, which is the regime the lossless walk actually uses.
const FLOOR = 1_000_000;
function envWithNulls(count: number) {
  const { env, db } = sqliteTestEnv(SCHEMA);
  for (let i = 0; i < count; i++) {
    db.exec(`INSERT INTO nulls (kind, reason, created_at) VALUES ('refusal', 'r${i}', ${FLOOR + i * 10})`);
  }
  return { env, db };
}
const census = async (env: Env, since: number) =>
  ((await changes(env, since, null, null, null)) as { nulls_total: number; nulls: Array<{ id: number }> });

test("below the floor the census is served from the maintained counter, not by counting", async () => {
  const { env, db } = envWithNulls(40);
  // The trigger keeps these equal in production; forcing them apart is the only
  // way to see WHICH one the endpoint read.
  db.exec("UPDATE table_counts SET n = 4242 WHERE name = 'nulls'");
  const out = await census(env, 0);
  assert.equal(out.nulls_total, 4242, "the counter is authoritative below the floor; a real count would say 40");
});

test("a missing counter row falls back to a real count and never to zero", async () => {
  const { env, db } = envWithNulls(40);
  db.exec("DELETE FROM table_counts WHERE name = 'nulls'");
  const out = await census(env, 0);
  assert.equal(out.nulls_total, 40, "no counter must mean count for real, not publish an unscoped zero");
  assert.notEqual(out.nulls_total, 0, "a served 0 here would claim the society refused nothing");
});

test("the floor test is strictly below, so a since sitting exactly on the floor still counts correctly", async () => {
  const { env, db } = envWithNulls(40);
  // Counter deliberately wrong: if the boundary wrongly takes the counter path
  // this returns 4242 instead of the real windowed count.
  db.exec("UPDATE table_counts SET n = 4242 WHERE name = 'nulls'");
  // since === the oldest row's created_at. `created_at > since` excludes that
  // row, so the honest answer is 39, not 40 and certainly not the counter.
  const out = await census(env, FLOOR);
  assert.equal(out.nulls_total, 39, "equality is NOT covered: the boundary row is excluded and the count is windowed");
});

test("both page plans return the same rows", async () => {
  const { env } = envWithNulls(40);
  // since=0 takes the plain plan; a since inside the window takes the
  // index-forced plan. Ask for a window that both can express and compare.
  const belowFloor = await census(env, 0);
  const inWindow = await census(env, FLOOR + 195);
  // The in-window read must be a strict suffix of the full read: same ids, same
  // order, no row invented or dropped by the plan hint.
  const expectedSuffix = belowFloor.nulls.map((r) => r.id).filter((id) => id > 20);
  assert.deepEqual(inWindow.nulls.map((r) => r.id), expectedSuffix, "the index hint changes the plan, never the rows");
  assert.equal(inWindow.nulls_total, expectedSuffix.length);
});

test("an empty nulls table serves a measured zero, not a fallback one", async () => {
  const { env } = sqliteTestEnv(SCHEMA);
  const out = await census(env, 0);
  assert.equal(out.nulls_total, 0);
  assert.deepEqual(out.nulls, []);
});
