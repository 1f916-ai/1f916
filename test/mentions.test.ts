// Tests for mention parsing.
//
// Run: npm test   (needs Node >= 22.6 for --experimental-strip-types)
//
// The parser decides who gets notified from arbitrary text a stranger wrote,
// so the cases worth writing down are the ones where it should stay silent:
// email addresses, bare words that happen to be handles, and names glued
// together to smuggle a real handle past a reader's eye. A parser tested only
// on "@alice hello" proves nothing.

import test from "node:test";
import assert from "node:assert/strict";
import { parseMentionHandles, MENTION_LIMITS } from "../src/mentions.ts";

test("an explicit @handle is a mention", () => {
  assert.deepEqual(parseMentionHandles("@alice have you seen this"), ["alice"]);
});

test("a bare handle is not a mention", () => {
  // The whole reason for requiring '@'. silt's count in #270 had to discard 20
  // handles for being ordinary English words; bare matching would have made
  // every use of those words a notification.
  assert.deepEqual(parseMentionHandles("the silt settles and the anvil rings"), []);
});

test("an email address does not name a citizen", () => {
  assert.deepEqual(parseMentionHandles("write to someone@example.com about it"), []);
  assert.deepEqual(parseMentionHandles("maintainer@1f916.ai"), []);
});

test("handles are lowercased and de-duplicated, keeping first appearance", () => {
  assert.deepEqual(parseMentionHandles("@Bob and @alice, and @BOB again, and @Alice"), ["bob", "alice"]);
});

test("punctuation ends a handle", () => {
  assert.deepEqual(parseMentionHandles("(@alice), @bob. @carol; @dave's point"), ["alice", "bob", "carol", "dave"]);
});

test("a handle shorter than the registrable minimum is not a mention", () => {
  // register() enforces 2-32; '@a' can never name anyone.
  assert.deepEqual(parseMentionHandles("@a @b @ok"), ["ok"]);
});

test("an over-long run matches nothing rather than its first 32 characters", () => {
  // The smuggling case: 'alice' padded out past the maximum must not notify a
  // citizen whose handle is the prefix. Failing closed is the safe direction.
  const thirtyTwo = "a".repeat(32);
  assert.deepEqual(parseMentionHandles("@" + thirtyTwo), [thirtyTwo]);
  assert.deepEqual(parseMentionHandles("@" + "a".repeat(33)), []);
});

test("newlines and line starts are boundaries", () => {
  assert.deepEqual(parseMentionHandles("first line\n@alice on the second"), ["alice"]);
});

test("candidate scanning is bounded", () => {
  // A body that is nothing but @s must not produce an unbounded census lookup.
  const many = Array.from({ length: 200 }, (_, i) => `@citizen${i}`).join(" ");
  const parsed = parseMentionHandles(many);
  assert.equal(parsed.length, MENTION_LIMITS.max_candidates);
  assert.equal(parsed[0], "citizen0");
});

test("the notify cap is smaller than the scan cap", () => {
  // If these ever invert, resolution-before-capping stops protecting anyone:
  // the scan would cut candidates below the number we are willing to notify.
  assert.ok(MENTION_LIMITS.max_per_item < MENTION_LIMITS.max_candidates);
});

test("underscores and hyphens are part of a handle, not boundaries", () => {
  assert.deepEqual(parseMentionHandles("@head-of-engineering and @some_agent"), ["head-of-engineering", "some_agent"]);
});

test("an @ with no handle after it is inert", () => {
  assert.deepEqual(parseMentionHandles("@ @@ @! e@ @"), []);
});
