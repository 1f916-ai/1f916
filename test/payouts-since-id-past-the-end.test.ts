// /api/payouts?since_id= is a row-id cursor. A millisecond epoch is all
// digits, so wholeNumber accepts it; left unguarded it sits past every real
// payout binding id and the page is empty-complete — the same shape PR #228
// closed on /api/events, PR #241 on /api/attestations, and PR #244 on
// /api/listings, measured live as GET /api/payouts?since_id=999999 → 200 /
// bindings [] / has_more false (tip 289 exhausted 200; tip+1 still 200).
// This feed actually pages (PAYOUT_PAGE = 50), so a walker that treats a
// unix-ms since_id as caught-up stops mid-log.
//
// Exhausted (since_id === newest id) still serves empty-complete. One past
// the tip is 400 and names the unit. The ceiling is MAX(id) of
// payout_bindings, not a docket filter's subset.
//
// Worker test so the 400 is on the JSON. Killing mutation: drop the MAX(id)
// guard. listPayouts(…, 999999) goes green again; this file goes red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../src/index.ts";
import { SocietyError, listPayouts, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const ORIGIN = "https://1f916.ai";
const TOKEN = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const ADDR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

// citizen_key_custody seeds 'undeclared', not 'self': since migration 0057
// 'self' is legacy-only in payout_bindings (kept by the migration for rows
// written before it, refused by a fresh schema.sql), and this file builds
// from schema.sql. 'undeclared' is what 0057 gives every historical bind.
function bindSql(id: number, docket: string): string {
  return `(${id}, 1, '${docket}', '1f916.payout.v1', '1000000', 8453, '${TOKEN}', '${ADDR}', 9999999999, '0xsig', 'pk', 'csig', 'tp-${id}', 'undeclared', 100, 'valid-at-binding-event', 100, '2026-01-01', '{}', 'pre-${id}', 'ah-${id}', 'ph-${id}', 'cn-${id}', 200)`;
}

function seeded(): Env {
  const { env, db } = sqliteTestEnv(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
      VALUES (1, 'payee', 'test-model', 'h1', 100, 100);
    INSERT INTO payout_bindings (
      id, citizen_id, docket_id, version, amount_atomic, chain_id, token,
      payout_address, expiry, wallet_signature, citizen_public_key, citizen_signature,
      citizen_key_thumbprint, citizen_key_custody, citizen_key_bound_at,
      authorization_verification, authorization_verified_at, docket_updated,
      docket_snapshot, preimage, authorization_hash, payload_hash, commit_nonce, created_at
    ) VALUES
      ${bindSql(1, "identity-influence")},
      ${bindSql(2, "identity-influence")};
  `);
  return env as Env;
}

async function get(env: Env, path: string) {
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`), env);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("an exhausted since_id still serves empty-complete", async () => {
  const env = seeded();
  const page = await listPayouts(env, null, 2);
  assert.equal(page.returned, 0);
  assert.equal(page.has_more, false);
});

test("one past the tip is refused and names the unit", async () => {
  const env = seeded();
  await assert.rejects(
    () => listPayouts(env, null, 3),
    (e: unknown) =>
      e instanceof SocietyError &&
      e.status === 400 &&
      /since_id 3/.test(e.message) &&
      /newest payout binding id \(2\)/.test(e.message) &&
      /not a timestamp/.test(e.message),
  );
});

test("GET /api/payouts?since_id=999999 SERVES the 400, not empty-complete", async () => {
  const { status, body } = await get(seeded(), "/api/payouts?since_id=999999");
  assert.equal(status, 400);
  assert.match(String(body.error), /since_id 999999/);
  assert.match(String(body.error), /newest payout binding id \(2\)/);
  assert.match(String(body.error), /not a timestamp/);
  assert.equal(body.bindings, undefined);
});

test("GET /api/payouts?since_id=2 is exhausted, not refused", async () => {
  const { status, body } = await get(seeded(), "/api/payouts?since_id=2");
  assert.equal(status, 200);
  assert.equal(body.returned, 0);
  assert.equal(body.has_more, false);
});

test("past-the-end is judged against payout_bindings, not a docket filter", async () => {
  // Filter names a real docket with no rows. since_id === table tip is still
  // exhausted (empty-complete), not a 400. One past MAX(id) is refused on
  // both the firehose and the filter.
  const env = seeded();
  const filtered = await listPayouts(env, "claims-need-events", 2);
  assert.equal(filtered.returned, 0);
  assert.equal(filtered.has_more, false);

  await assert.rejects(
    () => listPayouts(env, "claims-need-events", 3),
    (e: unknown) =>
      e instanceof SocietyError &&
      e.status === 400 &&
      /newest payout binding id \(2\)/.test(e.message),
  );
});
