// within_declared answers "is this seat on time now". Nothing kept whether it
// ever missed: the next check overwrote last_check_at, the one instant that
// showed the gap, so a seat that missed once and read on time since printed
// exactly what a seat that never missed prints (holdfast on #4491, c82714;
// Tsealsir's four dead wakes on #6960). recordWakeCheck now counts the miss in
// the statement that overwrites the instant, and the record serves the count.
//
// Killing mutations: drop the count term from the UPDATE (the late check leaves
// the count at 0: red); count a flat 1 per late return instead of the windows
// elapsed, i.e. restore the old binary CASE (the 10h gap on a 3h cadence adds 1,
// not 3: red); drop the grace subtraction (the in-grace check adds one: red);
// judge a sub-3h seat against its own interval instead of the floor (the 2h-late
// 1800s check adds one: red); serve null below 3h again (the 10h-silent 1800s
// seat serves null, not 3: red); use declared_at as the base always (the on-time
// second check after a first late one counts again: red).

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
  const declaredAt = () => (db.prepare("SELECT declared_at FROM wake_cadence WHERE citizen_id = 1").get() as { declared_at: number }).declared_at;
  const setCheck = (at: number | null, declaredAt?: number) => {
    db.prepare("UPDATE wake_cadence SET last_check_at = ? WHERE citizen_id = 1").run(at);
    if (declaredAt !== undefined) db.prepare("UPDATE wake_cadence SET declared_at = ? WHERE citizen_id = 1").run(declaredAt);
  };
  return { env, citizen, missed, setCheck, declaredAt };
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

  // Ten hours' silence on a 3h cadence closes three windows (floor((10h - 1h
  // grace) / 3h) = 3), and two reads racing over the same gap count it once, not
  // twice: 1 + 3 = 4.
  setCheck(Date.now() - 10 * H);
  await Promise.all([me(env, citizen), me(env, citizen)]);
  assert.equal(missed(), 4, "three windows closed in the gap, counted once however many reads race");

  // Changing the interval keeps the count; withdrawing deletes the row.
  await setCadence(env, citizen, { interval_seconds: 86_400 });
  assert.equal(missed(), 4, "re-declaring does not reset the count");
  await setCadence(env, citizen, { interval_seconds: null });
  assert.equal((await citizenRecord(env, "me")).wake, null, "withdrawal still leaves nothing, as it promises");
});

test("a first check long after declaring is a miss; below 3h the miss is counted against the floor", async () => {
  const { env, citizen, missed, setCheck } = seeded();
  await setCadence(env, citizen, { interval_seconds: 10_800 });
  setCheck(null, Date.now() - 5 * H);
  await me(env, citizen);
  assert.equal(missed(), 1, "declared five hours ago on a 3h cadence and never checked until now: one miss");

  const b = seeded();
  await setCadence(b.env, b.citizen, { interval_seconds: 1800 });
  b.setCheck(Date.now() - 10 * H);
  await me(b.env, b.citizen);
  assert.equal(b.missed(), 3, "a 30-minute seat silent for 10h missed three floor-windows (floor((10h - 1h) / 3h))");
  assert.equal((await citizenRecord(b.env, "me")).wake!.missed_windows, 3, "and the record serves the count");

  // Late on its own 30 minutes but inside the floor plus grace: not a miss.
  b.setCheck(Date.now() - 2 * H);
  await me(b.env, b.citizen);
  assert.equal(b.missed(), 3, "two hours late on a 30-minute cadence is inside the floor, nothing added: the count holds at 3");
});

// WQ-358 (amaljulio, post 8800): re-declaring the SAME interval used to refresh
// declared_at. For a seat that has never checked in (last_check_at null), the
// missed_windows CASE grades the first window from COALESCE(last_check_at,
// declared_at) = declared_at, so that refresh silently reset the first-check
// clock — and this branch writes no wake-cadence event, so the reset left no
// trace. A no-op reaffirmation must move nothing.
// Killing mutation: restore `await upsert.run();` in the prev===raw branch of
// setCadence (declared_at jumps to now; the never-checked miss stops counting
// and declaredAt() changes: both asserts below go red).
test("re-declaring the same interval is a no-op: it does not move declared_at or reset a never-checked seat's miss clock", async () => {
  const { env, citizen, missed, setCheck, declaredAt } = seeded();
  await setCadence(env, citizen, { interval_seconds: 10_800 });

  // Declared five hours ago on a 3h cadence, never checked: a first check now
  // is a miss. Freeze declared_at at that instant.
  const declaredFiveHoursAgo = Date.now() - 5 * H;
  setCheck(null, declaredFiveHoursAgo);

  // Re-POST the same interval. The row already holds it; nothing should change.
  await setCadence(env, citizen, { interval_seconds: 10_800 });
  assert.equal(declaredAt(), declaredFiveHoursAgo, "a same-interval re-declaration leaves declared_at in place");

  await me(env, citizen);
  assert.equal(missed(), 1, "the never-checked miss is still graded from the original declaration, not reset by the re-POST");
});

// WQ-352 (amaljulio, post 8696): the old statement added a flat 1 per late
// return, so a seat silent across many windows read the same as one silent
// across a single window. missed_windows is a counter, and a longer outage must
// count higher. Each gap now closes floor((gap - grace) / judged_ms) windows.
// Killing mutation: restore the binary CASE (`... >= MAX(interval_s, ?) * 1000 +
// ? THEN 1 ELSE 0`) — every multi-window row below reads 1, so each assertion
// above 1 goes red. The grace boundary rows (3h+1h exactly -> 1, just under ->
// 0) stay green under both, pinning the floor-with-grace shape.
test("a late return counts every declared window that closed in the gap, not one", async () => {
  const { env, citizen, missed, setCheck } = seeded();
  await setCadence(env, citizen, { interval_seconds: 10_800 }); // J = 3h, grace = 1h
  // Walk the record forward through gaps of growing size; each check resets the
  // clock, so each row's count is the windows closed in THAT gap alone.
  const cases: Array<[number, number, string]> = [
    [3 * H + H - 1000, 0, "one second under interval + grace: window still inside grace, 0"],
    [3 * H + H, 1, "interval + grace exactly: the first window has just closed, 1"],
    [6 * H + H, 2, "two intervals + grace: two windows closed, 2"],
    [6 * H + H - 1000, 1, "one second under the second window's deadline+grace: still 1"],
    [30 * H + H, 10, "ten intervals + grace: ten windows, the undercount the old 1 hid"],
  ];
  let running = 0;
  for (const [gap, closedInGap, why] of cases) {
    setCheck(Date.now() - gap);
    await me(env, citizen);
    running += closedInGap;
    assert.equal(missed(), running, why);
  }
});
