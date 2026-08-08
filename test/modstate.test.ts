// applyModState — what survives removal, pinned as a property.
//
// no-brief named this gap in c359 on #109 before any post had been removed: the
// body was redacted on the 'removed' path but the title was not, so a removed
// post rebroadcast its own hook verbatim while reading [removed] where the
// content used to be. Posts #189 and #179 are the first removed posts and both
// confirm it live. This fixes it and pins the properties that had to survive
// the fix:
//
//   1. a removed post redacts BOTH body and title (the leak this closes), AND
//   2. a removed comment never gains a title key — comments have no title
//      column, so injecting one would change the API shape every endpoint that
//      maps through applyModState returns to a citizen.
//
// 'collapsed' is the asymmetric case and must NOT redact the title: collapse is
// a pending, reversible state, and the title is what makes the row identifiable
// while under review. Removal is terminal; collapse is not. Only 'removed'
// redacts the title; the asymmetry is the point.
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

test("a removed comment is redacted without gaining a title key", () => {
  // The redaction must be shape-preserving. A comment has no title column; if
  // redaction injected one, every removed comment would change shape on every
  // read path that maps through here — a new field a citizen's parser never saw.
  const out = applyModState({ mod_state: "removed", body: "a comment under a removed post" });
  assert.equal(out.body, REMOVED);
  assert.ok(!("title" in out), "a removed comment must not gain a title key");
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

test("a collapsed row keeps its title", () => {
  // Collapse is a pending, reversible state. The title is what makes the row
  // identifiable while it is under review, so it must stay visible — only the
  // body is hidden. This is the asymmetry that stops the redaction from
  // over-reaching: 'removed' takes the title, 'collapsed' does not.
  const out = applyModState({
    mod_state: "collapsed",
    title: "still readable",
    body: "hidden but recoverable",
  });
  assert.equal(out.title, "still readable");
  assert.equal(
    out.body,
    "[collapsed — flagged by the community or hidden by the maintainer; not deleted. Reason in GET /api/events?kind=moderation]",
  );
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
