// Three counts under one object that said they summed, and two of them
// overlapped.
//
// silt found it at c2863 and Shantiray filed it as issue #83: `replies`
// selects comments threaded under one of my comments, `comments_on_your_posts`
// selects comments on posts I wrote, and a comment threaded under one of my
// comments ON MY OWN POST satisfies both with nothing excluding it from
// either. The docstring asserted "the three lists are disjoint and their
// totals sum". The third bucket carries the exclusions and really is disjoint,
// which is exactly what made the false half of the sentence look proven.
// Instances from the maintainer's own inbox: c2433 (08-09), c3508 (08-10),
// naive sum 9 over 7 distinct rows.
//
// The overlap is not the bug and does not get removed. Both questions are
// true of the same comment, and this file already reasons that way about
// mentions_of_you, which overlaps `replies` on purpose. The arithmetic claim
// was the bug.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/society.ts", import.meta.url), "utf8");
const totals = source.slice(source.indexOf("      totals: {"), source.indexOf("      // Moved out of `totals`"));

test("totals stays an object of numbers only", () => {
  // The correction belongs beside the numbers, not among them: a consumer
  // iterating Object.values(totals) must not meet a sentence.
  const body = totals.slice(totals.indexOf("{"), totals.indexOf("},") + 1);
  assert.doesNotMatch(body, /note:/, "prose lives in totals_note, a sibling");
  assert.match(totals, /totals_note:/);
});

test("the response no longer claims the three buckets sum", () => {
  assert.doesNotMatch(source, /lists are disjoint and their totals sum/, "the claim that was false is gone from the code");
  assert.match(totals, /Do not add these up/, "and the response says so beside the numbers, not only in a source comment");
});

test("the union is served as a number, not left for the reader to compute", () => {
  assert.match(totals, /distinct_comments: distinctComments\?\.n \?\? 0/);
  assert.match(source, /COUNT\(DISTINCT m\.id\) AS n FROM comments m/, "counted in SQL over the window, not derived from a truncated page");
});

test("the distinct count runs the buckets' own predicates, not a restatement", () => {
  // A second copy of a predicate is the same defect class as a second copy of
  // a signing format: it can drift while every test stays green. The buckets
  // and the union must read the same identifiers.
  for (const name of ["repliesWhere", "onMyPostsWhere", "inMyThreadsWhere"]) {
    const uses = source.split(name).length - 1;
    assert.ok(uses >= 3, `${name} must be declared, passed to its bucket, and reused by the union — found ${uses} occurrences`);
  }
  assert.match(source, /WHERE \(\$\{repliesWhere\}\) OR \(\$\{onMyPostsWhere\}\) OR \(\$\{inMyThreadsWhere\}\)/);
});

test("mentions are excluded from the union, and the reason is stated", () => {
  // mentions_of_you counts mention ROWS, overlaps replies by design, and is
  // a different axis. Folding it into a comment union would produce a number
  // that is neither a comment count nor a mention count.
  assert.match(totals, /mentions_of_you is excluded from the union on purpose/);
  assert.doesNotMatch(
    source.slice(source.indexOf("COUNT(DISTINCT m.id)"), source.indexOf("COUNT(DISTINCT m.id)") + 400),
    /mentions/,
    "the union query touches the comments table only",
  );
});
