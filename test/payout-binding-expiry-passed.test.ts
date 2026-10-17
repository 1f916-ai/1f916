// WQ-283 (hera, post 7806): GET /api/payout-bindings/:id served no lifecycle
// field — a binding past its own expiry read byte-identically to a live one.
// This is the base-GET sibling of WQ-277 (e48c33336), which added the same
// expiry_passed signal to the /funder-statement sub-route. The field is
// descriptive only: it says the window to make a NEW payment has closed, not
// that the binding is a debt or that anything was extinguished — a Transfer
// that landed before expiry stays recordable (the receipt check is on the
// payment's block timestamp), and `receipt` is non-null once one is filed.
//
// Proven RED: remove the one expiry_passed line from getPayoutBinding() and the
// served object drops the field — the two real-door assertions below go red,
// and schema.test.ts's required-field door reddens too.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync as rf } from "node:fs";

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const PAYEE = "0x84a18ac9d26c5ce70689c9b181a4a6155598fe8b";

async function serveBinding(expirySeconds: number) {
  const { sqliteTestEnv } = await import("./helpers/sqlite-d1.ts");
  const { env, db } = sqliteTestEnv(rf(new URL("../schema.sql", import.meta.url), "utf8"));
  const nowMs = Date.now();
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES
      (2, 'worker', 'm', 'b', 100, 100);
    INSERT INTO payout_bindings (id, citizen_id, docket_id, version, amount_atomic, chain_id, token, payout_address, expiry, wallet_signature, citizen_public_key, citizen_signature, citizen_key_thumbprint, citizen_key_custody, citizen_key_bound_at, authorization_verification, authorization_verified_at, docket_acceptance, docket_updated, docket_snapshot, preimage, authorization_hash, payload_hash, commit_nonce, created_at)
      VALUES (1, 2, 'listing-9', '1f916.payout.v1', '1000000', 8453, '${USDC}', '${PAYEE}', ${expirySeconds}, 'ws', 'pk', 'cs', 'tp', 'self', 1, 'valid-at-binding-event', 1, 'a', '0', '{}', 'pre', 'ah', '13bde729d2e2fa21c3954474fe37cd9c76a22634f27c9bc1cfe519c7e317a028', 'n1', ${nowMs});
  `);
  const worker = (await import("../src/index.ts")).default;
  const full = { ...(env as object), TREASURY_ADDRESS: "0x0000000000000000000000000000000000000000" } as never;
  const res = await worker.fetch(new Request("http://t/api/payout-bindings/1"), full);
  assert.equal(res.status, 200, "an existing binding is a public 200");
  return (await res.json()) as Record<string, unknown>;
}

test("GET /api/payout-bindings/:id reports expiry_passed true on a lapsed binding (WQ-283)", async () => {
  const nowS = Math.floor(Date.now() / 1000);
  const served = await serveBinding(nowS - 3600); // expired an hour ago
  assert.equal(served.expiry, nowS - 3600, "expiry echoes the binding's own authorization expiry");
  assert.equal(served.expiry_passed, true, "a past-expiry binding reports expiry_passed true");
  assert.equal(served.receipt, null, "no receipt filed; lifecycle is readable from expiry_passed + receipt");
});

test("GET /api/payout-bindings/:id reports expiry_passed false on a live binding", async () => {
  const nowS = Math.floor(Date.now() / 1000);
  const served = await serveBinding(nowS + 86400); // a day out
  assert.equal(served.expiry, nowS + 86400, "expiry echoes the live authorization's own expiry");
  assert.equal(served.expiry_passed, false, "a future-expiry binding reports expiry_passed false");
});
