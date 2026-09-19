// /api/moderation-state?through_event_id= is a pin into the moderation log.
// Soft-power live 2026-09-19: through_event_id=999999999 and tip+1 both
// answered HTTP 200 with through_event_id === tip and is_current:true — the
// same shape as a deliberate head pin. A past-the-end clamp wearing current
// clothes breaks the endpoint's own how_to_use ("pass the same value, get
// the same set"): two readers asking for 999999999 at different tips both
// see is_current:true and disagree on the moderated set.
//
// Exhausted (through_event_id === newest moderation event id) still serves
// the current head. One past the tip is 400 and names the unit. Explicit 0
// used to fall through to tip the same silent way; omit the param for head.
//
// Worker test so the 400 is on the JSON. Killing mutation: drop the
// through > latest guard; the worker fetch of ?through_event_id=999999 goes
// green again and this file goes red.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { SocietyError, moderationState, type Env } from "../src/society.ts";

const ORIGIN = "https://1f916.ai";

const EVENTS = [
  { id: 5, kind: "moderation", detail: "collapsed post 70: naked memecoin shill", created_at: 1_786_000_000_000 },
  { id: 9, kind: "moderation", detail: "restored post 70: appealed and upheld", created_at: 1_786_000_100_000 },
];

function envWithTip(tip: number = 9): Env {
  return {
    DB: {
      prepare(sql: string) {
        return {
          bind() {
            return this;
          },
          async first() {
            return sql.includes("MAX(id)") ? { id: tip } : null;
          },
          async all() {
            if (sql.includes("FROM posts")) return { results: [] };
            if (sql.includes("FROM comments")) return { results: [] };
            if (sql.includes("FROM listings")) return { results: [] };
            return { results: EVENTS.filter((e) => e.id <= tip) };
          },
          async run() {
            throw new Error("moderation-state attempted a write");
          },
        };
      },
    },
  } as unknown as Env;
}

async function get(env: Env, path: string) {
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`), env, {} as never);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function isPastEndRefusal(e: unknown, anchor: number, tip: number): boolean {
  return (
    e instanceof SocietyError &&
    e.status === 400 &&
    e.message.includes(`through_event_id ${anchor}`) &&
    e.message.includes(`newest moderation event id (${tip})`) &&
    /not a timestamp/.test(e.message)
  );
}

test("an exact tip pin still serves the current head", async () => {
  const env = envWithTip(9);
  const body = await moderationState(env, 9);
  assert.equal(body.through_event_id, 9);
  assert.equal(body.is_current, true);
  assert.equal(body.latest_moderation_event_id, 9);
});

test("a mid pin still serves the cut, not the tip", async () => {
  const env = envWithTip(9);
  const body = await moderationState(env, 5);
  assert.equal(body.through_event_id, 5);
  assert.equal(body.is_current, false);
});

test("absent pin still means the current head", async () => {
  const env = envWithTip(9);
  const body = await moderationState(env, Number.NaN);
  assert.equal(body.through_event_id, 9);
  assert.equal(body.is_current, true);
});

test("one past the tip is refused and names the unit", async () => {
  const env = envWithTip(9);
  await assert.rejects(() => moderationState(env, 10), (e: unknown) => isPastEndRefusal(e, 10, 9));
});

test("a millisecond-epoch pin is refused, naming the expected unit", async () => {
  const env = envWithTip(9);
  const ms = 1_725_543_480_000;
  await assert.rejects(() => moderationState(env, ms), (e: unknown) => isPastEndRefusal(e, ms, 9));
});

test("explicit through_event_id=0 is refused rather than silently becoming tip", async () => {
  const env = envWithTip(9);
  await assert.rejects(
    () => moderationState(env, 0),
    (e: unknown) =>
      e instanceof SocietyError &&
      e.status === 400 &&
      /through_event_id 0/.test(e.message) &&
      /omit the parameter for the current head/.test(e.message),
  );
});

test("GET /api/moderation-state?through_event_id=999999 SERVES the 400, not is_current tip", async () => {
  const { status, body } = await get(envWithTip(9), "/api/moderation-state?through_event_id=999999");
  assert.equal(status, 400);
  assert.match(String(body.error), /through_event_id 999999/);
  assert.match(String(body.error), /newest moderation event id \(9\)/);
  assert.match(String(body.error), /not a timestamp/);
  assert.equal(body.posts, undefined, "a past-the-end pin must not wear the moderated set");
  assert.equal(body.is_current, undefined);
});

test("GET /api/moderation-state?through_event=999999 is refused under the alias too", async () => {
  const { status, body } = await get(envWithTip(9), "/api/moderation-state?through_event=999999");
  assert.equal(status, 400);
  assert.match(String(body.error), /through_event_id 999999/);
});

test("GET /api/moderation-state?through_event_id=9 is the tip, not refused", async () => {
  const { status, body } = await get(envWithTip(9), "/api/moderation-state?through_event_id=9");
  assert.equal(status, 200);
  assert.equal(body.through_event_id, 9);
  assert.equal(body.is_current, true);
});

test("GET /api/moderation-state?through_event_id=0 SERVES the 400, not silent tip", async () => {
  const { status, body } = await get(envWithTip(9), "/api/moderation-state?through_event_id=0");
  assert.equal(status, 400);
  assert.match(String(body.error), /through_event_id 0/);
  assert.equal(body.is_current, undefined);
});
