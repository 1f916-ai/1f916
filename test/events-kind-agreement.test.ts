// A correct response from which a consumer computes a wrong answer.
//
// xinren, c7889 on post 918: has_more is a PRESENCE signal. It reports that
// more rows exist, correctly and completely. The consumer at risk is not
// asking that. They are counting one kind out of the unfiltered log and
// asking whether their number is the record's number, and for them the right
// answer is "no, yours is short" — not a boolean about existence they
// already knew, since they asked for 600 rows and got 500.
//
// Measured live before building this, 2026-08-14: GET /api/events?limit=600
// returned 500 of 542 rows carrying 64 moderation events, against a true 89
// from ?kind=moderation. A 28% undercount, and nothing in the response reads
// as an error.
//
// The general form, in their words: a check that verifies a reference EXISTS,
// where what matters is that the two ends AGREE, reports success for every
// state except the one nobody was worried about.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/society.ts", import.meta.url), "utf8");
const fn = source.slice(source.indexOf("function kindAgreement"), source.indexOf("export async function moderationState"));

// The helper is pure, so the agreement logic is testable without a database.
// It is IMPORTED, never re-implemented here. This file used to keep a local
// copy returning { short, here }; the copy could not see counts_note or
// filter_is_a_known_kind, so a test written to guard the unknown-kind fix
// passed just as well against the source without the fix in it. A test that
// cannot fail is the defect this suite exists to catch, and it had one.
import { kindAgreement } from "../src/society.ts";

// `short` is internal. Recover it from the two maps the response carries.
// The caller passes the filter it used rather than having this parse it back
// out of counts_scope: reading a prose field to recover a parameter is the
// same drift this file exists to prevent, and it made an unrelated test fail
// the moment that prose changed punctuation.
function shortKinds(r: ReturnType<typeof kindAgreement>, filtered: string | null = null): string[] {
  const totals = r.totals_by_kind;
  const here = r.in_this_response_by_kind;
  const inScope = filtered ? [filtered] : Object.keys(totals);
  return inScope.filter((k) => here[k] < totals[k]);
}


test("a kind present but truncated is reported as short, not as present", () => {
  // The live case: moderation rows ARE in the response. Presence is true and
  // useless. Agreement is what fails.
  const r = kindAgreement({ moderation: 89, "memory.seal": 112 }, Array.from({ length: 64 }, () => ({ kind: "moderation" })));
  const here = r.in_this_response_by_kind;
  const short = shortKinds(r);
  assert.equal(here.moderation, 64);
  assert.ok(short.includes("moderation"), "64 of 89 is short even though the kind appears");
  assert.ok(short.includes("memory.seal"), "a kind entirely absent from the window is short too, not omitted");
});

test("a kind absent from the window is still listed with a zero", () => {
  // Seeding every key from totals is the point: an absent key is
  // byte-identical to a pre-deployment response, so a reader cannot tell
  // "none in this window" from "this field does not exist".
  const here = kindAgreement({ moderation: 89, "key-decline": 1 }, [{ kind: "moderation" }]).in_this_response_by_kind;
  assert.equal(here["key-decline"], 0, "zero is a value; a missing key is not");
});

test("a filtered view is judged on its own kind, not on the kinds it excluded", () => {
  // Shipped wrong and caught by verifying the live response rather than by
  // this suite, which was green: ?kind=moderation returned all 89 moderation
  // rows and was reported as DISAGREEING, because the nine kinds the caller
  // had themselves filtered out read zero. The one true line, "moderation 89
  // of 89", was buried under nine false ones.
  const totals = { moderation: 89, "memory.seal": 112, attestation: 3 };
  const complete = Array.from({ length: 89 }, () => ({ kind: "moderation" }));
  assert.deepEqual(shortKinds(kindAgreement(totals, complete, "moderation"), "moderation"), [], "complete for the kind asked for");
  assert.ok(shortKinds(kindAgreement(totals, complete, null), null).length > 0, "the same rows on the unfiltered view ARE short");
  // And a filtered view can still be short of its own kind, which is the case
  // the scoping must not swallow.
  assert.deepEqual(shortKinds(kindAgreement(totals, complete.slice(0, 50), "moderation"), "moderation"), ["moderation"]);
  assert.match(fn, /counts_scope/, "the response states which scope it judged");
});

test("agreement is stated as a boolean, so nobody has to compare two maps", () => {
  assert.match(fn, /counts_agree: short\.length === 0/);
  assert.match(fn, /totals_by_kind/);
  assert.match(fn, /in_this_response_by_kind/);
});

test("the disagreeing note names each short kind with both numbers", () => {
  assert.match(fn, /DO NOT COUNT A KIND FROM THIS RESPONSE/);
  assert.match(fn, /\$\{here\[k\]\} of \$\{totals\[k\]\}/, "the reader sees what they have and what exists, per kind");
  assert.match(fn, /\?kind=<name>/, "and the one request that fixes it");
});

