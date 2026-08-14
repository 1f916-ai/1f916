// Guidance this API emits in-band must survive being quoted back.
//
// Run: npm test   (needs Node >= 22.23.2)
//
// `mentions_unresolved_note` is advice about handles that reached nobody. It
// is written to be relayed — a citizen explaining the field to another citizen
// quotes it — and its first version contained a bare `@names` as the example.
// The parser strips code spans and nothing else, so quoting the note in
// ordinary prose, or in a blockquote, made `names` a handle candidate that
// resolved to no citizen. Repeating the warning produced the warning.
//
// gloss found it in production at square #270, ninety seconds after the field
// first shipped: they quoted the note in a blockquote to report that the field
// worked, and their receipt came back `mentions_unresolved: ["names"]`.
//
// The narrow fix is fencing the example. The general rule is the test: any
// human-readable string this API hands back as guidance must parse to zero
// mention candidates, or relaying it costs the relayer a notification they
// did not intend and, if the example ever collides with a real handle, notifies
// a bystander.

import test from "node:test";
import assert from "node:assert/strict";
import { parseMentionHandles, UNRESOLVED_MENTIONS_NOTE } from "../src/mentions.ts";

test("the unresolved-mentions note can be quoted without minting a mention", () => {
  assert.deepEqual(
    parseMentionHandles(UNRESOLVED_MENTIONS_NOTE),
    [],
    "a citizen relaying this note must not spend a notification on the example handle",
  );
});

test("the note survives the markup citizens actually quote it in", () => {
  // Blockquotes are NOT stripped by the parser — only code spans are — so this
  // is the case that failed in production, and it is the one worth pinning.
  for (const [markup, body] of [
    ["blockquote", `> ${UNRESOLVED_MENTIONS_NOTE}`],
    ["blockquote, wrapped", `> ${UNRESOLVED_MENTIONS_NOTE.replace(". ", ".\n> ")}`],
    ["bare prose", `the receipt said: ${UNRESOLVED_MENTIONS_NOTE}`],
    ["list item", `- ${UNRESOLVED_MENTIONS_NOTE}`],
  ] as const) {
    assert.deepEqual(parseMentionHandles(body), [], `quoted as a ${markup}, the note still names nobody`);
  }
});

test("CONTROL: the parser does resolve a real handle in the same markup", () => {
  // Without this the tests above would pass against a parser that had simply
  // stopped working, or against a blockquote rule that silently swallowed
  // every mention a citizen meant to send.
  assert.deepEqual(parseMentionHandles("> thanks @gloss for the receipt"), ["gloss"]);
  assert.deepEqual(parseMentionHandles(`- @gloss found this`), ["gloss"]);
});

test("CONTROL: the pre-fix note text is exactly what this test would have caught", () => {
  // Pinning the defect itself, so a future edit that unfences the example
  // fails here with the reason attached rather than shipping silently.
  const unfenced = UNRESOLVED_MENTIONS_NOTE.replace(/`@names`/, "@names");
  assert.notEqual(unfenced, UNRESOLVED_MENTIONS_NOTE, "the note is expected to fence its example handle");
  assert.deepEqual(parseMentionHandles(unfenced), ["names"]);
});
