// GET /api/payout-bindings/:id/funder-statement had no schema. It is the
// THIRD signing gate of the payout rail: after a Transfer lands, the paying
// wallet fetches these exact bytes, EIP-191 personal_signs them, and the
// payee files them at POST /api/payout-bindings/:id/receipt. The security
// document names this endpoint as one of the only three sources of signable
// bytes — so a served break here (a statement that is not the colon-joined
// PAYOUT_FUNDER_VERSION sentence, a dropped clock, a non-integer binding_id)
// is exactly the class a verifier must catch.
//
// Served by funderStatementFor() (src/society.ts) plus the router's json()
// clock (now / now_utc). Always-present on 200: statement, binding_id,
// sign_with, note, plus the clock. relationship omitted → trailing token
// "undeclared" (funder form). Prose is server-authored: pin presence/
// stringness, never wording.
//
// Soft-power / cloudymcclouder. Twin of Cloudy #305 (listings/preimage) and
// #323 (payout-bindings/preimage) on the funder-statement arm. No overlap
// with Cloudy #301/#302/#303/#308/#316/#318/#320/#323 money/content opens or
// babysit #313/#314/#315/#319/#324/#329. Proven RED first: without
// schemas/funder-statement.json this file fails to load.
//
// Live specimen (soft-power, 2026-09-20 ~09:16 ET): binding 1 + its recorded
// receipt Transfer → HTTP 200, statement ends :self; omit relationship →
// :undeclared.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validate } from "./helpers/json-schema.ts";

const SCHEMA_DIR = join(import.meta.dirname, "..", "schemas");
const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, "funder-statement.json"), "utf8"));

const now = 1789910172240;
const nowUtc = "2026-09-20T13:16:12.240Z";

// Live-fetched 2026-09-20 against binding 1's recorded receipt Transfer.
const LIVE_STATEMENT_SELF =
  "1f916.payout-funder.v1:13bde729d2e2fa21c3954474fe37cd9c76a22634f27c9bc1cfe519c7e317a028:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913:0xe1c039fa5e210b9da7f1eaf38d90d4f656ceab0f49084ac6df8303f1e85b7901:322:0xf32c99ae17c17022889b2288749ca433a2504211:0x84a18ac9d26c5ce70689c9b181a4a6155598fe8b:1000000:self";

const LIVE_STATEMENT_UNDECLARED =
  "1f916.payout-funder.v1:13bde729d2e2fa21c3954474fe37cd9c76a22634f27c9bc1cfe519c7e317a028:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913:0xe1c039fa5e210b9da7f1eaf38d90d4f656ceab0f49084ac6df8303f1e85b7901:322:0xf32c99ae17c17022889b2288749ca433a2504211:0x84a18ac9d26c5ce70689c9b181a4a6155598fe8b:1000000:undeclared";

function body(over: Record<string, unknown> = {}) {
  return {
    now,
    now_utc: nowUtc,
    statement: LIVE_STATEMENT_SELF,
    binding_id: 1,
    expiry: 1792502172,
    expiry_passed: false,
    sign_with:
      "EIP-191 personal_sign these exact UTF-8 bytes with the wallet that sent the tokens (source_address).",
    note: "The registry rebuilds this sentence from the chain at receipt time.",
    ...over,
  };
}

test("the funder-statement schema accepts the served contract (self + undeclared arms)", () => {
  assert.deepEqual(validate(schema, body()), [], "live-shaped self arm validates");
  assert.deepEqual(
    validate(schema, body({ statement: LIVE_STATEMENT_UNDECLARED })),
    [],
    "funder-form undeclared arm validates",
  );
});

test("the funder-statement schema refuses the contract breaks it exists to catch", () => {
  assert.ok(
    validate(schema, body({ statement: "please send funds to 0xdead" })).some((e) =>
      /statement/.test(e),
    ),
    "a non-sentence statement must be refused",
  );

  assert.ok(
    validate(schema, body({ statement: LIVE_STATEMENT_SELF.replace(/:self$/, ":friend") })).some(
      (e) => /statement/.test(e),
    ),
    "an unknown relationship token must be refused",
  );

  assert.ok(
    validate(schema, body({ binding_id: "1" })).some((e) => /binding_id/.test(e)),
    "a string binding_id must be refused",
  );

  const noClock = body();
  delete (noClock as { now?: number }).now;
  assert.ok(
    validate(schema, noClock).some((e) => /\bnow\b/.test(e)),
    "a dropped clock must be refused",
  );

  const noSign = body();
  delete (noSign as { sign_with?: string }).sign_with;
  assert.ok(
    validate(schema, noSign).some((e) => /sign_with/.test(e)),
    "a dropped sign_with must be refused",
  );

  const noNote = body();
  delete (noNote as { note?: string }).note;
  assert.ok(
    validate(schema, noNote).some((e) => /note/.test(e)),
    "a dropped note must be refused",
  );

  const noExpiry = body();
  delete (noExpiry as { expiry?: number }).expiry;
  assert.ok(
    validate(schema, noExpiry).some((e) => /expiry/.test(e)),
    "a dropped expiry must be refused",
  );

  const noExpiryPassed = body();
  delete (noExpiryPassed as { expiry_passed?: boolean }).expiry_passed;
  assert.ok(
    validate(schema, noExpiryPassed).some((e) => /expiry_passed/.test(e)),
    "a dropped expiry_passed must be refused",
  );
});

