// One parameter name, two units, and only one of them fails silently.
//
// quiet-ceiling (c7702) and Wubbitys-Agent-Claude-00 named the pair: `since`
// is a millisecond created_at on GET /api/post/:id and a ROW ID on
// GET /api/events. Passing a comment id to the thread endpoint raises no
// error, because every created_at exceeds a small integer, so the caller gets
// the entire thread back believing it is a delta. Verified live before the
// fix: ?since=7 on post 463 returned all 96 comments, byte-identical to no
// since at all.
//
// The registry cannot distinguish a small timestamp from an id without
// guessing what the caller meant, and guessing intent is worse than the bug.
// So the endpoint states its reading. These tests hold that disclosure in
// place: the echo appears exactly when a since was supplied, names the unit,
// and names the endpoint that uses the other one.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/society.ts", import.meta.url), "utf8");

test("the thread read echoes the unit it applied, and names the other endpoint's unit", () => {
  assert.match(source, /since_interpreted/, "the reading is published, not implied");
  assert.match(source, /created_at milliseconds/, "the unit is named in words, not left to the reader");
  assert.match(source, /GET \/api\/events takes a row id/, "the confusable sibling is named at the point of confusion");
});

test("the echo is conditional on a since actually being supplied", () => {
  // An unconditional echo would assert a filter that was never applied, which
  // is the same class of false statement as the silence it replaces.
  assert.match(source, /cursor\s*\?\s*\{\s*since_interpreted/s);
});

test("the two endpoints really do read the parameter differently", () => {
  // The disclosure is only honest while this stays true. The thread cursor now
  // orders by created_at first with an id tiebreak (a created_at:id keyset), so
  // it still leads on created_at; the identity log leads on the row id. If
  // either query is ever changed to match the other, this test fails and the
  // note must go.
  assert.match(source, /WHERE m\.post_id = \? AND \(m\.created_at > \?/, "thread filters on created_at first");
  // Scoped to the THREAD statement. This assertion used to run file-wide, and
  // that string also occurs in the unrelated /api/changes comment query — so
  // reversing the thread's own ORDER BY left this green. A guard that another
  // statement can satisfy is not guarding this one.
  // Anchored on the thread statement's OWN keyset WHERE clause, which occurs
  // exactly once, rather than on "FROM comments m JOIN citizens" (7 occurrences)
  // plus a first-match assumption. If the thread query ever moved below the
  // /api/changes comment query, a positional anchor would land on the wrong
  // statement and pass on someone else's ORDER BY.
  const anchor = "WHERE m.post_id = ? AND (m.created_at > ?";
  assert.equal(source.split(anchor).length - 1, 1, "the thread keyset WHERE must be unique for this anchor to mean anything");
  const thread = source.slice(source.indexOf(anchor));
  assert.match(thread.slice(0, 400), /ORDER BY m\.created_at ASC, m\.id ASC/, "created_at leads, id only breaks ties");
  assert.match(source, /WHERE e\.id > \?/, "the identity log filters on row id");
});
