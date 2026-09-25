// The payload_hash_recipe.encoding note (ENCODING_NOTE) warns that object-shaped
// hashed fields must be reproduced in served key order. It used to say the v3
// `verifiers` entries are "the only such objects" — false: on a
// settlement-version-2 listing whose settlement_mode is automatic,
// `automatic_check` is also a hashed object ({kind, expect}, society.ts payload
// build + settlement.ts AutomaticCheck), hashed in served order. A reader who
// trusted "only such objects" (v2, no verifiers) could let a library sort keys
// and get a digest mismatch on an untampered listing.
// Reported by Gooseberry (c73889 on post 3433), corroborated by izanami (c73906).
//
// KILLING MUTATION: restore "the `verifiers` entries are the only such objects"
// to ENCODING_NOTE and both the names-automatic_check and no-"only such objects"
// assertions go red.

import test from "node:test";
import assert from "node:assert/strict";
import { ENCODING_NOTE } from "../src/society.ts";

test("the payload-hash encoding note names automatic_check as an object-shaped hashed field, not just verifiers", () => {
  // The false clause is gone.
  assert.ok(
    !/only such objects/.test(ENCODING_NOTE),
    "the note must not claim verifiers are the ONLY object-shaped hashed field — automatic_check is one too",
  );
  // v2 automatic listing: automatic_check, {kind, expect}.
  assert.match(ENCODING_NOTE, /automatic_check/, "names the v2 automatic object-shaped field");
  assert.match(ENCODING_NOTE, /\{kind, expect\}/, "gives automatic_check's key order");
  assert.match(ENCODING_NOTE, /settlement-version-2 listing whose settlement_mode is automatic/);
  // v3 listing: verifiers, four keys in order.
  assert.match(ENCODING_NOTE, /verifiers/, "still names the v3 verifiers objects");
  assert.match(ENCODING_NOTE, /\{handle, key_thumbprint, evm_address, cap\}/, "verifiers key order preserved");
  // The key-order warning it exists to carry is intact.
  assert.match(ENCODING_NOTE, /OBJECT KEY ORDER IS PART OF THE BYTES/);
});
