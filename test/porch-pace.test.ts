// The loop case zpk named on #1667 (c15610): a client paced at one line per
// 10 s is 360 lines/hour at steady state, and any rule that only restates
// that number in other units is not a brake. This test IS the loop: it fires
// the instant the porch allows, for two hours, and reports what it got.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SocietyError, type Citizen } from "../src/society.ts";
import { PORCH_LOOP_CEILING_PER_HOUR, PORCH_MIN_INTERVAL_MS, PORCH_PACE_STEP, porchGap, porchSay } from "../src/porch.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const migration = readFileSync(fileURLToPath(new URL("../migrations/0039_porch.sql", import.meta.url)), "utf8");

function porchEnv() {
  const { env, db } = sqliteTestEnv(schema + "\n" + migration);
  const now = Date.now();
  db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (?, ?, ?, ?, 0, ?, ?)").run(1032, "zpk", "test", "z", now, now);
  return { env, loop: { id: 1032, handle: "zpk" } as Citizen };
}

/** A loop that never stops choosing: say, and on 429 wait exactly the seconds the receipt names. */
async function runLoop(env: ReturnType<typeof porchEnv>["env"], who: Citizen, t0: number, hours: number) {
  const stamps: number[] = [];
  let t = t0;
  const end = t0 + hours * 3_600_000;
  while (t < end) {
    try {
      await porchSay(env, who, `loop ${stamps.length}`, false, t);
      stamps.push(t);
      t += 1; // fires again at once; the porch decides
    } catch (e) {
      if (!(e instanceof SocietyError) || e.status !== 429) throw e;
      const m = /(\d+)s to go/.exec(e.message);
      t += Number(m![1]) * 1000;
    }
  }
  return stamps;
}

test("a loop at the flat 10 s pace would be 360/hour; under progressive pace it gets under the stated ceiling", async () => {
  const { env, loop } = porchEnv();
  const t0 = Date.UTC(2026, 7, 23, 3, 0, 0);
  const stamps = await runLoop(env, loop, t0, 2);
  const hour1 = stamps.filter((s) => s < t0 + 3_600_000).length;
  const hour2 = stamps.filter((s) => s >= t0 + 3_600_000).length;
  // First thirty lines go at the flat pace: a real conversation never sees friction.
  // (The receipt rounds the wait up to whole seconds, so each gap is 10 s plus at most a second.)
  for (let i = 1; i < PORCH_PACE_STEP; i++) {
    const g = stamps[i] - stamps[i - 1];
    assert.ok(g >= PORCH_MIN_INTERVAL_MS && g < PORCH_MIN_INTERVAL_MS + 1000, `gap before line ${i}: ${g}`);
  }
  // The 31st waits twice as long as the 30th did.
  const g31 = stamps[PORCH_PACE_STEP] - stamps[PORCH_PACE_STEP - 1];
  assert.ok(g31 >= 2 * PORCH_MIN_INTERVAL_MS && g31 < 2 * PORCH_MIN_INTERVAL_MS + 1000, `gap before line 31: ${g31}`);
  assert.ok(hour1 < 360, `hour 1: ${hour1}`);
  assert.ok(hour2 <= PORCH_LOOP_CEILING_PER_HOUR, `steady state hour: ${hour2} > ${PORCH_LOOP_CEILING_PER_HOUR}`);
  // Printed so the number in the PR is the number the test saw, not a remembered one.
  console.log(`porch pace: loop got ${hour1} lines in hour 1, ${hour2} in hour 2 (flat pace would be 360)`);
});

test("the friction recovers as the hour drains", async () => {
  const { env, loop } = porchEnv();
  const t0 = Date.UTC(2026, 7, 23, 5, 0, 0);
  for (let i = 0; i < 2 * PORCH_PACE_STEP; i++) {
    await porchSay(env, loop, `burst ${i}`, false, t0 + i * 60_000);
  }
  const busy = await porchGap(env, loop.id, t0 + 60 * 60_000 - 1);
  assert.equal(busy.said_last_hour, 60);
  assert.equal(busy.gap, 3 * PORCH_MIN_INTERVAL_MS);
  const drained = await porchGap(env, loop.id, t0 + 2 * 60 * 60_000);
  assert.equal(drained.said_last_hour, 0);
  assert.equal(drained.gap, PORCH_MIN_INTERVAL_MS);
});
