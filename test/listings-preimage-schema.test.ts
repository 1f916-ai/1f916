// GET /api/listings/preimage had no schema. It is the SIGNING GATE: a funder
// fetches these exact bytes, signs them EIP-191 with the wallet that will pay,
// and the signature binds the listing. The security document (now schema'd)
// says "sign only bytes you fetched from this registry" and names this
// endpoint — so a served break here (a preimage that is not the colon-joined
// sentence, a hash that is not 64 hex, a number where total_needed_atomic is
// promised as a string) is exactly the class a verifier must catch: text
// that looks signable but is not the record's sentence.

// The response is listingPreimageFor (src/society.ts:5101) + the clock
// wrapper: seven keys, all always present, no nullable fields, no pagination.
// The schema pins shapes and the load-bearing formats, never the sign_with
// wording (prose guidance, and the trust rule makes it server-authored text).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validate } from "./helpers/json-schema.ts";

const SCHEMA_DIR = join(import.meta.dirname, "..", "schemas");
const schema = JSON.parse(
  readFileSync(join(SCHEMA_DIR, "listings-preimage.json"), "utf8"),
) as Record<string, unknown>;

// A live response, in the shape GET /api/listings/preimage serves today for
// a probe request (handle=attic-wren, a probe title, 1 USDC in atomic units,
// no verifier price, max_verifiers 0, a future expiry). Values live-verified.
function servedContract(over = {}) {
  return {
    now: 1789767689082,
    now_utc: "2026-09-18T22:30:00.000Z",
    preimage:
      "1f916.listing.v1:attic-wren:5a966d79e532a79878ab6305ba6e517b263161092bb228f8d694aa202676ecd5:1000000:0:0:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913:1790000000",
    title_trimmed: "schema probe listing",
    title_sha256: "5a966d79e532a79878ab6305ba6e517b263161092bb228f8d694aa202676ecd5",
    total_needed_atomic: "1000000",
    sign_with:
      "EIP-191 personal_sign these exact UTF-8 bytes with the wallet that will pay.",
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

  assert.notDeepEqual(
    validate(schema, servedContract({ title_sha256: "not-a-hash" })),
    [],
    "a non-hex title_sha256 must be refused",
  );

  assert.notDeepEqual(
    validate(schema, servedContract({ total_needed_atomic: 1000000 })),
    [],
    "a number total_needed_atomic must be refused (the committed amounts are strings)",
  );

  const noClock = servedContract() as Record<string, unknown>;
  delete noClock.now;
  assert.notDeepEqual(validate(schema, noClock), [], "a dropped clock must be refused");

  const noSignWith = servedContract() as Record<string, unknown>;
  delete noSignWith.sign_with;
  assert.notDeepEqual(
    validate(schema, noSignWith),
    [],
    "a dropped sign_with must be refused",
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
