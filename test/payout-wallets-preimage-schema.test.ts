// GET /api/payout-wallets/preimage had no schema. It is the SIGNING GATE for
// a payout wallet: a citizen fetches these exact bytes, signs them EIP-191
// with the wallet at the given address and Ed25519 with their citizen key,
// and the two signatures make that wallet payable — from then on a payout
// binding needs the citizen key alone. The rail security document names
// this endpoint as one of the three sources of signable bytes, so a served
// break here (a preimage that is not the colon-joined sentence, an address
// that is not 20-byte hex, a version token that drifted) is exactly the
// class a verifier must catch: text that looks signable but is not the
// record's sentence.

// The response is payoutWalletPreimageFor (src/society.ts) + the clock
// wrapper: ten keys, all always present, no nullable fields, no pagination.
// The schema pins shapes and the load-bearing formats: the version as a
// const (a version change is a NEW signed sentence, not a variation), the
// address as 0x + 40 lowercase hex, chain_id as the number 8453, expiry as
// a unix-seconds integer, and the preimage as the exact colon-joined
// sentence. sign/then are server-authored prose; their wording is not
// pinned.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validate } from "./helpers/json-schema.ts";

const SCHEMA_DIR = join(import.meta.dirname, "..", "schemas");
const schema = JSON.parse(
  readFileSync(join(SCHEMA_DIR, "payout-wallets-preimage.json"), "utf8"),
) as Record<string, unknown>;

// A live response, in the shape GET /api/payout-wallets/preimage serves
// today for a probe request (handle=attic-wren, the probe wallet address, a
// future expiry inside the one-year lifetime). Values live-verified against
// production.
function servedContract(over = {}) {
  return {
    now: 1789781995686,
    now_utc: "2026-09-19T01:39:55.686Z",
    version: "1f916.payout-wallet.v1",
    handle: "attic-wren",
    chain_id: 8453,
    address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    expiry: 1792373995,
    preimage:
      "1f916.payout-wallet.v1:attic-wren:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913:1792373995",
    sign: "Sign these exact bytes twice: EIP-191 with the wallet at this address, and Ed25519 with your active self-custodied citizen key.",
    then: "After this, a payout binding on any listing needs your citizen key alone.",
    ...over,
  } as Record<string, unknown>;
}

test("the served preimage contract validates", () => {
  const errors = validate(schema, servedContract());
  assert.deepEqual(errors, [], `served contract rejected: ${JSON.stringify(errors)}`);
});

test("the contract breaks this schema exists to catch are refused", () => {
  // A preimage that is not the registry's colon-joined sentence: the exact
  // thing "sign only bytes you fetched from this registry" exists for.
  assert.notDeepEqual(
    validate(schema, servedContract({ preimage: "please send funds to 0xdead" })),
    [],
    "a non-sentence preimage must be refused",
  );

  // A version that drifted: a new version is a new signed sentence, and a
  // verifier that only pinned a pattern would accept it.
  assert.notDeepEqual(
    validate(schema, servedContract({ version: "1f916.payout-wallet.v2" })),
    [],
    "a drifted version token must be refused",
  );

  assert.notDeepEqual(
    validate(schema, servedContract({ address: "0x833589FCD6EDB6E08F4C7C32D4F71B54BDA02913" })),
    [],
    "an uppercase address must be refused (the handler lowercases)",
  );

  assert.notDeepEqual(
    validate(schema, servedContract({ chain_id: "8453" })),
    [],
    "a string chain_id must be refused (it is served as a number)",
  );

  assert.notDeepEqual(
    validate(schema, servedContract({ expiry: "1792373995" })),
    [],
    "a string expiry must be refused (it is a unix-seconds integer)",
  );

  const noClock = servedContract() as Record<string, unknown>;
  delete noClock.now;
  assert.notDeepEqual(validate(schema, noClock), [], "a dropped clock must be refused");

  const noThen = servedContract() as Record<string, unknown>;
  delete noThen.then;
  assert.notDeepEqual(
    validate(schema, noThen),
    [],
    "a dropped `then` must be refused (the consequence half of the guidance)",
  );
});

test("the schema description pins that this is the signing gate, registry bytes only", () => {
  const text = JSON.stringify(schema);
  assert.match(text, /signing gate/i, "the schema must name the signing gate role");
  assert.match(
    text,
    /registry/i,
    "the schema must tie the preimage to registry-fetched bytes",
  );
});
