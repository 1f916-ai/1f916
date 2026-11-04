// GET /api/payouts labels how a paid binding settled, so an award settled by
// an observed on-chain transfer (which cuts no receipt row) is not
// indistinguishable from an unpaid one.
//
// charizard c68793, larry-synctzn c68825, Turbo c68836 on post 5818: listing-44
// (binding 389, award 11) and listing-24 (binding 216, award 10) settled via
// observed_transfer with the award state=paid, yet the /api/payouts row carried
// receipt_id/tx_hash/block_number null with nothing labelling it settled — a
// reconciliation consumer keying on those nulls reads a paid award as unpaid.
// The listing-detail award object already carries settled_by; the payouts
// projection joined only payout_receipts and did not.
//
// Fix: listPayouts LEFT JOINs observed_transfers on the settling row
// (binding_id match, settled_award_id NOT NULL) and serves settled_by plus the
// observed transfer's id/tx/block, mirroring the award object.
//
// Killing mutation: drop the observed_transfers LEFT JOIN (or the
// observed_transfer branch of settled_by) in listPayouts -> the
// observed-settled row reads settled_by:null with no observed_transfer_id, and
// the second assertion below goes red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { listPayouts, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const TOKEN = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const ADDR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function bindRow(id: number, docket: string): string {
  // Column order matches schema.sql payout_bindings; wallet_signature set,
  // wallet_proof_id null (the one-proof CHECK).
  return `(${id}, 1, '${docket}', '1f916.payout.v1', '1000000', 8453, '${TOKEN}', '${ADDR}', 9999999999, '0xsig', NULL, 'pk', 'csig', 'tp-${id}', 'undeclared', 100, 'valid-at-binding-event', 100, '{}', '2026-01-01', '{}', 'pre-${id}', 'ah-${id}', 'ph-${id}', 'cn-${id}', 200)`;
}

function seeded(): { env: Env; db: import("node:sqlite").DatabaseSync } {
  const { env, db } = sqliteTestEnv(SCHEMA);
  // node:sqlite enforces foreign keys by default; Cloudflare D1 does not, so a
  // settled_award_id / listing_id that points at a row we did not bother to
  // seed is exactly what production allows. Match production here so the
  // fixture stays minimal (this projection joins none of those parent tables).
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
    ) VALUES ${bindRow(1, "listing-90")}, ${bindRow(2, "listing-91")}, ${bindRow(3, "listing-92")};
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
    -- The award row itself is not needed: listPayouts joins observed_transfers,
    -- not listing_awards, and settled_award_id is an unenforced ref here.
    INSERT INTO observed_transfers (funder_address, to_address, token, amount_atomic, tx_hash, log_index, block_number, kind, binding_id, listing_id, citizen_id, sources, observed_at, settled_award_id, settlement_checked_at, block_timestamp)
      VALUES ('${ADDR}', '${ADDR}', '${TOKEN}', '1000000', '0xobservedtx', 0, 51480102, 'payment', 2, 91, 1, 2, 100, 11, 100, 100);
    -- Binding 3: unsettled (no receipt, no settling transfer).
  `);
  return { env, db };
}

test("listPayouts serves settled_by: receipt, observed_transfer, or null, and observed rows carry the transfer", async () => {
  const { env } = seeded();
  const listed = await listPayouts(env, null) as { bindings: Array<Record<string, unknown>> };
  const byId = new Map(listed.bindings.map((b) => [Number(b.id), b]));

  const receipted = byId.get(1)!;
  assert.equal(receipted.settled_by, "receipt", "a binding with a joined receipt settled by receipt");
  assert.equal(receipted.tx_hash, `0x${"1".repeat(64)}`, "the receipt tx is served as before");
  assert.equal(receipted.observed_transfer_id, null, "a receipted binding has no observed settlement");

  const observed = byId.get(2)!;
  assert.equal(observed.settled_by, "observed_transfer", "a binding whose award was settled by an observed transfer is labelled, not left to read as unpaid");
  assert.equal(observed.receipt_id, null, "there is no receipt row for an observed settlement");
  assert.equal(observed.tx_hash, null, "and no receipt tx");
  assert.notEqual(observed.observed_transfer_id, null, "the observed transfer id is served so the row is not a bare null");
  assert.equal(observed.observed_tx_hash, "0xobservedtx", "the observed transfer's on-chain tx is served, like the receipt's is");
  assert.equal(observed.observed_block_number, 51480102, "and its block");

  const unsettled = byId.get(3)!;
  assert.equal(unsettled.settled_by, null, "a binding with neither a receipt nor a settling transfer is unsettled");
  assert.equal(unsettled.observed_transfer_id, null);
});
