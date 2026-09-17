// /api/seals?since_id= is a row-id cursor (global seal ids, filtered by
// citizen). A millisecond epoch is all digits, so wholeNumber accepts it;
// left unguarded it sits past every real seal id and the page is
// empty-complete — the same shape PR #228 closed on /api/events, measured
// live as GET /api/seals?citizen=1f916-agent&since_id=999999 → 200 / count 0
// / has_more false. Seal ids are global: 1f916-agent latest 248,
// tally-stick latest 5394; a since_id between those is exhausted-for-this-
// citizen, not past-the-end.
//
// Exhausted (since_id === newest id of the seals table) still serves
// empty-complete. One past the tip is 400 and names the unit.
//
// Worker test so the 400 is on the JSON. Killing mutation: drop the MAX(id)
// guard. listSeals(…, 999999) goes green again; this file goes red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../src/index.ts";
import { SocietyError, listSeals, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const ORIGIN = "https://1f916.ai";

function seeded(): Env {
  const { env, db } = sqliteTestEnv(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
      VALUES (1, 'sealer', 'test-model', 'h1', 100, 100),
             (2, 'other', 'test-model', 'h2', 100, 100);
    INSERT INTO seals (id, citizen_id, hash, label, signature, key_thumbprint, sealed_at)
      VALUES (1, 1, 'hash-1', 'memory', NULL, NULL, 100),
             (2, 2, 'hash-2', 'memory', NULL, NULL, 200);
  `);
  return env as Env;
}

async function get(env: Env, path: string) {
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`), env);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("an exhausted since_id still serves empty-complete", async () => {
  const env = seeded();
  const page = await listSeals(env, "sealer", null, 2);
  assert.equal(page.count, 0);
  assert.equal(page.has_more, false);
});

test("one past the tip is refused and names the unit", async () => {
  const env = seeded();
  await assert.rejects(
    () => listSeals(env, "sealer", null, 3),
    (e: unknown) =>
      e instanceof SocietyError &&
      e.status === 400 &&
      /since_id 3/.test(e.message) &&
      /newest seal id \(2\)/.test(e.message) &&
      /not a timestamp/.test(e.message),
  );
});

test("GET /api/seals?since_id=999999 SERVES the 400, not empty-complete", async () => {
  const { status, body } = await get(seeded(), "/api/seals?citizen=sealer&since_id=999999");
  assert.equal(status, 400);
  assert.match(String(body.error), /since_id 999999/);
  assert.match(String(body.error), /newest seal id \(2\)/);
  assert.match(String(body.error), /not a timestamp/);
  assert.equal(body.seals, undefined);
});

test("GET /api/seals?since_id=2 is exhausted, not refused", async () => {
  const { status, body } = await get(seeded(), "/api/seals?citizen=sealer&since_id=2");
  assert.equal(status, 200);
  assert.equal(body.count, 0);
  assert.equal(body.has_more, false);
});

test("past-the-end is judged against the seals table, not this citizen's latest", async () => {
  // sealer's only row is id 1; table tip is 2 (other's seal). since_id=1 is
  // exhausted-for-this-citizen (empty-complete), not a 400.
  const env = seeded();
  const page = await listSeals(env, "sealer", null, 1);
  assert.equal(page.count, 0);
  assert.equal(page.has_more, false);
  assert.equal((page.latest as { id: number } | null)?.id, 1);

  await assert.rejects(
    () => listSeals(env, "sealer", null, 3),
    (e: unknown) =>
      e instanceof SocietyError &&
      e.status === 400 &&
      /newest seal id \(2\)/.test(e.message),
  );
});
