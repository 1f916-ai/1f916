// WQ-685 pt2: a worker who binds a payout INLINE on POST /api/submissions is
// shown the listing's own clock beside the binding — the same
// expiry_exceeds_listing / listing_clock_note fields GET
// /api/payout-bindings/preimage serves — so a binding whose expiry outruns the
// listing is named at the moment it is filed, not only on the preimage route
// the worker may never have read. Both surfaces call the one listingClockFields
// builder, so the sentence cannot drift between them.
//
// Killing mutations:
//  - delete the `...listingClockFields(...)` spread from the submission
//    binding response -> the first two asserts (fields present, note text) red.
//  - change that call's role from "worker" to "verifier", or settlement mode
//    arg away from the real mode -> the note text + parity assert red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createSubmission, payoutPreimageFor, listingClockFields, type Env } from "../src/society.ts";
import { payoutPreimage } from "../src/payouts.ts";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const FUNDER = "0x3853965505b92bcef5b6a20fcca65c758f76736a";

// An OPEN listing (expiry still ahead) whose own clock is SHORTER than the
// worker's binding expiry, so expiry_exceeds_listing is true.
function makeEnv(mode: "requester" | "verifier" = "requester") {
  const { env, db } = sqliteTestEnv(SCHEMA);
  const nowS = Math.floor(Date.now() / 1000);
  const nowMs = Date.now();
  const listingExpiry = nowS + 300; // open, but soon
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES
      (1, 'funder', 'm', 'a', 100, 100), (2, 'worker', 'm', 'b', 100, 100);
    INSERT INTO listings (id, citizen_id, title, condition, amount_atomic, chain_id, token, expiry, funder_address, funder_signature, funds_seen_atomic, payload_hash, commit_nonce, created_at, settlement_version, settlement_mode, max_awards)
      VALUES (9, 1, 'bounty', '${"c".repeat(40)}', '500000', 8453, '${USDC}', ${listingExpiry}, '${FUNDER}', '${"0x" + "1".repeat(130)}', '24000000', 'ph9', 'n9', ${nowMs - 1800000}, 2, '${mode}', 1);
  `);
  return { env: env as Env, db, listingExpiry };
}

test("an inline submission binding carries the listing clock, in parity with the preimage route", async () => {
  const { env, db, listingExpiry } = makeEnv("requester");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const b64url = Buffer.from(raw).toString("base64url");
  const thumbprint = createHash("sha256").update(raw).digest("base64url").slice(0, 32);
  db.prepare("INSERT INTO keys (citizen_id, public_key, thumbprint, custody, status, bound_at) VALUES (2, ?, ?, 'undeclared', 'active', 0)").run(b64url, thumbprint);
  const wallet = privateKeyToAccount(generatePrivateKey());
  const address = wallet.address.toLowerCase();
  // The worker clock reaches past the listing's own.
  const expiry = listingExpiry + 3600;
  const preimage = payoutPreimage({ handle: "worker", row: "listing-9", amountAtomic: "500000", chainId: 8453, token: USDC, address, expiry });
  const payout = {
    address, expiry, citizen_public_key: b64url,
    citizen_signature: Buffer.from(edSign(null, Buffer.from(preimage), privateKey)).toString("base64url"),
    signature: await wallet.signMessage({ message: preimage }),
  };
  const worker = { id: 2, handle: "worker" } as never;
  const res = await createSubmission(env, worker, 9, { artifact: "https://example.test/work", payout });
  assert.equal(res.submitted, true);
  const pb = res.payout_binding as Record<string, unknown>;
  assert.equal(pb.filed, true);

  // The listing clock rode in with the inline binding.
  assert.equal(pb.expiry_exceeds_listing, true);
  assert.equal(pb.listing_expiry, listingExpiry);
  assert.match(String(pb.listing_clock_note), /is \d+ seconds past the listing's own expiry/);
  // Requester-settled worker row: the note says a payment settles after close.
  assert.match(String(pb.listing_clock_note), /pass expiry=\d+ or earlier/);
  assert.match(String(pb.listing_clock_note), /requester-settled worker row it is THIS binding's own window/);

  // Same fields, same bytes, as the standalone preimage builder for the same
  // inputs — the whole point of the one shared builder.
  const expected = listingClockFields(expiry, listingExpiry, "worker", "requester");
  assert.deepEqual(
    { listing_expiry: pb.listing_expiry, listing_expiry_utc: pb.listing_expiry_utc, expiry_exceeds_listing: pb.expiry_exceeds_listing, listing_clock_note: pb.listing_clock_note },
    expected,
  );
  const pre = await payoutPreimageFor(env, { handle: "worker", row: "listing-9", amount_atomic: "500000", address, expiry: String(expiry) });
  assert.deepEqual(
    { listing_expiry: pre.listing_expiry, listing_expiry_utc: pre.listing_expiry_utc, expiry_exceeds_listing: pre.expiry_exceeds_listing, listing_clock_note: pre.listing_clock_note },
    expected,
    "submission binding and preimage route must show the identical clock",
  );
});

test("an inline binding whose expiry is within the listing clock says the worker clock fires first", async () => {
  const { env, db, listingExpiry } = makeEnv("requester");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const b64url = Buffer.from(raw).toString("base64url");
  const thumbprint = createHash("sha256").update(raw).digest("base64url").slice(0, 32);
  db.prepare("INSERT INTO keys (citizen_id, public_key, thumbprint, custody, status, bound_at) VALUES (2, ?, ?, 'undeclared', 'active', 0)").run(b64url, thumbprint);
  const wallet = privateKeyToAccount(generatePrivateKey());
  const address = wallet.address.toLowerCase();
  // Inside the listing's clock (but still far enough ahead to be bindable).
  const expiry = listingExpiry - 60;
  const preimage = payoutPreimage({ handle: "worker", row: "listing-9", amountAtomic: "500000", chainId: 8453, token: USDC, address, expiry });
  const payout = {
    address, expiry, citizen_public_key: b64url,
    citizen_signature: Buffer.from(edSign(null, Buffer.from(preimage), privateKey)).toString("base64url"),
    signature: await wallet.signMessage({ message: preimage }),
  };
  const worker = { id: 2, handle: "worker" } as never;
  const res = await createSubmission(env, worker, 9, { artifact: "https://example.test/work", payout });
  const pb = res.payout_binding as Record<string, unknown>;
  assert.equal(pb.filed, true);
  assert.equal(pb.expiry_exceeds_listing, false);
  assert.match(String(pb.listing_clock_note), /the worker clock fires first/);
  assert.deepEqual(
    { expiry_exceeds_listing: pb.expiry_exceeds_listing, listing_clock_note: pb.listing_clock_note },
    { expiry_exceeds_listing: false, listing_clock_note: (listingClockFields(expiry, listingExpiry, "worker", "requester") as { listing_clock_note: string }).listing_clock_note },
  );
});
