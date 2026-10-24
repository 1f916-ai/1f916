// A binding settles once, across both settlement facts. The observer settles an
// award from an on-chain transfer without cutting a payout_receipts row, and
// createPayoutReceipt only checked payout_receipts for an earlier settlement.
// So a receipt filed after an observed settlement was recorded beside it: one
// binding, one award, two settlement facts, and GET /api/payout-bindings/:id
// switched to settled_by:"receipt" with the observed transfer hidden. The
// settler already refused the mirror order (a transfer already receipted,
// auditor P6); this pins the receipt side.
//
// Killing mutation: delete the observed_transfers guard in createPayoutReceipt
// -> the observed-settled binding gets past it to body validation, which
// refuses with a 400 rather than the 409 naming the observed transfer, and the
// first test goes red. The second test (an unsettled binding must NOT get that
// 409) keeps the guard from being written as a blanket refusal.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPayoutReceipt, SocietyError, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const TOKEN = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const ADDR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PAYEE = { id: 1, handle: "payee", model: "test-model" };

function bindRow(id: number, docket: string): string {
  // Column order matches schema.sql payout_bindings; wallet_signature set,
  // wallet_proof_id null (the one-proof CHECK). expiry far in the future.
  return `(${id}, 1, '${docket}', '1f916.payout.v1', '1000000', 8453, '${TOKEN}', '${ADDR}', 9999999999, '0xsig', NULL, 'pk', 'csig', 'tp-${id}', 'self', 100, 'valid-at-binding-event', 100, '{}', '2026-01-01', '{}', 'pre-${id}', 'ah-${id}', 'ph-${id}', 'cn-${id}', 200)`;
}

function seeded(): Env {
  const { env, db } = sqliteTestEnv(SCHEMA);
  // The settling observed transfer names an award row this test does not seed;
  // D1 does not enforce foreign keys, and the guard reads observed_transfers only.
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
    ) VALUES ${bindRow(2, "listing-91")}, ${bindRow(3, "listing-92")};
    -- Binding 2: its award settled by an observed transfer; no receipt row.
    INSERT INTO observed_transfers (funder_address, to_address, token, amount_atomic, tx_hash, log_index, block_number, kind, binding_id, listing_id, citizen_id, sources, observed_at, settled_award_id, settlement_checked_at, block_timestamp)
      VALUES ('${ADDR}', '${ADDR}', '${TOKEN}', '1000000', '0xobservedtx', 0, 51480102, 'payment', 2, 91, 1, 2, 100, 11, 100, 100);
    -- Binding 3: an observed payment the settler declined (settled_award_id null)
    -- is not a settlement, so it must not block a receipt.
    INSERT INTO observed_transfers (funder_address, to_address, token, amount_atomic, tx_hash, log_index, block_number, kind, binding_id, listing_id, citizen_id, sources, observed_at, settled_award_id, settlement_checked_at, block_timestamp)
      VALUES ('${ADDR}', '${ADDR}', '${TOKEN}', '1000000', '0xdeclinedtx', 0, 51480103, 'payment', 3, 92, 1, 2, 100, NULL, 100, 100);
  `);
  return env;
}

test("a receipt on a binding already settled by an observed transfer is refused 409, naming the transfer and award", async () => {
  await assert.rejects(
    createPayoutReceipt(seeded(), PAYEE as never, 2, {} as never),
    (e: SocietyError) => e.status === 409 && /settled by observed transfer 1 \(award 11\)/.test(e.message),
  );
});

test("a binding whose observed payment settled nothing is not refused by the observed-settlement guard", async () => {
  await assert.rejects(
    createPayoutReceipt(seeded(), PAYEE as never, 3, {} as never),
    (e: SocietyError) => !/settled by observed transfer/.test(e.message),
  );
});
