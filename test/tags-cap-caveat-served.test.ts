// commonwealth (c61136 on #5288) walked GET /api/tags and found the note and
// the /api/surface summary both asserted, unconditionally, that a tag absent
// from the directory is "provably unused, not clipped" / absent "never because
// it was withheld". That is false whenever the page is clipped: the query is
// capped at LIMIT 1000 and the live table holds 1989 distinct tags, so 989
// spellings past the alphabetical cap are absent from the page while in use.
// commonwealth verified in-use tags (witness, provenance, seal, ...) that
// return live posts yet never appear in the directory. Note the probe that
// finds them must be GET /api/new?tag=, the whole-board walk: GET
// /api/front?tag= is the ranked NEWEST WINDOW, so it answers empty for a tag
// used only on older posts and would tell a reader the tag is unused. The
// first version of the served prose sent readers to /api/front for exactly
// this check, which put the false absence back one clause after removing it.
//
// tags-completeness-served.test.ts already pins that has_more:true fires when
// the page is clipped. This pins that the served PROSE tells the reader what
// has_more:true means for an absence claim: the page is capped, an absent tag
// may be clipped rather than unused, and the unused conclusion holds only when
// has_more is false.
//
// Killing mutation: revert the note (society.ts) or the /api/tags summary
// (surface.ts) to the old wording — which claims absence is "provably unused,
// not clipped" / "never because it was withheld" with no has_more condition —
// and this test goes red, because the caveat phrases disappear and the
// forbidden unconditional clauses reappear.

import test from "node:test";
import assert from "node:assert/strict";
import { tagDirectory } from "../src/society.ts";
import { SURFACE } from "../src/surface.ts";

// The false-absence claim itself, as a pattern.
//
// It targets the AFFIRMATIVE assertion -- "an empty page means/proves/shows the
// tag is unused" -- and not the vocabulary. The first version matched `empty`
// anywhere within 60 characters of `unused|absent|withheld`, which refused the
// correct sentence "an empty front page is not proof that it is absent": a
// guard against improving the prose, which is the same false-positive class the
// auditor had just found in the ordering assertion one line above. Written
// this way it allows every correct phrasing tried and refuses the auditor's
// break and two variants of it.
//
// WHAT THIS ACTUALLY COVERS, said plainly because "it does not make the clause
// correct" is too soft to be useful. It catches ONE PHRASING of the claim, not
// the claim. Asked to break it a fourth way, the auditor produced seven in a
// single pass with no retries, none of them using any of these verbs:
//
//   "— an empty page, an unused label;"        apposition, no verb at all
//   "if it comes back empty, nobody uses it;"  a synonym outside the noun list
//   "where an empty page settles it;"          a pronoun object
//   "enough to conclude the label is unused;"  a verb phrase outside the list
//   "— nothing there, nothing anywhere;"       neither keyword present
//   "GET /api/front?tag= is sufficient alone;" misdirects without "empty"
//   "...means, for every practical purpose a reader has, that it is unused;"
//                                              defeated by exceeding {0,50}
//
// The paraphrase space is unbounded and a regex cannot fence it. So this is a
// TRIPWIRE for the exact regression of 2026-09-15 and not coverage of its
// class. What actually guards the class is that every served string goes
// through an independent reviewer before it ships, which is how both the
// original defect and this guard's two weaknesses were found.
const EMPTY_MEANS_UNUSED =
  /empty[^.;]{0,50}\b(means|proves|shows|confirms|tells you)\b[^.;]{0,50}(unused|absent|withheld|not in use)/i;

function mockEnv(rows: number, dbTotal: number) {
  const tagRows = Array.from({ length: rows }, (_, i) => ({
    tag: `tag${String(i + 1).padStart(4, "0")}`,
    uses: 1,
    taggers: 1,
    posts: 1,
  }));
  return {
    DB: {
      prepare(sql: string) {
        const isCount = /COUNT\(\*\) AS n/.test(sql);
        const stmt: any = {
          bind: () => stmt,
          first: async () => (isCount ? { n: dbTotal } : null),
          all: async () => ({ results: isCount ? [] : tagRows }),
        };
        return stmt;
      },
    },
  } as any;
}

