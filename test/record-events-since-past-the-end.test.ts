// /api/record/:handle?events_since= is a row-id cursor over the identity
// log (filtered to one citizen). A millisecond epoch is all digits, so
// wholeNumber accepts it; left unguarded it sits past every real event id
// and the page is empty-complete — the same shape PR #228 closed on
// /api/events, measured live as
// GET /api/record/iris-fable?events_since=999999999 → 200 / events_returned 0 /
// events_has_more false / events_total 928. Event ids are global: a cursor
// between this citizen's last row and the table tip is exhausted-for-this-
// citizen, not past-the-end.
//
// Exhausted (events_since === newest id of identity_events) still serves
// empty-complete. One past the tip is 400 and names the unit.
//
// Worker test so the 400 is on the JSON. Killing mutation: drop the MAX(id)
// guard. record(…, 999999) goes green again; this file goes red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../src/index.ts";
import { SocietyError, type Env } from "../src/society.ts";
import { record } from "../src/record.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const ORIGIN = "https://1f916.ai";

function seeded(): Env {
  const { env, db } = sqliteTestEnv(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'dossier', 'test-model', 'h1', 100, 100),
           (2, 'other', 'test-model', 'h2', 100, 100);
    INSERT INTO identity_events (id, citizen_id, kind, detail, created_at, prev_hash, hash)
    VALUES (1, 1, 'key-bind', 'a', 100, NULL, 'h1'),
           (2, 2, 'key-bind', 'b', 200, 'h1', 'h2');
  `);
  return env as Env;
}

async function get(env: Env, path: string) {
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`), env);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("an exhausted events_since still serves empty-complete", async () => {
  const env = seeded();
  const page = await record(env, "dossier", 2);
  assert.equal(page.events_returned, 0);
  assert.equal(page.events_has_more, false);
});

test("one past the tip is refused and names the unit", async () => {
  const env = seeded();
  await assert.rejects(
    () => record(env, "dossier", 3),
    (e: unknown) =>
      e instanceof SocietyError &&
      e.status === 400 &&
      /events_since 3/.test(e.message) &&
      /newest event id \(2\)/.test(e.message) &&
      /not a timestamp/.test(e.message),
  );
});

test("GET /api/record/:handle?events_since=999999 SERVES the 400, not empty-complete", async () => {
  const { status, body } = await get(seeded(), "/api/record/dossier?events_since=999999");
  assert.equal(status, 400);
  assert.match(String(body.error), /events_since 999999/);
  assert.match(String(body.error), /newest event id \(2\)/);
  assert.match(String(body.error), /not a timestamp/);
  assert.equal(body.events, undefined);
});

test("GET /api/record/:handle?events_since=2 is exhausted, not refused", async () => {
  const { status, body } = await get(seeded(), "/api/record/dossier?events_since=2");
  assert.equal(status, 200);
  assert.equal(body.events_returned, 0);
  assert.equal(body.events_has_more, false);
});

test("past-the-end is judged against the identity_events table, not this citizen's latest", async () => {
  // dossier's only row is id 1; table tip is 2 (other's event). events_since=1
  // is exhausted-for-this-citizen (empty-complete), not a 400.
  const env = seeded();
  const page = await record(env, "dossier", 1);
  assert.equal(page.events_returned, 0);
  assert.equal(page.events_has_more, false);

  await assert.rejects(
    () => record(env, "dossier", 3),
    (e: unknown) =>
      e instanceof SocietyError &&
      e.status === 400 &&
      /newest event id \(2\)/.test(e.message),
  );
});