test("the funder-statement schema description pins the third signing-gate framing", () => {
  assert.match(
    schema.description,
    /signing gate/i,
    "the schema names the signing-gate role",
  );
  assert.match(
    schema.description,
    /three sources|payout-bindings\/preimage|listings\/preimage/,
    "the schema names this as one of the three signable-byte sources",
  );
  assert.match(
    schema.description,
    /Presence\/stringness|wording is not/,
    "the schema states prose is shape-pinned, not word-pinned",
  );
  assert.match(
    schema.description,
    /public|unauth/i,
    "the schema names that the live lane can probe this endpoint",
  );
  assert.match(
    schema.properties.statement.description,
    /undeclared/,
    "statement property names the funder-form undeclared token",
  );
});

test("the funder-statement schema matches what GET /api/payout-bindings/:id/funder-statement actually serves", async () => {
  // Through the real door: now/now_utc come from the router's json() wrapper,
  // and the schema requires them — validating funderStatementFor()'s return
  // alone would miss the clock. Seed one binding (same shape as
  // observed-settlement fixtures) so the path has a row to rebuild against.
  const { sqliteTestEnv } = await import("./helpers/sqlite-d1.ts");
  const { readFileSync: rf } = await import("node:fs");
  const { env, db } = sqliteTestEnv(rf(new URL("../schema.sql", import.meta.url), "utf8"));
  const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  const PAYEE = "0x84a18ac9d26c5ce70689c9b181a4a6155598fe8b";
  const nowS = Math.floor(Date.now() / 1000);
  const nowMs = Date.now();
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES
      (1, 'funder', 'm', 'a', 100, 100), (2, 'worker', 'm', 'b', 100, 100);
    INSERT INTO payout_bindings (id, citizen_id, docket_id, version, amount_atomic, chain_id, token, payout_address, expiry, wallet_signature, citizen_public_key, citizen_signature, citizen_key_thumbprint, citizen_key_custody, citizen_key_bound_at, authorization_verification, authorization_verified_at, docket_acceptance, docket_updated, docket_snapshot, preimage, authorization_hash, payload_hash, commit_nonce, created_at)
      VALUES (1, 2, 'listing-9', '1f916.payout.v1', '1000000', 8453, '${USDC}', '${PAYEE}', ${nowS + 86400}, 'ws', 'pk', 'cs', 'tp', 'self', 1, 'valid-at-binding-event', 1, 'a', '0', '{}', 'pre', 'ah', '13bde729d2e2fa21c3954474fe37cd9c76a22634f27c9bc1cfe519c7e317a028', 'n1', ${nowMs});
  `);

  const worker = (await import("../src/index.ts")).default;
  const full = {
    ...(env as object),
    TREASURY_ADDRESS: "0x0000000000000000000000000000000000000000",
  } as never;

  const tx = "0xe1c039fa5e210b9da7f1eaf38d90d4f656ceab0f49084ac6df8303f1e85b7901";
  const source = "0xf32c99ae17c17022889b2288749ca433a2504211";
  const path =
    `/api/payout-bindings/1/funder-statement?tx_hash=${tx}&log_index=322&source_address=${source}&relationship=self`;
  const res = await worker.fetch(new Request(`http://t${path}`), full);
  assert.equal(res.status, 200, "funder-statement is a public 200 when the binding exists");
  const served = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(
    validate(schema, served),
    [],
    `the schema must accept what the door serves: ${JSON.stringify(validate(schema, served))}`,
  );
  assert.equal(typeof served.now, "number");
  assert.equal(typeof served.now_utc, "string");
  assert.equal(served.binding_id, 1);
  assert.equal(typeof served.statement, "string");
  assert.match(served.statement as string, /:self$/);
  assert.equal(typeof served.sign_with, "string");
  assert.equal(typeof served.note, "string");
  // Binding seeded with expiry nowS + 86400 (a day out): the window is open.
  assert.equal(served.expiry, nowS + 86400, "expiry echoes the binding's own authorization expiry");
  assert.equal(served.expiry_passed, false, "a future-expiry binding reports expiry_passed false");

  // Funder form: omit relationship → undeclared token.
  const res2 = await worker.fetch(
    new Request(
      `http://t/api/payout-bindings/1/funder-statement?tx_hash=${tx}&log_index=322&source_address=${source}`,
    ),
    full,
  );
  assert.equal(res2.status, 200);
  const undeclared = (await res2.json()) as Record<string, unknown>;
  assert.deepEqual(validate(schema, undeclared), [], "undeclared arm through the door validates");
  assert.match(undeclared.statement as string, /:undeclared$/);
});
