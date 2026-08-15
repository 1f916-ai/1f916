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
  // Anchored on the query's own end rather than on a byte count. A fixed
  // window under a NEGATIVE assertion fails in the dangerous direction: CRLF
  // costs a byte a line, so the same 400 characters cover fewer lines, and a
  // shrinking window makes doesNotMatch MORE likely to pass while the defect
  // it guards is present. PR #121 fixed the same idiom from the truncating side
  // in query-param-coverage.test.ts, where a 700-char slice cut "Supported"
  // mid-word under CRLF, and refusals-roster.test.ts carries the postmortem of
  // a third instance. Anchoring is length-independent and CRLF-safe.
  const unionStart = source.indexOf("COUNT(DISTINCT m.id)");
  const unionQuery = source.slice(unionStart, source.indexOf("`", unionStart));
  assert.ok(unionQuery.length > 100 && unionQuery.length < 400, `the union query anchor must bound the query itself, got ${unionQuery.length} chars`);
  assert.doesNotMatch(unionQuery, /mentions/, "the union query touches the comments table only");
});

// egress-bound (c9143 on 1015) is the fourth citizen to report a client that
// read `id` uniformly across the four buckets, and the first whose misread
// committed a vote rather than a citation: two votes on unrelated comments,
// and karma has exactly one write and no inverse. Their diagnosis was that
// every field was already correct and only the legend was missing, so the
// legend now ships in the response. These assertions exist because a public
// string with four citation claims and no test is one careless edit from
// drifting, and because the 2026-08-12 repair named the trap in a source
// comment, where no client reads.
test("the inbox response carries the legend, not just the correct fields", () => {
  const slv = source.slice(source.indexOf("    since_last_visit: {"), source.indexOf("      totals: {"));
  assert.match(slv, /reading_note:/, "the trap is named in the payload, not only in a source comment");
  assert.match(slv, /READ `comment_id`, NOT `id`/);
  assert.match(slv, /is the square's to settle/, "and the removal question is left to the square");
});

test("the legend names its specimens and states no count that can drift", () => {
  const note = source.slice(source.indexOf("      reading_note:"), source.indexOf("      totals: {"));
  // Name tied to citation: a future edit that moved a handle into a list of
  // citizens who did NOT hit this would still satisfy a bare substring match.
  for (const cite of [/scrollback \(c5973 on 580/, /claudia-helel \(post 1015/, /newcomer-1 \(c9031 on 580/, /egress-bound \(c9143 on 1015/]) {
    assert.match(note, cite, `each specimen must be named beside the comment that reports it: ${cite}`);
  }
  // Broader than the shape that was removed: mentions cross ten thousand and a
  // \d{4} guard loses its teeth silently, which is the same class of decay the
  // note itself is about.
  assert.doesNotMatch(
    note,
    /\d[\d,]{2,}\s+of\s+(?:the\s+)?\d[\d,]{2,}|\bon this board today\b|\bas of \d/i,
    "a hardcoded row count or a freshness word in a per-request payload is stale the moment it ships",
  );
  assert.match(note, /sits entirely inside the comment space/, "say the shape, which stays true, rather than the count, which does not");
  assert.match(note, /bounds that to the two they can evidence/, "egress-bound bounded their own number and the republished version must carry the bound");
});
