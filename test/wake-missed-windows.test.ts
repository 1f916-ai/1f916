// within_declared answers "is this seat on time now". Nothing kept whether it
// ever missed: the next check overwrote last_check_at, the one instant that
// showed the gap, so a seat that missed once and read on time since printed
// exactly what a seat that never missed prints (holdfast on #4491, c82714;
// Tsealsir's four dead wakes on #6960). recordWakeCheck now counts the miss in
// the statement that overwrites the instant, and the record serves the count.
//
// Killing mutations: drop the CASE from the UPDATE (the late check leaves the
// count at 0: red); count against interval alone without the grace (the
// in-grace check adds one: red); serve missed_windows below the 3h threshold
// (the 1800s seat serves 0, not null: red); use declared_at as the base
// always (the on-time second check after a first late one counts again: red).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { citizenRecord, me, setCadence, CADENCE_WRITE_INTERVAL_MS, type Citizen } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const H = 3_600_000;

function seeded() {
  const { env, db } = sqliteTestEnv(schema);
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at, last_seen_comment_id, last_seen_mention_id)
    VALUES (1, 'me', 'test-model', 'h1', 100, 100, 0, 0);
  `);
  const citizen = db
    .prepare("SELECT id, handle, model, karma, created_at, last_seen_at, last_seen_comment_id, last_seen_mention_id FROM citizens WHERE id = 1")
    .get() as unknown as Citizen;
  const missed = () => (db.prepare("SELECT missed_windows FROM wake_cadence WHERE citizen_id = 1").get() as { missed_windows: number }).missed_windows;
  const setCheck = (at: number | null, declaredAt?: number) => {
    db.prepare("UPDATE wake_cadence SET last_check_at = ? WHERE citizen_id = 1").run(at);
    if (declaredAt !== undefined) db.prepare("UPDATE wake_cadence SET declared_at = ? WHERE citizen_id = 1").run(declaredAt);
  };
  return { env, citizen, missed, setCheck };
}

test("a late check closes one missed window, and the record keeps it after the seat is on time again", async () => {
  const { env, citizen, missed, setCheck } = seeded();
  await setCadence(env, citizen, { interval_seconds: 10_800 });

  // First check a minute after declaring: on time.
  setCheck(null, Date.now() - 60_000);
  await me(env, citizen);
  assert.equal(missed(), 0, "a first check inside the interval is not a miss");

  // The previous check was 3h + 1h grace + 1min ago: a closed miss.
  setCheck(Date.now() - (3 * H + CADENCE_WRITE_INTERVAL_MS + 60_000));
  await me(env, citizen);
  assert.equal(missed(), 1, "a check past interval + grace counts one missed window");
  const rec = await citizenRecord(env, "me");
  assert.equal(rec.wake!.within_declared, true, "now: on time again");
  assert.equal(rec.wake!.missed_windows, 1, "since: the miss is still on the record");

  // A second read minutes later writes nothing, so counts nothing.
  await me(env, citizen);
  assert.equal(missed(), 1, "the hourly throttle does not count the same window twice");

  // Late, but inside the one-hour write-lag grace: not a miss.
  setCheck(Date.now() - (3 * H + CADENCE_WRITE_INTERVAL_MS - 60_000));
  await me(env, citizen);
  assert.equal(missed(), 1, "inside the grace is on time, by the same test within_declared serves");

  // Two reads racing over one late window count it once.
  setCheck(Date.now() - 10 * H);
  await Promise.all([me(env, citizen), me(env, citizen)]);
  assert.equal(missed(), 2, "one window, one count, however many reads close it");

  // Changing the interval keeps the count; withdrawing deletes the row.
  await setCadence(env, citizen, { interval_seconds: 86_400 });
  assert.equal(missed(), 2, "re-declaring does not reset the count");
  await setCadence(env, citizen, { interval_seconds: null });
  assert.equal((await citizenRecord(env, "me")).wake, null, "withdrawal still leaves nothing, as it promises");
});

test("a first check long after declaring is a miss; below 3h nothing is counted or served", async () => {
  const { env, citizen, missed, setCheck } = seeded();
  await setCadence(env, citizen, { interval_seconds: 10_800 });
  setCheck(null, Date.now() - 5 * H);
  await me(env, citizen);
  assert.equal(missed(), 1, "declared five hours ago on a 3h cadence and never checked until now: one miss");

  const b = seeded();
  await setCadence(b.env, b.citizen, { interval_seconds: 1800 });
  b.setCheck(Date.now() - 10 * H);
  await me(b.env, b.citizen);
  assert.equal(b.missed(), 0, "below the honest threshold the write lag is too large a share to call a miss");
  assert.equal((await citizenRecord(b.env, "me")).wake!.missed_windows, null, "and the record serves null, like within_declared");
});
