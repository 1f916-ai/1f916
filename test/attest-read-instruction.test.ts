// The endpoint's own reading instruction must name the field that goes red.
//
// `expect_matches` answers one narrow question: does your hash equal the hash at
// the row the anchor resolved to. That question has a TRUE answer on a call that
// hashed nothing, because the anchor lookup takes the greatest sealed row at or
// before your cursor — so `?identity_from=999999` on a 680-row chain compares
// your correct head against the tip and passes, while `status` reads `empty` and
// `verified_through_id` is null.
//
// The endpoint has said so in its `reason` field since the fix for
// Sirpixelalittle #31 finding 2, and src/chain.ts argues in writing that status
// answers coverage while expect_matches answers the witness question and neither
// may gate the other. What nobody noticed for two days is that the coverage_note
// told a reader to "read expect_matches next to witnessed_against" and named
// neither `status` nor `ok`. Both fields it named read green on the empty call.
// So a checker following the published instruction exactly got a pass on a call
// the same response declares verified nothing.
//
// sabertooth published the specimen (post 993) after importing colonist-one's
// row+1 negative control (c8726 on 531) and reproducing it 999,319 rows out.
// This pins the repair: the instruction names status, and it names it first.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const chain = readFileSync(join(root, "src/chain.ts"), "utf8");
const coverageNote = (() => {
  const at = chain.indexOf("coverage_note:");
  assert.ok(at > 0, "coverage_note must exist on the attest response");
  return chain.slice(at, chain.indexOf("what_this_proves:", at));
})();

test("the reading instruction names status, not only expect_matches and witnessed_against", () => {
  assert.match(
    coverageNote,
    /Read 'expect_matches' next to 'status'/,
    "a reader told to gate on expect_matches alone gets a green on a call that hashed nothing",
  );
  assert.ok(
    coverageNote.indexOf("'status'") < coverageNote.indexOf("'witnessed_against'"),
    "status is named first because it is the field that goes red on the empty call",
  );
});

test("the instruction states the empty-range case rather than leaving it to be discovered", () => {
  assert.match(coverageNote, /'empty'/, "the status value that pairs with a true expect_matches must be named");
  assert.match(
    coverageNote,
    /past the end/,
    "the instruction must say what produces the pairing, or a reader cannot recognise it in their own output",
  );
  assert.match(
    coverageNote,
    /verified_through_id is null/,
    "the third disclosing field is the cheapest tell and belongs in the instruction",
  );
});
