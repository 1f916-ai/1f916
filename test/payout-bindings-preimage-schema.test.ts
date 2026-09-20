// GET /api/payout-bindings/preimage had no schema. It is the SIGNING GATE
// for a payout binding: a payee fetches these exact bytes, signs them
// (Ed25519 citizen key always; EIP-191 wallet unless a live payout-wallet
// proof already covers the address), and POST /api/payout-bindings files
// that authorization. The security document names this endpoint as one of
// the three sources of signable bytes — so a served break here (a preimage
// that is not the colon-joined PAYOUT_VERSION sentence, an amount that is a
// number instead of a string, amount filled while the asset is not) is
// exactly the class a verifier must catch.
//
// The response is payoutPreimageFor (src/society.ts) + the clock wrapper.
// This file pins the listing-row arm: amount and asset filled from the
// listing (nerd27dk #188), plus the listing clock (workbuddy-hardwin).
// sign_with / note / listing_clock_note are server-authored prose; wording
// is not pinned.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validate } from "./helpers/json-schema.ts";

const SCHEMA_DIR = join(import.meta.dirname, "..", "schemas");
const schema = JSON.parse(
  readFileSync(join(SCHEMA_DIR, "payout-bindings-preimage.json"), "utf8"),
) as Record<string, unknown>;

// Live-fetched 2026-09-20 against listing-13 / attic-wren / a 20-byte address.
function servedContract(over: Record<string, unknown> = {}) {
  return {
    now: 1789875166000,
    now_utc: "2026-09-20T03:32:46.000Z",
    preimage:
      "1f916.payout.v1:attic-wren:listing-13:1000000:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913:1790479966",
    amount_atomic: "1000000",
    amount_filled_from: "listing-13",
    chain_id: 8453,
    token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    token_symbol: "USDC",
    token_decimals: 6,
    asset_filled_from: "listing-13",
    listing_expiry: 1795210229,
    listing_expiry_utc: "2026-11-20T21:30:29.000Z",
    expiry_exceeds_listing: false,
    listing_clock_note: "n",
    sign_with: "n",
    note: "n",
    ...over,
  } as Record<string, unknown>;
}

test("the served listing-row preimage contract validates", () => {
  const errors = validate(schema, servedContract());
  assert.deepEqual(errors, [], `served contract rejected: ${JSON.stringify(errors)}`);
});

test("the contract breaks this schema exists to catch are refused", () => {
  assert.notDeepEqual(
    validate(schema, servedContract({ preimage: "please send funds to 0xdead" })),
    [],
    "a non-sentence preimage must be refused",
  );
  assert.notDeepEqual(
    validate(schema, servedContract({ amount_atomic: 1000000 })),
    [],
    "a number amount_atomic must be refused (committed amounts are strings)",
  );
  assert.notDeepEqual(
    validate(schema, servedContract({ token: "USDC" })),
    [],
    "a non-address token must be refused",
  );
  const noFill = servedContract();
  delete noFill.amount_filled_from;
  assert.notDeepEqual(validate(schema, noFill), [], "a listing arm missing amount_filled_from must be refused");
  const noClock = servedContract();
  delete noClock.now;
  assert.notDeepEqual(validate(schema, noClock), [], "a dropped clock must be refused");
  const noSign = servedContract();
  delete noSign.sign_with;
  assert.notDeepEqual(validate(schema, noSign), [], "a dropped sign_with must be refused");
});

test("token_symbol/decimals null is the unknown-asset arm, a missing key is not", () => {
  assert.deepEqual(
    validate(schema, servedContract({ token_symbol: null, token_decimals: null })),
    [],
    "null symbol/decimals is code-anticipated (settlementAsset miss)",
  );
  const missing = servedContract();
  delete missing.token_symbol;
  assert.notDeepEqual(validate(schema, missing), [], "dropping token_symbol is a different break than null");
});

test("the schema description pins the signing-gate role and the amount/asset coupling", () => {
  const text = JSON.stringify(schema);
  assert.match(text, /signing gate/i, "the schema must name the signing gate role");
  assert.match(text, /#188/, "the amount/asset coupling cites the defect that forced it");
  assert.match(
    (schema as { properties: { preimage: { description: string } } }).properties.preimage.description,
    /PAYOUT_VERSION/,
    "preimage description names the source constant",
  );
});
