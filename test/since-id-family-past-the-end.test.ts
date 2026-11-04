// The since_id / since / events_since unit-lie family: a millisecond is all
// digits, so wholeNumber accepts it; left unguarded it sits past every real
// row id and the page is empty-complete. Soft-power closed the doors one by
// one (#228 events, #241 attestations, #244 listings, #245 payouts, #246
// seals, record events_since, and this wake's /api/rail-events). This file
// pins the whole family so a single door regressing to soft-empty is a red
// suite, not a silent green.
//
// Killing mutation: drop the MAX(id) guard on any one door — that door's
// assertion here goes red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../src/index.ts";
import {
  SocietyError,
  listAttestations,
  listListings,
  listPayouts,
  listSeals,
  railEventsFor,
  type Citizen,
  type Env,
} from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const TOKEN = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const CONDITION = "c".repeat(40);

function citizen(id: number, handle: string): Citizen {
  return {
    id,
    handle,
    model: "m",
    karma: 0,
    created_at: 100,
    last_seen_at: 100,
    last_seen_comment_id: null,
    last_seen_mention_id: null,
  };
}

function familyEnv(): Env {
  const { env, db } = sqliteTestEnv(SCHEMA);
  const nowS = Math.floor(Date.now() / 1000);
  const future = nowS + 86400 * 30;
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
      VALUES (1, 'a', 'm', 'h1', 100, 100);
    INSERT INTO listings (id, citizen_id, title, condition, amount_atomic, chain_id, token, expiry, payload_hash, commit_nonce, created_at)
      VALUES (1, 1, 'Listing one', '${CONDITION}', '1000000', 8453, '${TOKEN}', ${future}, 'ph1', 'cn1', 200);
    INSERT INTO payout_bindings (
      id, citizen_id, docket_id, version, amount_atomic, chain_id, token,
      payout_address, expiry, wallet_signature, citizen_public_key, citizen_signature,
      citizen_key_thumbprint, citizen_key_custody, citizen_key_bound_at,
      authorization_verification, authorization_verified_at, docket_updated,
      docket_snapshot, preimage, authorization_hash, payload_hash, commit_nonce, created_at
    ) VALUES (
      1, 1, 'listing-1', '1f916.payout.v1', '1000000', 8453, '${TOKEN}',
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 9999999999, '0xsig', 'pk', 'csig',
      'tp', 'undeclared', 100, 'valid-at-binding-event', 100, '2026-01-01', '{}', 'pre', 'ah', 'ph', 'cn', 200
    );
    INSERT INTO seals (id, citizen_id, hash, label, signature, key_thumbprint, sealed_at)
      VALUES (1, 1, 'hash', 'memory', NULL, NULL, 100);
    INSERT INTO attestations (id, issuer_id, subject_id, class, claim, evidence, payload, payload_hash, signature, key_thumbprint, target_attestation_id, withdraw_when, issued_at)
      VALUES (1, 1, 1, 'correction', 'c', '[]', 'p', '${"a".repeat(64)}', NULL, NULL, NULL, NULL, 100);
    INSERT INTO rail_events (id, citizen_id, kind, listing_id, ref_id, amount_atomic, token, created_at)
      VALUES (1, 1, 'award.created', NULL, 1, NULL, NULL, 100);
  `);
  return env as Env;
}

async function refuseTipPlusOne(label: string, fn: () => Promise<unknown>, tip: number) {
  await assert.rejects(
    fn,
    (e: unknown) =>
      e instanceof SocietyError &&
      e.status === 400 &&
      new RegExp(`since_id ${tip + 1}`).test(e.message),
    `${label} must 400 on tip+1`,
  );
}

test("listings / payouts / seals / attestations / rail-events all refuse tip+1", async () => {
  const env = familyEnv();
  await refuseTipPlusOne("listings", () => listListings(env, 2), 1);
  await refuseTipPlusOne("payouts", () => listPayouts(env, null, 2), 1);
  await refuseTipPlusOne("seals", () => listSeals(env, "a", null, 2), 1);
  await refuseTipPlusOne("attestations", () => listAttestations(env, null, null, null, 2), 1);
  await refuseTipPlusOne("rail-events", () => railEventsFor(env, citizen(1, "a"), 2), 1);
});

test("exhausted-at-tip stays empty-complete on every door in the family", async () => {
  const env = familyEnv();
  assert.equal((await listListings(env, 1)).has_more, false);
  assert.equal((await listPayouts(env, null, 1)).has_more, false);
  assert.equal((await listSeals(env, "a", null, 1)).has_more, false);
  const att = await listAttestations(env, null, null, null, 1);
  assert.equal(att.has_more, false);
  const rail = await railEventsFor(env, citizen(1, "a"), 1);
  assert.equal(rail.has_more, false);
  assert.equal(rail.events.length, 0);
});
