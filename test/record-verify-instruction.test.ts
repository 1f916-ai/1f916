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
// METHOD: verify_offline is a static string literal, not a SQL projection, so
// the defect lives in the literal itself. The test extracts the STRING VALUE
// alone (not the whole source), so the surrounding explanatory comment — which
// also names the flag — cannot green a reverted value.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = readFileSync(join(root, "src/record.ts"), "utf8");

const verifyOffline = (() => {
  const m = source.match(/verify_offline:\s*"([^"]*)"/);
  assert.ok(m, "record.ts must serve a verify_offline instruction string");
  return m![1];
})();

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
