// The hold's step ceiling must cover the inner marks loop, not only the outer
// pulse rebuild. Date.now is a wall clock, not an elapsed-time guarantee.
// Synthetic timer/clock interleavings exercise the real Worker and native SQL;
// they are not evidence of a deployed clock incident or real-time benchmarks.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker, { PULSE_WAIT_MAX_S, PULSE_WAIT_STEP_MS } from "../src/index.ts";
import { pulseMarks } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const SCHEMA = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const START = Date.UTC(2026, 10, 6, 12);
const MAX_STEPS = Math.ceil(PULSE_WAIT_MAX_S * 1000 / PULSE_WAIT_STEP_MS) + 2;
const realNow = Date.now;
const realTimeout = globalThis.setTimeout;
const get = (env: Parameters<typeof worker.fetch>[1], query = "", tag?: string) =>
  worker.fetch(new Request(`https://1f916.ai/api/pulse${query}`, {
    headers: tag === undefined ? {} : { "If-None-Match": tag },
  }), env);

function fixture() {
  const { env, db } = sqliteTestEnv(SCHEMA);
  // No credentials or authenticated-read bookkeeping. The lower, unused row
  // is removable by the harness to model the existing marks-blind control.
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (2, 'spare-reader', 'fixture', 'unused-spare', ${START - 10000}, ${START - 10000}),
           (9, 'last-reader', 'fixture', 'unused-last', ${START - 10000}, ${START - 10000});`);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  db.exec("PRAGMA query_only = ON");
  assert.throws(() => db.exec("UPDATE citizens SET karma = 1"), /readonly/);
  return { env, db };
}

for (const mode of ["stalled", "backward"] as const) {
  test(`pulse hold is step-bounded with a ${mode} wall clock`, { timeout: 10000 }, async (t) => {
    const { env, db } = fixture();
    t.after(() => db.close());
    let now = START;
    let steps = 0;
    const delays: unknown[] = [];
    t.mock.method(Date, "now", () => now);
    t.mock.method(globalThis, "setTimeout", (callback: (...args: unknown[]) => void, delay: number, ...args: unknown[]) => {
      delays.push(delay);
      return realTimeout(() => {
        steps++;
        if (mode === "backward") now = START - 3600000 + steps * PULSE_WAIT_STEP_MS;
        // Safety valve for the UNFIXED handler: eventually advance its clock so
        // RED terminates normally, then fail on excess real handler sleeps.
        // The fixed handler must return before this valve is ever reached.
        if (steps > MAX_STEPS * 3) now = START + 60000;
        callback(...args);
      }, 0);
    });
    const before = db.prepare("SELECT * FROM citizens ORDER BY id").all();
    const first = await get(env);
    assert.equal(first.status, 200);
    const tag = first.headers.get("ETag")!;
    assert.ok(tag);
    const held = await get(env, "?wait=25", tag);
    assert.equal(held.status, 304);
    assert.equal(held.headers.get("ETag"), tag);
    assert.equal(held.headers.get("Cache-Control"), "no-store");
    assert.equal(await held.text(), "");
    assert.ok(steps > 0, "the hold really entered the timer/marks loop");
    assert.ok(steps <= MAX_STEPS, `at most ${MAX_STEPS} sleeps even without clock progress; got ${steps}`);
    assert.deepEqual(delays, Array(steps).fill(PULSE_WAIT_STEP_MS));
    assert.deepEqual(db.prepare("SELECT * FROM citizens ORDER BY id").all(), before);
  });
}

test("step-budget exhaustion rebuilds pulse before choosing 200 or 304", { timeout: 10000 }, async (t) => {
  const { env, db } = fixture();
  t.after(() => db.close());
  let now = START;
  let steps = 0;
  const delays: unknown[] = [];
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "setTimeout", (callback: (...args: unknown[]) => void, delay: number, ...args: unknown[]) => {
    delays.push(delay);
    return realTimeout(() => {
      steps++;
      if (steps === MAX_STEPS) {
        // Native harness-only deletion, as in pulse-hold-marks-gate.test.ts:
        // the maintained citizen total falls but the highest citizen id stays.
        db.exec("PRAGMA query_only = OFF; DELETE FROM citizens WHERE id = 2; PRAGMA query_only = ON;");
      }
      if (steps > MAX_STEPS * 3) now = START + 60000;
      callback(...args);
    }, 0);
  });
  const first = await get(env);
  assert.equal(first.status, 200);
  const tag = first.headers.get("ETag")!;
  const marks = await pulseMarks(env);
  const held = await get(env, "?wait=25", tag);
  assert.equal(await pulseMarks(env), marks, "the change really is invisible to the marks gate");
  assert.equal(held.status, 200, "fresh pulse must see the count change, not send the pre-wait 304");
  assert.notEqual(held.headers.get("ETag"), tag);
  const body = await held.json() as { board: { citizens: number } };
  assert.equal(body.board.citizens, 1);
  assert.equal(steps, MAX_STEPS, "exhaustion must return through the fresh-read path at the bound");
  assert.deepEqual(delays, Array(steps).fill(PULSE_WAIT_STEP_MS));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM citizens").get()!.n, 1);
  assert.equal(db.prepare("PRAGMA query_only").get()!.query_only, 1);
});

test("ordinary clocks, immediate reads, and first-step mark movement keep their behavior", { timeout: 10000 }, async (t) => {
  const { env, db } = fixture();
  t.after(() => db.close());
  let now = START;
  let steps = 0;
  let addOnStep = false;
  const delays: unknown[] = [];
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "setTimeout", (callback: (...args: unknown[]) => void, delay: number, ...args: unknown[]) => {
    delays.push(delay);
    return realTimeout(() => {
      steps++;
      now += PULSE_WAIT_STEP_MS;
      if (addOnStep) {
        addOnStep = false;
        db.exec(`PRAGMA query_only = OFF;
          INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
          VALUES (10, 'arriving-reader', 'fixture', 'unused-arrival', ${START}, ${START});
          PRAGMA query_only = ON;`);
      }
      callback(...args);
    }, 0);
  });
  const first = await get(env);
  assert.equal(first.status, 200);
  const tag = first.headers.get("ETag")!;
  for (const [query, supplied, status] of [
    ["?wait=25", undefined, 200],
    ["?wait=25", '"nonmatching"', 200],
    ["", tag, 304],
    ["?wait=0", tag, 304],
  ] as const) {
    assert.equal((await get(env, query, supplied)).status, status);
    assert.equal(steps, 0, "no wait without a match and positive budget");
  }
  for (const [query, expected] of [["?wait=4", 1], ["?wait=25", 8], ["?wait=100", 8]] as const) {
    steps = 0;
    const held = await get(env, query, tag);
    assert.equal(held.status, 304);
    assert.equal(held.headers.get("ETag"), tag);
    assert.equal(await held.text(), "");
    assert.equal(steps, expected, "ordinary clock reaches the original deadline before the structural cap");
  }
  steps = 0;
  addOnStep = true;
  const moved = await get(env, "?wait=25", tag);
  assert.equal(moved.status, 200);
  assert.equal(steps, 1, "a real changed mark still wakes on the first step");
  assert.notEqual(moved.headers.get("ETag"), tag);
  assert.equal((await moved.json() as { board: { citizens: number } }).board.citizens, 3);
  assert.ok(delays.every((delay) => delay === PULSE_WAIT_STEP_MS));
});

test("pulse timer and clock mocks are restored for the same-process successor", () => {
  assert.equal(Date.now, realNow);
  assert.equal(globalThis.setTimeout, realTimeout);
});
