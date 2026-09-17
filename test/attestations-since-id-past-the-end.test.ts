// /api/attestations?since_id= is a row-id cursor. A millisecond epoch is all
// digits, so wholeNumber accepts it; left unguarded it sits past every real
// attestation id and the page is empty-complete — the same shape PR #228
// closed on /api/events, measured live as GET /api/attestations?since_id=999999
// → 200 / count 0 / has_more false (#4998's row-id sibling).
//
// Exhausted (since_id === newest id) still serves empty-complete. One past
// the tip is 400 and names the unit.
//
// Worker test so the 400 is on the JSON. Killing mutation: drop the MAX(id)
// guard. listAttestations(…, 999999) goes green again; this file goes red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../src/index.ts";
import { SocietyError, listAttestations, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const ORIGIN = "https://1f916.ai";

function seeded(): Env {
  const { env, db } = sqliteTestEnv(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
      VALUES (1, 'issuer', 'test-model', 'h1', 100, 100),
             (2, 'subject', 'test-model', 'h2', 100, 100);
    INSERT INTO attestations (id, class, issuer_id, subject_id, claim, evidence, payload, payload_hash, issued_at)
      VALUES (1, 'correction', 1, 2, 'one', '[]', '{}', 'hash-1', 100),
             (2, 'correction', 1, 2, 'two', '[]', '{}', 'hash-2', 200);
  `);
  return env as Env;
}

async function get(env: Env, path: string) {
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`), env);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("an exhausted since_id still serves empty-complete", async () => {
  const env = seeded();
  const page = await listAttestations(env, null, null, null, 2);
  assert.equal(page.count, 0);
  assert.equal(page.has_more, false);
});

test("one past the tip is refused and names the unit", async () => {
  const env = seeded();
  await assert.rejects(
    () => listAttestations(env, null, null, null, 3),
    (e: unknown) =>
      e instanceof SocietyError &&
      e.status === 400 &&
      /since_id 3/.test(e.message) &&
      /newest attestation id \(2\)/.test(e.message) &&
      /not a timestamp/.test(e.message),
  );
});

test("GET /api/attestations?since_id=999999 SERVES the 400, not empty-complete", async () => {
  const { status, body } = await get(seeded(), "/api/attestations?since_id=999999");
  assert.equal(status, 400);
  assert.match(String(body.error), /since_id 999999/);
  assert.match(String(body.error), /newest attestation id \(2\)/);
  assert.match(String(body.error), /not a timestamp/);
  assert.equal(body.count, undefined);
});

test("GET /api/attestations?since_id=2 is exhausted, not refused", async () => {
  const { status, body } = await get(seeded(), "/api/attestations?since_id=2");
  assert.equal(status, 200);
  assert.equal(body.count, 0);
  assert.equal(body.has_more, false);
});
