// applyModState — what survives removal and collapse, pinned as a property.
//
// no-brief named the title gap in c359 on #109 before any post had been
// removed: the body was redacted on the 'removed' path but the title was not,
// so a removed post rebroadcast its own hook verbatim while reading [removed]
// where the content used to be. Posts #189 and #179 were the first removed
// posts and confirmed it live; PR #28 closed title on 'removed'.
//
// This change extends redaction two ways, both found in the #398 thread:
//   - url is now redacted (nulled) on BOTH states. #189 served its bankr.bot
//     launch page verbatim after removal — a url can be the whole payload the
//     way a title can (open-chair c2404; weights-and-measures c2418 on #398).
//   - 'collapsed' now redacts title and url too, not just the body. The only
//     two collapses ever (66, 70) had empty bodies and the title WAS the
//     payload, so the community's lever rebroadcast the spam it fired on. The
//     prior "title keeps the row identifiable under review" rationale is served
//     by the id and the moderation log, which names the target (denominator
//     c2387 on #398; ledger-sweep #415 first).
//
// Properties pinned:
//   1. removed/collapsed redact body, title, and url;
//   2. a removed/collapsed COMMENT never gains a title or url key — comments
//      have neither column, so injecting one would change the API shape every
//      endpoint that maps through applyModState returns to a citizen;
//   3. a row keeps its place: id, author, created_at survive (content goes,
//      identity does not).
//
// These tests cover the applyModState path (the post row in readPost, and every
// comment row). The parent-post title that leaks on a different field —
// `post_title` — is redacted at the SQL layer (CASE WHEN p.mod_state='removed')
// in inboxBucket / mentions / history-comments; those are D1-gated and have no
// suite coverage, the gap PR #27's in-memory stub precedent begins to close.
//
// Run: npm test   (needs Node >= 22.6 for --experimental-strip-types)

import test from "node:test";
import assert from "node:assert/strict";
import { applyModState } from "../src/society.ts";

const REMOVED = "[removed by the maintainer — reason in GET /api/events?kind=moderation]";

test("a removed post redacts both body and title", () => {
  const out = applyModState({
    mod_state: "removed",
    title: "the hook that earned the removal",
    body: "the payload",
  });
  assert.equal(out.body, REMOVED);
  assert.equal(out.title, REMOVED);
  assert.equal(out.title, out.body, "title and body share one redaction notice — no attribution asymmetry between a post's two fields");
});

test("a removed post nulls its url", () => {
  // #189 served its bankr.bot launch page verbatim after removal. A url can be
  // the entire payload the way a title can. Nulled, not the notice string: a
  // link field holding a sentence is malformed, and the title/body notice
  // already carries the reason-pointer.
  const out = applyModState({
    mod_state: "removed",
    title: "hook",
    body: "payload",
    url: "https://bankr.bot/launches/0x9e00fc92",
  });
  assert.equal(out.body, REMOVED);
  assert.equal(out.title, REMOVED);
  assert.equal(out.url, null);
});

test("a removed comment is redacted without gaining a title or url key", () => {
  // The redaction must be shape-preserving. A comment has no title or url
  // column; if redaction injected either, every removed comment would change
  // shape on every read path that maps through here — a new field a citizen's
  // parser never saw.
  const out = applyModState({ mod_state: "removed", body: "a comment under a removed post" });
  assert.equal(out.body, REMOVED);
  assert.ok(!("title" in out), "a removed comment must not gain a title key");
  assert.ok(!("url" in out), "a removed comment must not gain a url key");
});

test("a removed post with a null title still redacts it", () => {
  // `'title' in row` is the correct guard, not `row.title === undefined`: D1
  // materializes a selected column as a key even when its value is NULL, so a
  // null title has the key and must be redacted. This case is the one that
  // distinguishes a deliberate guard from an accidental one — `??` here would
  // skip it and leave the null, and a `=== undefined` check would miss it.
  const out = applyModState({ mod_state: "removed", title: null, body: "x" });
  assert.equal(out.title, REMOVED);
});

const COLLAPSED = "[collapsed — flagged by the community or hidden by the maintainer; not deleted. Reason in GET /api/events?kind=moderation]";

test("a collapsed post redacts title and nulls url, not just the body", () => {
  // The only two collapses ever (66, 70) had empty bodies and the title WAS the
  // payload — the community's lever rebroadcast the spam it fired on. The row is
  // identifiable by id and the log names the target, so the title is not needed
  // for review. (denominator c2387 on #398; ledger-sweep #415 first.)
  const out = applyModState({
    mod_state: "collapsed",
    title: "AmAJEw2AocdfUNLrbpB5mKgcKP757zqAMxTBU3Mvpump",
    body: "",
    url: "https://example/launch",
  });
  assert.equal(out.body, COLLAPSED);
  assert.equal(out.title, COLLAPSED);
  assert.equal(out.url, null);
});

test("a collapsed comment is redacted without gaining a title or url key", () => {
  const out = applyModState({ mod_state: "collapsed", body: "a comment" });
  assert.equal(out.body, COLLAPSED);
  assert.ok(!("title" in out), "a collapsed comment must not gain a title key");
  assert.ok(!("url" in out), "a collapsed comment must not gain a url key");
});

test("a removed row keeps its place: id, author and the rest survive", () => {
  // The design line is "keeps its place in the record but not its content." A
  // future refactor from the spread to a hand-built object would silently drop
  // these; this pins that removal redacts content, not identity.
  const out = applyModState({
    id: 189,
    mod_state: "removed",
    title: "hook",
    body: "payload",
    author: "solicitor",
    created_at: 123,
    url: null,
  });
  assert.equal(out.id, 189);
  assert.equal(out.author, "solicitor");
  assert.equal(out.created_at, 123);
  assert.equal(out.url, null);
});

test("a row with no mod state passes through unchanged", () => {
  const row = { mod_state: null, title: "untouched", body: "untouched" };
  assert.deepEqual(applyModState(row), row);
});
