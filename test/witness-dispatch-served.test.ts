// The witness dispatch leg failed for 53 hours with the only record a Worker
// console line (xinren, post 1264). priors (post 1268) named the cost: a
// static "every five minutes" description let a stale citation expire quietly
// instead of visibly. This covers the replacement: every dispatch attempt is
// written to one D1 row, and GET /api/checkpoint serves the outcome with ages
// computed at render time, so the surface cannot disagree with the record.
//
// The recorder runs against real SQLite (node:sqlite via the shared helper),
// not a hand-rolled stub, so the upsert's COALESCE is itself under guard — a
// stub that reimplements the SQL in JS stays green when the SQL regresses.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readWitnessDispatch, recordWitnessDispatch, witnessDispatchView, type WitnessDispatchRow } from "../src/checkpoint.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const MIGRATION = readFileSync(join(import.meta.dirname, "..", "migrations", "0034_witness_dispatch.sql"), "utf8");

test("a 2xx attempt records both the attempt and the success instant", async () => {
  const { env } = sqliteTestEnv(MIGRATION);
  await recordWitnessDispatch(env, 1000, 204, null);
  assert.deepEqual({ ...(await readWitnessDispatch(env)) }, { last_attempt_at: 1000, last_status: 204, last_error: null, last_ok_at: 1000 });
});

test("a failing attempt advances the attempt but preserves the last success", async () => {
  const { env } = sqliteTestEnv(MIGRATION);
  await recordWitnessDispatch(env, 1000, 204, null);
  await recordWitnessDispatch(env, 61_000, 401, null);
  assert.deepEqual({ ...(await readWitnessDispatch(env)) }, { last_attempt_at: 61_000, last_status: 401, last_error: null, last_ok_at: 1000 });
});

test("a thrown fetch as the first-ever row inserts cleanly with no success instant", async () => {
  const { env } = sqliteTestEnv(MIGRATION);
  await recordWitnessDispatch(env, 5000, null, "TypeError: fetch failed");
  assert.deepEqual({ ...(await readWitnessDispatch(env)) }, { last_attempt_at: 5000, last_status: null, last_error: "TypeError: fetch failed", last_ok_at: null });
});

test("a recovery after failures moves last_ok_at forward and clears the error", async () => {
  const { env } = sqliteTestEnv(MIGRATION);
  await recordWitnessDispatch(env, 1000, 204, null);
  await recordWitnessDispatch(env, 61_000, null, "TypeError: fetch failed");
  await recordWitnessDispatch(env, 121_000, 204, null);
  assert.deepEqual({ ...(await readWitnessDispatch(env)) }, { last_attempt_at: 121_000, last_status: 204, last_error: null, last_ok_at: 121_000 });
});

test("a missing table reads as nothing-recorded, never a throw — /api/checkpoint must not 500 in the code-before-migration window", async () => {
  const { env } = sqliteTestEnv("-- no witness_dispatch table");
  assert.equal(await readWitnessDispatch(env), null);
});

test("the view computes ages at render time, from the row, never stored", () => {
  const row: WitnessDispatchRow = { last_attempt_at: 61_000, last_status: 401, last_error: null, last_ok_at: 1000 };
  const v = witnessDispatchView(row, 121_000);
  assert.equal(v.recorded, true);
  assert.equal(v.last_attempt_age_seconds, 60);
  assert.equal(v.last_ok_age_seconds, 120);
  // A failing latest attempt must say so and must not read as healthy.
  assert.match(v.note ?? "", /FAILED/);
  // Same row, later render: the age moves with the clock, so a stale figure
  // cannot survive a render cycle.
  assert.equal(witnessDispatchView(row, 181_000).last_ok_age_seconds, 180);
});

test("a healthy latest attempt still refuses to claim a witness line landed", () => {
  const v = witnessDispatchView({ last_attempt_at: 1000, last_status: 204, last_error: null, last_ok_at: 1000 }, 2000);
  assert.doesNotMatch(v.note ?? "", /FAILED/);
  assert.match(v.note ?? "", /does not prove a witness line landed/);
});

test("no row yet is served as an explicit absence, not silence", () => {
  const v = witnessDispatchView(null, 1000);
  assert.equal(v.recorded, false);
  assert.match(v.note ?? "", /no dispatch attempt recorded yet/);
});
