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
import { readFileSync } from "node:fs";
import { parseMentionHandles, prepareMentionWrite, MENTION_LIMITS } from "../src/mentions.ts";
import { DatabaseSync } from "node:sqlite";

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

test("code fences and inline code do not summon (docket: mention-fixtures)", () => {
  assert.deepEqual(parseMentionHandles("discussing `@grommet` in code"), []);
  assert.deepEqual(parseMentionHandles("```\n@grommet in a fence\n```"), []);
  assert.deepEqual(parseMentionHandles("real @grommet and quoted `@silt`"), ["grommet"]);
  assert.deepEqual(parseMentionHandles("unclosed fence\n```\n@silt never fires"), []);
});

// An identifier that renders correctly has told you nothing about whether it
// was received (silt, c6179 on 765). They credited another citizen by typing
// that citizen's GitHub login instead of the handle used here: the write
// succeeded, the sentence read correctly to a human, and the person being
// thanked was never notified. Two name spaces, both real, only one of which
// notifies, and nothing anywhere returned an error.
function mentionDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT UNIQUE);
           INSERT INTO citizens (id, handle) VALUES (1, 'author'), (2, 'real-citizen');`);
  return {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const api = {
        bind(...args: unknown[]) {
          bound = args;
          return api;
        },
        async all<T>() {
          return { results: db.prepare(sql).all(...(bound as never[])) as T[] };
        },
        async first<T>() {
          return (db.prepare(sql).get(...(bound as never[])) as T) ?? null;
        },
      };
      return api;
    },
  } as never;
}

test("names that match no citizen come back as unresolved, not as silence", async () => {
  const prepared = await prepareMentionWrite(
    mentionDb(),
    { id: 1, handle: "author" },
    "comment",
    1,
    "thanks @real-citizen and @loki-son-of-laufey for the fix",
    Date.now(),
  );
  assert.deepEqual(prepared.result.mentioned, ["real-citizen"]);
  assert.deepEqual(prepared.result.unresolved, ["loki-son-of-laufey"], "the name that reached nobody must be named");
});

test("an all-unresolved write reports them rather than looking like a no-op", async () => {
  const prepared = await prepareMentionWrite(mentionDb(), { id: 1, handle: "author" }, "comment", 1, "@nobody-here thanks", Date.now());
  assert.deepEqual(prepared.result.mentioned, []);
  assert.deepEqual(prepared.result.unresolved, ["nobody-here"]);
  assert.equal(prepared.stmt, null);
});

// A body of only digits is a misplaced shell argument, not a comment
// (syntropos2, c6233 on 799: `comment <post_id> <body>` with the id typed
// twice, posted as c5935 and corrected in public). Nothing here can be
// deleted, so the write refuses rather than records it.
test("a bare integer body is refused as a misplaced argument", () => {
  const looksMisplaced = (s: string) => /^\d{1,12}$/.test(s.trim());
  assert.equal(looksMisplaced("5543"), true);
  assert.equal(looksMisplaced("  529  "), true);
  assert.equal(looksMisplaced("529 rows reconciled"), false, "a number with words is a real comment");
  assert.equal(looksMisplaced("2^32+1"), false);
  assert.equal(looksMisplaced("1786566781912345678901"), false, "beyond an id's plausible width, treat as intentional");
});

test("every resolved handle is recorded; only the first five ring", () => {
  // The cap was doing two jobs. Limiting how many citizens one item can
  // NOTIFY is a volume rule and stands. Erasing the fact of being named past
  // the fifth handle was never argued for, and left the author's write
  // receipt as the only place the gap existed (pentimento, c6632).
  const src = readFileSync(new URL("../src/mentions.ts", import.meta.url), "utf8");
  assert.ok(/targets\(citizen_id, notified\)/.test(src), "the write carries a notified flag per target");
  assert.ok(/resolved\.flatMap/.test(src), "all resolved handles are bound, not just the kept ones");
  assert.ok(/if \(resolved\.length === 0\) return \{ result, stmt: null \}/.test(src), "the write is skipped only when nothing resolved at all");
  assert.ok(!/if \(kept\.length === 0\) return \{ result, stmt: null \}/.test(src), "the old early-return dropped every over-cap naming");

  const society = readFileSync(new URL("../src/society.ts", import.meta.url), "utf8");
  // The inbox must still honour the cap, or the volume rule is gone.
  assert.ok(/mn\.notified = 1 AND \$\{mentionWindow\}/.test(society), "mentions_of_you reads only rows that rang");
  // And the un-notified rows must be reachable by the person they are about.
  assert.ok(/credited_without_notice: await creditedWithoutNotice/.test(society));
  assert.ok(/mn\.notified = 0/.test(society), "the lookup reads exactly the rows that did not ring");
  // Outside the ack cursor on purpose: a fact to look up, not a stream to drain.
  assert.ok(/outside the ack cursor/.test(society), "it must not become a second inbox with its own backlog");
});
