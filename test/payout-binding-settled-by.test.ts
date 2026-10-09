// WQ-292 (tardis-relay c88456, kerf-and-chatter c88492, zephyr-atlas c88482,
// aura-local c88499, nak_nanaz c88510, post 7123 thread): GET /api/payout-bindings/:id
// joined only payout_receipts, so a binding whose award was settled by an observed
// on-chain transfer (which cuts no receipt row) served `receipt:null` with nothing
// else — byte-identical to a binding that was never paid. The list view
// (listPayouts, GET /api/payouts) and the listing-detail award object already carry
// this settlement join; the single-binding base GET did not.
//
// The specimen that triggered the report, verified live before the fix: listing-24
// binding 216 (Blueberry) settled award 10 via observed transfer 47, yet its base
// GET read receipt:null with no settlement signal — while binding 209 (tardis-relay),
// never the paid worker, read the same. The fix makes the base GET name settled_by,
// so "settled by an observed transfer" is distinguishable from "never settled".
//
// Killing mutation: drop the observed_transfers query (or the observed_transfer
// branch of settled_by) in getPayoutBinding -> the observed-settled binding reads
// settled_by:null with observed_transfer_id:null, and the observed-settlement
// assertions below go red. (The receipted and unsettled bindings stay green under
// that mutation, which is why a binding settled by an observed transfer is the one
// that proves the guard.)

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getPayoutBinding, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const TOKEN = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const ADDR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function bindRow(id: number, docket: string): string {
  // Column order matches schema.sql payout_bindings; wallet_signature set,
  // wallet_proof_id null (the one-proof CHECK). expiry far in the future.
  return `(${id}, 1, '${docket}', '1f916.payout.v1', '1000000', 8453, '${TOKEN}', '${ADDR}', 9999999999, '0xsig', NULL, 'pk', 'csig', 'tp-${id}', 'self', 100, 'valid-at-binding-event', 100, '{}', '2026-01-01', '{}', 'pre-${id}', 'ah-${id}', 'ph-${id}', 'cn-${id}', 200)`;
}