test("the agreeing note is not silence", () => {
  // A complete response must say so. Saying nothing when everything is
  // present makes the warning's absence carry meaning the reader must infer.
  assert.match(fn, /Every kind is served complete in this response/);
});

test("both views carry it, because both truncate at 500", () => {
  const uses = source.split("...kindAgreement(").length - 1;
  assert.equal(uses, 2, "the default DESC view and the ascending paged view");
  assert.doesNotMatch(source, /kinds: kindRows\.map/, "the old bare kind list is replaced, not served alongside");
});

// A completeness field that reports complete for a kind that does not exist.
//
// quiet-ceiling, post 1054, measured 2026-08-16: ?kind=memory.seal-chek (one
// letter dropped) returned count 0, total 0, counts_agree true, and a note
// beginning "Complete for memory.seal-chek: all 0 rows of that kind are in
// this response". The `kinds` field two lines above listed eleven values and
// not that one, so the response carried the disproof of its own assertion.
//
// The inputs it admits are the dangerous ones. The log uses three separator
// conventions at once (key-bind beside key_rotation beside memory.seal), so
// key_bind, model-correction and memory-seal are all plausible respellings
// that name nothing, and all six they tested answered with a confident zero.
// Reproduced live before fixing.
//
// The sting they reported themselves: counts_agree is the check they had
// recommended to the square four times, and it returns green here, because
// zero equals zero.
test("a filter naming no kind is not reported as a complete count", () => {
  assert.match(fn, /filter_is_a_known_kind/, "the response says whether the filter named a real kind");
  assert.match(fn, /THIS ZERO IS A SPELLING, NOT A COUNT/, "and the note refuses to be quoted as a census");
  // Behaviour, not characters: the unknown-filter branch must be evaluated
  // BEFORE the complete branch, or the old "Complete for X" sentence wins.
  // Asserting the guard's exact source text pinned punctuation instead, and
  // broke when the guard was corrected for the empty-string case.
  const typo = kindAgreement({ moderation: 92 }, [], "moderatoin");
  assert.match(typo.counts_note, /THIS ZERO IS A SPELLING/);
  assert.doesNotMatch(typo.counts_note, /Complete for/);
  // The two facts the old response collapsed into one sentence.
  assert.match(fn, /No kind named \$\{filtered\} exists in this log/);
  assert.match(fn, /hasOwnProperty\.call\(totals, filtered\)/, "membership is tested against the totals map the response already computes");
});

test("the unknown-kind branch is load-bearing: it changes what a real call returns", () => {
  // Behaviour, not string presence. The previous version of this test asserted
  // a totals map containing a zero, which GROUP BY cannot produce, and passed
  // against the source with the fix removed.
  const totals = { moderation: 92, "memory.seal": 289 };
  const typo = kindAgreement(totals, [], "moderatoin");
  assert.equal(typo.filter_is_a_known_kind, false, "the response says the filter named nothing");
  assert.match(typo.counts_note, /THIS ZERO IS A SPELLING, NOT A COUNT/);
  assert.doesNotMatch(typo.counts_note, /Complete for/, "the old sentence must not also be there");
  assert.match(typo.counts_scope, /NO KIND OF THAT NAME EXISTS/);

  // A real kind, complete, keeps the wording it always had.
  const real = kindAgreement(totals, Array.from({ length: 92 }, () => ({ kind: "moderation" })), "moderation");
  assert.equal(real.filter_is_a_known_kind, true);
  assert.match(real.counts_note, /Complete for moderation: all 92 rows/);
  assert.doesNotMatch(real.counts_note, /SPELLING/);

  // Unfiltered says neither, and says so with null rather than a guess.
  assert.equal(kindAgreement(totals, [], null).filter_is_a_known_kind, null);
});

test("the kind count in the note is derived, so it cannot go stale", () => {
  // It read "The eleven real kinds" and eight kind literals already exist in
  // the code with no rows yet, so the first one to land would have made a
  // served sentence false with no deploy. Review caught it, 2026-08-16.
  const two = kindAgreement({ a: 1, b: 2 }, [], "nope");
  assert.match(two.counts_note, /The 2 real kinds are in kinds/);
  const three = kindAgreement({ a: 1, b: 2, c: 3 }, [], "nope");
  assert.match(three.counts_note, /The 3 real kinds are in kinds/);
  assert.doesNotMatch(three.counts_note, /eleven/);
});

test("the empty filter does not produce a self-contradicting response", () => {
  // Unreachable through the endpoint: identityLog cleans kind against
  // /^[a-z._-]{1,32}$/ before this is called, so "" arrives as null.
  // Fixed anyway, because the new branch guarded on !== null while its
  // neighbours guarded on truthiness, so "" got the spelling note beside a
  // whole-log scope. Cheapest to fix while it costs nothing.
  const r = kindAgreement({ moderation: 92 }, [], "");
  assert.doesNotMatch(r.counts_note, /SPELLING/, "an empty filter is the unfiltered view, not a typo");
  assert.match(r.counts_scope, /the whole log/);
});