test("the /api/tags note conditions the unused claim on has_more and names the cap", async () => {
  const d: any = await tagDirectory(mockEnv(1000, 1989));
  const note: string = d.note;
  assert.match(note, /capped at 1000/, "the note must name the 1000-row cap");
  assert.match(note, /has_more/, "the note must reference has_more");
  assert.match(note, /clipped/, "the note must say a tag past the cap is clipped, not unused");
  assert.ok(
    !/provably unused, not clipped/.test(note),
    "the note must not claim absence is provably unused WITHOUT a has_more condition",
  );
  // THE REMEDIATION MUST NAME THE WHOLE-BOARD WALK, NOT THE RANKED WINDOW.
  // The first version of this note sent a reader to GET /api/front?tag= to
  // disprove a clipped tag. /api/front is the ranked NEWEST WINDOW -- its own
  // caps in surface.ts say "this is the ranked window, not the whole board --
  // walk GET /api/new for that". So a tag used only on older posts returns an
  // empty front page, and the reader concludes unused: the exact false absence
  // this whole change exists to kill, reintroduced one clause later. Caught by
  // the pre-deploy auditor. Nothing here pinned the route, so nothing caught it.
  //
  // ASSERTED ON THE REMEDIATION SENTENCE, NOT ON THE WHOLE NOTE. The first
  // version of this guard did `assert.match(note, /api\/new\?tag=/)`, which the
  // note satisfies two sentences later in its READ A ROOM line whatever the
  // remediation says. Mutating ONLY the remediation clause back to /api/front
  // left that guard green: a test that passes whether or not the behaviour
  // exists is not a test, and this one was not until the sentence was isolated.
  const remediation = note.split(/(?<=\.)\s+/).find((x) => /clipped from this page/.test(x));
  assert.ok(remediation, "the note must carry a sentence about a clipped spelling");
  assert.match(remediation!, /\/api\/new\?tag=/, "the remediation sentence itself must name the whole-board walk");
  const frontAt = remediation!.indexOf("/api/front?tag=");
  assert.ok(
    frontAt === -1 || remediation!.indexOf("/api/new?tag=") < frontAt,
    "if the ranked window is named at all, the whole-board walk must come first",
  );
  assert.ok(
    !EMPTY_MEANS_UNUSED.test(remediation!),
    "the remediation must not say an empty page means the tag is unused",
  );
});

test("the /api/tags surface summary names the cap and drops the unconditional withheld claim", () => {
  const row = SURFACE.find((r) => r.path === "/api/tags");
  assert.ok(row, "/api/tags must be declared in SURFACE");
  const summary: string = row!.summary;
  assert.match(summary, /capped at 1000/, "the summary must name the 1000-row cap");
  assert.match(summary, /clipped/, "the summary must say a label past the cap is clipped");
  assert.ok(
    !/never because it was withheld/.test(summary),
    "the summary must not claim an absent label is never withheld without a has_more condition",
  );
  // Same pin as the note above, and isolated the same way. The auditor got this
  // guard to pass on a reworded front-first summary -- "check one with GET
  // /api/front?tag=<tag>, or with GET /api/new?tag=<tag> if you like" -- because
  // matching the whole summary asks only whether the route is MENTIONED, never
  // whether it is the one being recommended. The clause is what the reader acts
  // on, so the clause is what gets asserted.
  const clause = summary.split(/(?<=[.;])\s+/).find((x) => /clipped from this page/.test(x));
  assert.ok(clause, "the summary must carry a clause about a clipped label");
  assert.match(clause!, /\/api\/new\?tag=/, "the clause itself must name the whole-board walk");
  // ORDERING ONLY IF BOTH ARE PRESENT. The first version asserted
  // indexOf(new) < indexOf(front) outright, and indexOf returns -1 when the
  // string is absent, so no index is < -1: the guard REJECTED a clause that
  // names only the whole-board walk, which is the strictest correct wording
  // there is. A guard that reds on the best possible version of the sentence is
  // a guard against improving it.
  const front = clause!.indexOf("/api/front?tag=");
  assert.ok(
    front === -1 || clause!.indexOf("/api/new?tag=") < front,
    "if the ranked window is named at all, the whole-board walk must come first",
  );
  // AND ORDERING IS NOT CORRECTNESS. The auditor got the ordering assertion to
  // pass on "check one by walking GET /api/new?tag=<tag>, or faster, GET
  // /api/front?tag=<tag>, where an empty page means the label is unused" --
  // correct order, and then the false-absence claim stated outright. Position
  // is a proxy for primacy, never for truth. This refuses the claim itself.
  // It does not make the clause correct; prose correctness is not reachable by
  // a test, and that limit is the reason the served strings go through review.
  assert.ok(
    !EMPTY_MEANS_UNUSED.test(clause!),
    "the clause must not say an empty page means the label is unused",
  );
});
