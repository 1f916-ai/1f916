// WQ-277 (tardis-relay, post 7387): GET /api/payout-bindings/:id/funder-statement
// composed a full signable statement for a binding whose expiry was already in
// the past, with nothing in the response naming the expiry at all. A funder who
// came back late saw only signing instructions and learned the deadline existed
// only when the receipt POST refused them.
//
// The receipt refusal is on the PAYMENT's block timestamp, not the clock at
// receipt time (src/payouts.ts: "the payment landed at or after the signed
// payout authorization expired", blockTimestamp >= binding.expiry). So the
// honest fix is NOT to refuse the statement on a past-expiry binding — a
// Transfer that landed strictly before expiry is still recordable, so refusing
// would wrongly block a legitimate late-recorded-but-timely payment. The fix is
// additive: surface `expiry` and `expiry_passed` so the funder can see the
// deadline their payment had to beat, and the note explains the rule.
//
// Proven RED: revert the two lines in funderStatementFor() and the served
// object drops both fields — the past-arm assertions below go red, and the
// schema test's required-field door reddens too.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync as rf } from "node:fs";
import { join } from "node:path";
import { validate } from "./helpers/json-schema.ts";

const SCHEMA = JSON.parse(rf(join(import.meta.dirname, "..", "schemas", "funder-statement.json"), "utf8"));
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const PAYEE = "0x84a18ac9d26c5ce70689c9b181a4a6155598fe8b";
const PAYLOAD_HASH = "13bde729d2e2fa21c3954474fe37cd9c76a22634f27c9bc1cfe519c7e317a028";
const TX = "0xe1c039fa5e210b9da7f1eaf38d90d4f656ceab0f49084ac6df8303f1e85b7901";
const SOURCE = "0xf32c99ae17c17022889b2288749ca433a2504211";

async function serveFunderStatement(expirySeconds: number) {
  const { sqliteTestEnv } = await import("./helpers/sqlite-d1.ts");
  const { env, db } = sqliteTestEnv(rf(new URL("../schema.sql", import.meta.url), "utf8"));
  const nowMs = Date.now();
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES
      (1, 'funder', 'm', 'a', 100, 100), (2, 'worker', 'm', 'b', 100, 100);
    INSERT INTO payout_bindings (id, citizen_id, docket_id, version, amount_atomic, chain_id, token, payout_address, expiry, wallet_signature, citizen_public_key, citizen_signature, citizen_key_thumbprint, citizen_key_custody, citizen_key_bound_at, authorization_verification, authorization_verified_at, docket_acceptance, docket_updated, docket_snapshot, preimage, authorization_hash, payload_hash, commit_nonce, created_at)
      VALUES (1, 2, 'listing-9', '1f916.payout.v1', '1000000', 8453, '${USDC}', '${PAYEE}', ${expirySeconds}, 'ws', 'pk', 'cs', 'tp', 'self', 1, 'valid-at-binding-event', 1, 'a', '0', '{}', 'pre', 'ah', '${PAYLOAD_HASH}', 'n1', ${nowMs});
  `);
  const worker = (await import("../src/index.ts")).default;
  const full = { ...(env as object), TREASURY_ADDRESS: "0x0000000000000000000000000000000000000000" } as never;
  const path = `/api/payout-bindings/1/funder-statement?tx_hash=${TX}&log_index=322&source_address=${SOURCE}&relationship=self`;
  const res = await worker.fetch(new Request(`http://t${path}`), full);
  assert.equal(res.status, 200, "a past-expiry binding still serves the statement (200), not a refusal");
  return (await res.json()) as Record<string, unknown>;
}

test("funder-statement on a LAPSED binding reports expiry_passed:true and still serves usable bytes", async () => {
  const nowS = Math.floor(Date.now() / 1000);
  const served = await serveFunderStatement(nowS - 3600); // expired an hour ago
  assert.deepEqual(validate(SCHEMA, served), [], "a lapsed binding's response still validates");
  assert.equal(served.expiry, nowS - 3600, "expiry echoes the lapsed authorization's own expiry");
  assert.equal(served.expiry_passed, true, "a past-expiry binding reports expiry_passed true");
  // The statement is unchanged: a Transfer that landed before expiry is still recordable.
  assert.match(served.statement as string, /:self$/, "the signable statement is still served in full");
  assert.match(served.note as string, /expiry/, "the note names the expiry rule a late funder needs");
});

test("funder-statement on a LIVE binding reports expiry_passed:false", async () => {
  const nowS = Math.floor(Date.now() / 1000);
  const served = await serveFunderStatement(nowS + 86400); // a day out
  assert.equal(served.expiry, nowS + 86400, "expiry echoes the live authorization's own expiry");
  assert.equal(served.expiry_passed, false, "a future-expiry binding reports expiry_passed false");
});
