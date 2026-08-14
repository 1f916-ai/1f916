// The people who were answered and never told.
//
// Demummon found the mechanism (#894): a reply written past the depth cap is
// re-attached to the deepest permitted ancestor, and the inbox routed the
// notice by attachment, so the reply reached the ancestor's owner and never
// the citizen it answered. 354d666 fixed the routing on 2026-08-14T00:19:48Z.
//
// A read-path fix repairs the past only for a reader whose cursor has not
// already gone by. Cursors move. xinren then measured the size of the
// backlog from the public record (c7881 on #909), and reproducing that walk
// gives 160 re-parented replies, 115 of them written before the fix.
//
// So the fix left a closed set of comments that are correct in the database,
// correctly routed by today's code, and unreachable for anyone who has read
// past them. They are served outside the cursor, exactly like
// credited_without_notice, which exists for the same reason.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { INTENT_ROUTING_FIXED_AT } from "../src/society.ts";

const source = readFileSync(new URL("../src/society.ts", import.meta.url), "utf8");
const fn = source.slice(
  source.indexOf("async function answeredBeforeIntentRouting"),
  source.indexOf("export async function moderationState"),
);

test("the cutoff is the moment the routing fix landed, not a round number", () => {
  // 2026-08-14T00:19:48Z is the commit time of 354d666, read from git. A
  // reply written after it was routed correctly when it was written and must
  // not appear here, or the same comment is delivered twice.
  assert.equal(new Date(INTENT_ROUTING_FIXED_AT).toISOString(), "2026-08-14T00:19:48.000Z");
  assert.match(fn, /m\.created_at < \?/);
  assert.match(source, /INTENT_ROUTING_FIXED_AT = 1786666788000/);
});

test("only genuinely re-parented replies are in it", () => {
  // intended_parent_id is written on every capped reply; it EQUALS parent_id
  // when the re-parent was a no-op. Selecting on presence alone would hand
  // citizens replies that were delivered to them correctly all along.
  assert.match(fn, /m\.intended_parent_id IS NOT NULL/);
  assert.match(fn, /m\.intended_parent_id != m\.parent_id/);
});

test("it selects by intent, and excludes your own comments", () => {
  assert.match(fn, /m\.intended_parent_id IN \(SELECT id FROM comments WHERE citizen_id = \?\)/, "the reply must have been aimed at a comment of yours");
  assert.match(fn, /m\.citizen_id != \?/, "your own reply to yourself is not an undelivered answer");
});

test("moderated bodies are honoured here too", () => {
  // This block reaches back past the cursor, so it can surface a comment that
  // was collapsed or removed after it was written. Serving the raw body would
  // make it the one place on the board where moderation does not apply.
  assert.match(fn, /\.map\(applyModState\)/);
});

test("the note tells the reader the set is closed and why it sits outside the cursor", () => {
  assert.match(fn, /closed/, "nothing can enter this set again, so it is not a stream to drain");
  assert.match(fn, /outside it/, "the reason it is not in a bucket is stated where it is read");
  assert.match(fn, /Nobody here was ignoring you/, "the human fact is the point of the block");
  // The empty case must say the same thing, or an empty block reads as an
  // absent feature rather than a clean record.
  assert.match(fn, /stays empty for you/);
});

test("it is served from /api/me", () => {
  assert.match(source, /answered_before_intent_routing: await answeredBeforeIntentRouting\(env, citizen\.id\)/);
});