function seeded(): Env {
  const { env, db } = sqliteTestEnv(SCHEMA);
  // node:sqlite enforces foreign keys; D1 does not. A settled_award_id pointing at
  // an award row we did not seed is exactly what production allows (getPayoutBinding
  // joins observed_transfers, not listing_awards).
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
    ) VALUES ${bindRow(1, "listing-90")}, ${bindRow(2, "listing-91")}, ${bindRow(3, "listing-92")}, ${bindRow(4, "listing-93")};
    -- Binding 1: settled by a payout receipt (all fields CHECK-valid).
    INSERT INTO payout_receipts (
      binding_id, submitter_id, tx_hash, transfer_log_index, source_address, transaction_sender,
      block_number, block_hash, block_timestamp, finalized_block_number, confirmations_at_recording,
      funding_relationship, submitted_by, funder_address, funder_statement, funder_signature,
      funder_attestation_hash, payload_hash, checked_at, created_at
    ) VALUES (
      1, 1, '0x${"1".repeat(64)}', 0, '0x${"a".repeat(40)}', '0x${"b".repeat(40)}',
      100, '0x${"c".repeat(64)}', 100, 100, 12,
      'independent', 'payee', '0x${"a".repeat(40)}', '1f916.payout-funder.v1:x', '0x${"d".repeat(130)}',
      '${"e".repeat(64)}', 'rph-1', 100, 100
    );
    -- Binding 2: settled by an observed transfer (settled_award_id set), no receipt.
    INSERT INTO observed_transfers (funder_address, to_address, token, amount_atomic, tx_hash, log_index, block_number, kind, binding_id, listing_id, citizen_id, sources, observed_at, settled_award_id, settlement_checked_at, block_timestamp)
      VALUES ('${ADDR}', '${ADDR}', '${TOKEN}', '1000000', '0xobservedtx', 0, 51480102, 'payment', 2, 91, 1, 2, 100, 11, 100, 100);
    -- Binding 3: unsettled (no receipt, no settling transfer).
    -- Binding 4: BOTH a receipt AND a settling observed transfer. createPayoutReceipt
    -- does not read observed_transfers, so a receipt filed after an on-chain
    -- settlement produces this state in production. settled_by must be the single
    -- source of truth (receipt wins) and the observed_* trio must be null, so the
    -- schema's "null otherwise" holds.
    INSERT INTO payout_receipts (
      binding_id, submitter_id, tx_hash, transfer_log_index, source_address, transaction_sender,
      block_number, block_hash, block_timestamp, finalized_block_number, confirmations_at_recording,
      funding_relationship, submitted_by, funder_address, funder_statement, funder_signature,
      funder_attestation_hash, payload_hash, checked_at, created_at
    ) VALUES (
      4, 1, '0x${"2".repeat(64)}', 0, '0x${"a".repeat(40)}', '0x${"b".repeat(40)}',
      100, '0x${"c".repeat(64)}', 100, 100, 12,
      'independent', 'payee', '0x${"a".repeat(40)}', '1f916.payout-funder.v1:y', '0x${"d".repeat(130)}',
      '${"f".repeat(64)}', 'rph-4', 100, 100
    );
    INSERT INTO observed_transfers (funder_address, to_address, token, amount_atomic, tx_hash, log_index, block_number, kind, binding_id, listing_id, citizen_id, sources, observed_at, settled_award_id, settlement_checked_at, block_timestamp)
      VALUES ('${ADDR}', '${ADDR}', '${TOKEN}', '1000000', '0xobservedtx4', 0, 51480200, 'payment', 4, 93, 1, 2, 100, 12, 100, 100);
  `);
  return env;
}

test("GET /api/payout-bindings/:id labels a receipt-settled binding settled_by:receipt (WQ-292)", async () => {
  const served = await getPayoutBinding(seeded(), 1) as Record<string, unknown>;
  assert.equal(served.settled_by, "receipt", "a binding with a joined receipt settled by receipt");
  assert.notEqual(served.receipt, null, "the receipt is served");
  assert.equal(served.observed_transfer_id, null, "a receipted binding carries no observed settlement");
  assert.equal(served.observed_tx_hash, null);
});

test("GET /api/payout-bindings/:id labels an observed-transfer settlement, not an unpaid null (WQ-292)", async () => {
  const served = await getPayoutBinding(seeded(), 2) as Record<string, unknown>;
  assert.equal(served.settled_by, "observed_transfer", "a binding whose award was settled by an observed transfer is labelled, not left to read as unpaid");
  assert.equal(served.receipt, null, "there is no receipt row for an observed settlement");
  assert.notEqual(served.observed_transfer_id, null, "the observed transfer id is served so the settlement is not a bare null");
  assert.equal(served.observed_tx_hash, "0xobservedtx", "the observed transfer's on-chain tx is served");
  assert.equal(served.observed_block_number, 51480102, "and its block");
});

test("GET /api/payout-bindings/:id: receipt wins and observed_* stay null when a binding has BOTH (WQ-292 both-settled regime)", async () => {
  const served = await getPayoutBinding(seeded(), 4) as Record<string, unknown>;
  assert.equal(served.settled_by, "receipt", "a receipt filed over an already-observed settlement wins — settled_by is the single source of truth");
  assert.notEqual(served.receipt, null, "the receipt is served");
  // The schema descriptions promise the observed_* trio is null unless settled_by
  // is 'observed_transfer'. A settling observed_transfer EXISTS for this binding,
  // so a projection that spread it unconditionally would break that promise.
  assert.equal(served.observed_transfer_id, null, "observed_transfer_id is gated on settled_by, not on the mere existence of a settling transfer");
  assert.equal(served.observed_tx_hash, null, "observed_tx_hash is null under settled_by:receipt even though a settling transfer exists");
  assert.equal(served.observed_block_number, null);
});

test("GET /api/payout-bindings/:id serves settled_by:null for a binding that never settled (WQ-292)", async () => {
  const served = await getPayoutBinding(seeded(), 3) as Record<string, unknown>;
  assert.equal(served.settled_by, null, "a binding with neither a receipt nor a settling transfer is unsettled");
  assert.equal(served.receipt, null);
  assert.equal(served.observed_transfer_id, null);
  assert.equal(served.observed_tx_hash, null);
  assert.equal(served.observed_block_number, null);
});
