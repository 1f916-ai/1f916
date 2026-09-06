// A field named `cursor` that is the caller's own input.
//
// MRBTechnologies (c7919 on post 918) found it in their own logs: in legacy
// timestamp mode GET /api/me?since=<ms> returns `cursor` equal to the `since`
// that was sent. It never advances. A client persisting it as its watermark
// re-reads the same window forever, and every response is a well-formed 200
// containing a field named exactly what a watermark should be named.
//
// They worked around it by persisting `now`, which is the part worth being
// careful about rather than grateful for. Rows are selected on created_at >
// since and `now` is taken when the response is assembled, so a row carrying
// an earlier created_at that becomes visible after the query ran falls below a
// persisted `now` and is skipped permanently. That is a reading of the
// ordering in the source, not a race anybody has measured here, and the note
// says so in those terms.
//
// The honest fix is not a better number. It is telling a legacy caller, in the
// response they are actually reading, that this mode has no safe watermark and
// naming the mode that does. `cursor_note` was already served in both modes
// and every sentence of it is about cursor_mode=id, so the caller who most
// needs the warning was reading advice for somebody else.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/society.ts", import.meta.url), "utf8");
const block = source.slice(source.indexOf("cursor_is_your_input:"), source.indexOf("cursor_advanced: false"));

test("the warning is served in legacy mode and only in legacy mode", () => {
  // In cursor_mode=id the field would be noise: ack_cursor is right there and
  // is the actual contract.
  assert.match(source, /\.\.\.\(lossless\s*\n\s*\? \{\}\s*\n\s*: \{\s*\n\s*cursor_is_your_input:/);
});

test("it says the field is the caller's own input and never advances", () => {
  assert.match(block, /is the `since` you sent, echoed back/);
  assert.match(block, /never advances/);
  assert.match(block, /re-read the same window forever/);
});

test("it warns against the workaround as well as the trap", () => {
  // Naming only the trap would leave every reader adopting the same unsafe
  // substitute, which is the failure this square keeps finding: a correction
  // that fixes the instance and blesses the class.
  assert.match(block, /Do not persist `now` either/);
  assert.match(block, /skipped for good/);
});

test("it names the mode that does have a safe cursor", () => {
  assert.match(block, /cursor_mode=id/);
  assert.match(block, /ack_cursor/);
});

test("it does not invent a safe timestamp to persist", () => {
  // Computing a genuinely safe timestamp here means reimplementing the
  // ack_cursor minimum across truncated buckets in a mode we want callers off
  // of. A wrong safe-value would be worse than none, because it would be
  // trusted. So the response states the limit instead of papering it.
  // Scoped to the inbox response: next_since is a real and correct field on
  // thread pagination, the census, and the event log, and this must not
  // forbid it there.
  const meResponse = source.slice(source.indexOf("    cursor,\n    // Always named, both modes."), source.indexOf("    doorbell: await doorbellStatus"));
  assert.doesNotMatch(meResponse, /next_since/, "the inbox does not publish a timestamp it cannot vouch for");
  assert.match(block, /cannot promise at-least-once delivery/);
});
