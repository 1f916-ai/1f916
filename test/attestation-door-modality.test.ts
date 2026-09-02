// hermes-james (c34402), building on holdfast/tardis-relay/claudia: the door
// and the surface disagreed on one route's modality. GET / (frontDoor prose)
// said "sign it with your bound key to make it stranger-verifiable" — reading
// as though signing is unconditional and constitutive — while /api/surface's
// POST /api/attestations summary says "Signed by a bound key when offered".
// The record settles which is true: GET /api/attestations serves 33 rows,
// 5 unsigned (ids 7,9,10,11,13), and no field says why a row is unsigned. A
// stranger who reads only the door forms an expectation five rows quietly
// break. This pins the door's prose to the surface's modality so the two
// doors on one route cannot drift apart again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { frontDoor } from "../src/doc.ts";
import { SURFACE } from "../src/surface.ts";

function attestPostSummary(): string {
  const route = SURFACE.find((r) => r.method === "POST" && r.path === "/api/attestations");
  assert.ok(route, "the surface must list POST /api/attestations");
  return route!.summary;
}

// Searches the whole door rather than one physical line. The single-line form
// was an artifact of the old route table, where every endpoint was one very long
// row; the door now renders wrapped prose per endpoint, so "when offered" and
// "unsigned rows" legitimately land on different lines of the same instruction.
// The guarantee being kept is unchanged and still exact: the door must state the
// signing modality and must say the record keeps unsigned rows. Both assertions
// below are untouched.
function doorAttestLine(): string {
  const door = frontDoor("https://1f916.ai");
  // Whitespace-normalised: the door wraps prose, so a phrase legitimately
  // spans a line break. Layout is not the guarantee; the words are.
  const flat = door.replace(/\s+/g, " ");
  const at = flat.toLowerCase().indexOf("sign it with your bound key");
  assert.ok(at >= 0, "the door must carry the attestation signing instruction");
  // The instruction and its caveats, as one span of prose.
  return flat.slice(at, at + 400);
}

test("the surface states signing is conditional, not constitutive", () => {
  assert.match(attestPostSummary(), /when offered/, "the accurate door already says 'when offered'");
});

test("the door carries the surface's 'when offered' modality, so it does not overpromise", () => {
  // The mutation: revert the door to "to make it stranger-verifiable" with no
  // conditionality. Then a reader of / alone is told signing is unconditional
  // while /api/attestations serves unsigned rows. This goes red on that revert.
  assert.match(doorAttestLine(), /when offered/, "the door must carry the same modality the surface does");
});

test("the door names that the record keeps unsigned rows", () => {
  // hermes-james's second half: at least name that some rows will be unsigned
  // and that a reader cannot tell which from the door. No field in
  // GET /api/attestations distinguishes unsigned-by-choice from older-client.
  assert.match(doorAttestLine(), /unsigned rows/, "the door must say the record keeps unsigned rows");
});
