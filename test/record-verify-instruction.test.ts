// The dossier's own offline-verification instruction must name the flag that
// reaches a meaningful verdict.
//
// GET /api/record/:handle serves a `verify_offline` string telling a stranger
// how to check the dossier with the protocol's reference verifier. The bare
// `--dossier` form the field once carried lands on `VERDICT: unanchored` — the
// verifier's own bottom rung, which checks the file's signatures against a key
// the file itself supplies. A fabricated record signed with a freshly minted
// key clears that exact command with the same PASS lines, the same verdict and
// exit 0 as a real record; `--registry-key` (a public, cross-published key) is
// the entire difference. verify.mjs documents the dossier form as
// `--dossier record.json --registry-key <b64url>` and the protocol README's
// canonical one-line record check carries the flag; the served string did not.
//
// This is the unpinned sibling of test/attest-read-instruction.test.ts: the
// endpoint's own reading instruction must name the field that goes red.
// Reported by Cairnfield (#1313) as issue #226.
//
// METHOD: verify_offline was a static string literal carrying the registry
// key; since registry key rotation it is built by verifyOfflineInstruction,
// which pins the published key before any rotation and the active key after
// one (a retired key is never the pin), and names the key that signed, so the test calls that function rather than
// reading a literal out of the source. The surrounding explanatory comment, which also names the flag,
// still cannot green a reverted value, because the comment is not called.

import test from "node:test";
import assert from "node:assert/strict";
import { verifyOfflineInstruction } from "../src/record.ts";

const KEY = "mpQPa0FjyynqoSg2Z9j91hRhb8WckxIpRGod43CQqLw";
const verifyOffline = verifyOfflineInstruction({ pub: KEY, epoch: 0 });

test("verify_offline names --registry-key, the flag that anchors the run", () => {
  assert.match(
    verifyOffline,
    /--registry-key\s+\S/,
    "without --registry-key the documented command lands on VERDICT: unanchored, which a fabricated record clears identically",
  );
});

test("verify_offline says what the bare run reports, so the reader can recognise it", () => {
  assert.match(
    verifyOffline,
    /unanchored/,
    "the instruction must name the verdict the anchoring flag exists to avoid",
  );
});

test("before any rotation the command pins the published key", () => {
  assert.ok(verifyOffline.includes(`--registry-key ${KEY}`));
});

test("after a rotation the command pins the ACTIVE key, never the retired published one, and says why", () => {
  const rotated = verifyOfflineInstruction({ pub: "B".repeat(43), epoch: 3 });
  assert.ok(rotated.includes(`--registry-key ${"B".repeat(43)}`), "the copy-paste pin is the active key");
  assert.ok(!rotated.includes(`--registry-key ${KEY}`), "a reader pinned to a retired key cannot detect a holder of it serving a cut-back history");
  assert.match(rotated, /epoch 3/);
  assert.match(rotated, /retired/);
  assert.match(rotated, /registry_key_history/);
});

test("an unsigned dossier's instruction says it is unsigned rather than naming a key", () => {
  const unsigned = verifyOfflineInstruction(null);
  assert.match(unsigned, /unsigned/);
  assert.match(unsigned, /unanchored/);
});
