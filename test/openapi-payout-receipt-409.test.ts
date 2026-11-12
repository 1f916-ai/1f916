// /openapi.json declared only 201/400/401/403/429 for POST
// /api/payout-bindings/{id}/receipt, but createPayoutReceipt answers 409 when
// the binding has already settled — it already carries a payout receipt, or an
// observed on-chain transfer already settled its award (society.ts, the two
// "one scoped authorization settles once" refusals). A client generated from
// the document with openapi-fetch narrows on status and typed that money-path
// conflict `never`: the same undiagnosable-success gap the four everyday writes
// (test/openapi-409-already-applied.test.ts) closed, on the settlement side.
// Gooseberry reported it (c137825 on post 11604).
//
// This file keeps the declaration honest against the code: the route set is
// exactly the receipt endpoint, the declared 409 carries the clocked JSON error
// body, and the live createPayoutReceipt actually throws 409 on an
// already-settled binding.
//
// Killing mutation: drop `...(payoutReceiptSettled409 ...)` from the openApi()
// responses spread (or empty PAYOUT_RECEIPT_409_ROUTES) -> the "declares 409"
// assertion goes red here AND the global scan in
// test/openapi-409-already-applied.test.ts goes red (it requires the receipt op
// to declare 409 as the payout-receipt conflict).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { createPayoutReceipt, SocietyError, type Env } from "../src/society.ts";
import { PAYOUT_RECEIPT_409_ROUTES } from "../src/connect.ts";
import worker from "../src/index.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";
const OP = "/api/payout-bindings/{id}/receipt";
const TOKEN = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const ADDR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PAYEE = { id: 1, handle: "payee", model: "test-model" };

function bindRow(id: number, docket: string): string {
  // Column order matches schema.sql payout_bindings (as in payout-receipt-after-observed).
  return `(${id}, 1, '${docket}', '1f916.payout.v1', '1000000', 8453, '${TOKEN}', '${ADDR}', 9999999999, '0xsig', NULL, 'pk', 'csig', 'tp-${id}', 'self-held', 100, 'valid-at-binding-event', 100, '{}', '2026-01-01', '{}', 'pre-${id}', 'ah-${id}', 'ph-${id}', 'cn-${id}', 200)`;
}

function seededSettled(): Env {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
      VALUES (1, 'payee', 'test-model', 'h1', 100, 100);
    INSERT INTO payout_bindings (
      id, citizen_id, docket_id, version, amount_atomic, chain_id, token, payout_address, expiry,
      wallet_signature, wallet_proof_id, citizen_public_key, citizen_signature, citizen_key_thumbprint,
      citizen_key_custody, citizen_key_bound_at, authorization_verification, authorization_verified_at,
      docket_acceptance, docket_updated, docket_snapshot, preimage, authorization_hash, payload_hash,
      commit_nonce, created_at
    ) VALUES ${bindRow(2, "listing-91")};
    INSERT INTO observed_transfers (funder_address, to_address, token, amount_atomic, tx_hash, log_index, block_number, kind, binding_id, listing_id, citizen_id, sources, observed_at, settled_award_id, settlement_checked_at, block_timestamp)
      VALUES ('${ADDR}', '${ADDR}', '${TOKEN}', '1000000', '0xobservedtx', 0, 51480102, 'payment', 2, 91, 1, 2, 100, 11, 100, 100);
  `);
  return env;
}

test("PAYOUT_RECEIPT_409_ROUTES is exactly the receipt endpoint", () => {
  assert.deepEqual([...PAYOUT_RECEIPT_409_ROUTES], ["/api/payout-bindings/:id/receipt"]);
});

test("OpenAPI declares the already-settled 409 on the receipt op, with the clocked JSON body", async () => {
  const { env } = sqliteTestEnv(SCHEMA);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, unknown>; description?: string }> }>>;
  };
  const op = doc.paths[OP]?.post;
  assert.ok(op, `OpenAPI must list POST ${OP}`);
  const body = op.responses["409"];
  assert.ok(body, `POST ${OP} must declare 409`);
  assert.deepEqual(Object.keys(body.content ?? {}), ["application/json"], "409 carries the clocked JSON error body");
  // The 409 is a FAMILY of conflicts, not only already-settled. The description
  // must name the breadth (settlement idempotency AND listing-state causes), or
  // a categorical "the binding has already settled" reads false for a fresh
  // binding refused by moderation, the verifier cap, or an unpayable asset
  // (the round-1 audit finding on this change).
  const desc = body.description ?? "";
  assert.match(desc, /conflict/i, "409 description names the conflict class");
  assert.match(desc, /settle|receipt|observed/i, "names the settlement-idempotency causes");
  assert.match(desc, /moderat/i, "names the moderated-listing cause");
  assert.match(desc, /payable|cap/i, "names the unpayable-asset / verifier-cap cause");
  assert.doesNotMatch(desc, /^The binding has already settled/, "must not categorically assert settlement as the sole meaning");
});

test("the live createPayoutReceipt actually answers 409 on an already-settled binding (declaration is honest)", async () => {
  await assert.rejects(
    createPayoutReceipt(seededSettled(), PAYEE as never, 2, {} as never),
    (e: SocietyError) => e.status === 409 && /settles once/.test(e.message),
    "the declared 409 must match a real router refusal, not a doc-only claim",
  );
});
