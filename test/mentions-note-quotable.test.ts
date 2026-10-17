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
import { MENTIONS_IN_CODE_NOTE, MENTIONS_OVER_CAP_NOTE, MENTIONS_TRUNCATED_NOTE, mentionsInCode, mentionsOverCap, parseMentionHandles, UNRESOLVED_MENTIONS_NOTE } from "../src/mentions.ts";

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

test("the in-code note warns nobody, and mints no in-code count, when quoted", () => {
  // This note is one field over from the trap above, and the fix is the
  // OPPOSITE: UNRESOLVED_MENTIONS_NOTE fences its `@example` to be safe, but a
  // fenced handle is exactly what mentions_in_code counts, so fencing an
  // example here would make quoting the warning produce the warning. The note
  // therefore carries no `@`-handle at all — in prose or in code — and both
  // checks must read zero for every markup a citizen quotes it in.
  for (const [markup, body] of [
    ["verbatim", MENTIONS_IN_CODE_NOTE],
    ["blockquote", `> ${MENTIONS_IN_CODE_NOTE}`],
    ["bare prose", `the receipt said: ${MENTIONS_IN_CODE_NOTE}`],
    ["code span", `\`${MENTIONS_IN_CODE_NOTE}\``],
  ] as const) {
    assert.deepEqual(parseMentionHandles(body), [], `quoted as a ${markup}, the note names nobody`);
    assert.equal(mentionsInCode(body, "writer"), 0, `quoted as a ${markup}, the note mints no in-code count`);
  }
});

test("the truncated-note warns nobody, and mints no in-code count, when quoted", () => {
  // MENTIONS_TRUNCATED_NOTE is served on a write receipt when the notify cap
  // bit (WQ-332). Like MENTIONS_IN_CODE_NOTE it carries no `@`-handle at all —
  // in prose or in code — so a citizen relaying it spends no notification and
  // mints no in-code count. The backticked field names it does carry (mentioned,
  // credited) hold no `@`, so stripping the code spans leaves nothing to match.
  for (const [markup, body] of [
    ["verbatim", MENTIONS_TRUNCATED_NOTE],
    ["blockquote", `> ${MENTIONS_TRUNCATED_NOTE}`],
    ["bare prose", `the receipt said: ${MENTIONS_TRUNCATED_NOTE}`],
    ["code span", `\`${MENTIONS_TRUNCATED_NOTE}\``],
  ] as const) {
    assert.deepEqual(parseMentionHandles(body), [], `quoted as a ${markup}, the note names nobody`);
    assert.equal(mentionsInCode(body, "writer"), 0, `quoted as a ${markup}, the note mints no in-code count`);
  }
});

test("the over-cap note warns nobody, mints no in-code count, and adds to no over-cap count, when quoted (WQ-347)", () => {
  // MENTIONS_OVER_CAP_NOTE is served when a body names more than max_candidates
  // distinct handles (tally-stick, c105199). Like the two notes above it carries
  // no `@`-handle at all — in prose or in code — so relaying it spends no
  // notification, mints no in-code count, and (its own concern) cannot itself
  // read as handles past the cap. The @-count of the note must stay zero or a
  // citizen quoting a receipt would be told others were silently dropped.
  for (const [markup, body] of [
    ["verbatim", MENTIONS_OVER_CAP_NOTE],
    ["blockquote", `> ${MENTIONS_OVER_CAP_NOTE}`],
    ["bare prose", `the receipt said: ${MENTIONS_OVER_CAP_NOTE}`],
    ["code span", `\`${MENTIONS_OVER_CAP_NOTE}\``],
  ] as const) {
    assert.deepEqual(parseMentionHandles(body), [], `quoted as a ${markup}, the note names nobody`);
    assert.equal(mentionsInCode(body, "writer"), 0, `quoted as a ${markup}, the note mints no in-code count`);
    assert.equal(mentionsOverCap(body), 0, `quoted as a ${markup}, the note names no handles past the cap`);
  }
});

test("CONTROL: a fenced handle IS what mentionsInCode counts", () => {
  // Without this, the test above would pass against a mentionsInCode that had
  // simply stopped counting anything — then an unfenced example slipping into
  // the note would not be caught.
  assert.equal(mentionsInCode("thanks `@gloss`", "writer"), 1);
  assert.equal(mentionsInCode("thanks @gloss", "writer"), 0, "a prose handle is not in-code");
});

test("CONTROL: the pre-fix note text is exactly what this test would have caught", () => {
  // Pinning the defect itself, so a future edit that unfences the example
  // fails here with the reason attached rather than shipping silently.
  const unfenced = UNRESOLVED_MENTIONS_NOTE.replace(/`@names`/, "@names");
  assert.notEqual(unfenced, UNRESOLVED_MENTIONS_NOTE, "the note is expected to fence its example handle");
  assert.deepEqual(parseMentionHandles(unfenced), ["names"]);
});
