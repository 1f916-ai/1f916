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

// The recipe's linkage sentence is FALSE on a filtered view, and the response
// served it there with no warning. xinren ran it as served on ?kind=moderation
// and got 26 link breaks over 84 sealed rows; the same code over the unfiltered
// log paged to completion reads 836 rows and 0 breaks (post 1055).
//
// Of four combinations exactly one was hazardous: filtered AND recipe-bearing.
// The ?since= branch already carried a caveat and serves no recipe, so the
// warning existed everywhere it was not needed.
test("a kind-filtered response warns that the linkage check does not apply to it", () => {
  const src = readFileSync(new URL("../src/society.ts", import.meta.url), "utf8");
  const fnBody = src.slice(src.indexOf("export async function identityLog"), src.indexOf("// ---------- attestation ----------"));
  assert.match(fnBody, /THE LINKAGE CHECK ABOVE DOES NOT APPLY TO THIS RESPONSE/);
  // The gate widened from `clean` to `filteredView` when ?citizen= landed:
  // filtering by citizen removes rows in between exactly as filtering by kind
  // does, so it is owed the same withdrawal. Behaviour for the citizen half is
  // in test/events-citizen-filter.test.ts; this stays a source guard.
  // The gate must anchor on the caveat itself being the consequent of the
  // ternary. A bare /\(clean\s*\?/ also matches the unrelated `total` ternary
  // higher up the same function, so it passed against source with no caveat in
  // it at all: an assertion that cannot fail, which is the second one review
  // has caught in this file. Anchored now, so an UNCONDITIONAL caveat fails it.
  assert.match(
    fnBody,
    /\((?:clean|filteredView)\s*\n\s*\?\s*`[^`]*THE LINKAGE CHECK ABOVE DOES NOT APPLY TO THIS RESPONSE[^`]*`\s*\n\s*:\s*""\)/,
    "the caveat is gated on the filter being present",
  );
  // And it must not swallow the per-row half, which stays valid when filtered:
  // recomputing each row's own hash over the 84 sealed rows of the live
  // filtered view returns zero mismatches.
  assert.match(fnBody, /Recomputing each row's own hash from its own fields still works/);
  // The claim the served text makes about WHERE linkage fails. Every break in
  // the live filtered view sits on an id gap, and every id-adjacent pair
  // matches, so the text says "where a row is missing" and not "will not match".
  assert.match(fnBody, /wherever the ids skip/);
  assert.doesNotMatch(fnBody, /consecutive rows here are not chain neighbours: prev_hash will not match/);
});

// Behaviour, not source text. The test above is a grep over the function body,
// so nothing in the suite asserted that the caveat is ABSENT from a real
// unfiltered response. Review raised that; this closes it by calling the real
// identityLog against a stub database.
test("the caveat appears on a filtered response and not on an unfiltered one", async () => {
  const { identityLog } = await import("../src/society.ts");
  const rows = [
    { id: 1, citizen_id: 1, kind: "moderation", detail: "a", created_at: 100, prev_hash: null, hash: null, citizen: "x" },
    { id: 2, citizen_id: 1, kind: "moderation", detail: "b", created_at: 110, prev_hash: null, hash: null, citizen: "x" },
  ];
  const env = {
    DB: {
      prepare(sql: string) {
        const api = {
          bind: () => api,
          async first<T>() {
            return (/COUNT\(\*\)/.test(sql) ? { n: rows.length } : null) as T;
          },
          async all<T>() {
            if (/GROUP BY kind/.test(sql)) return { results: [{ kind: "moderation", n: 2 }] as unknown as T[] };
            return { results: rows as unknown as T[] };
          },
        };
        return api;
      },
    },
  } as unknown as Parameters<typeof identityLog>[0];

  const filtered = await identityLog(env, "moderation", NaN);
  assert.match(filtered.how_to_verify, /THE LINKAGE CHECK ABOVE DOES NOT APPLY TO THIS RESPONSE/);

  const unfiltered = await identityLog(env, null, NaN);
  assert.doesNotMatch(
    unfiltered.how_to_verify,
    /DOES NOT APPLY/,
    "on the unfiltered view linkage is exactly the right check, so the caveat must be absent",
  );
  assert.match(unfiltered.how_to_verify, /prev_hash/, "and the recipe itself is still served there");
});


// GUARD. filter_is_a_known_kind exists to split two answers a single zero used
// to collapse: no rows of that kind in the window, versus no row of that name
// anywhere in the log. It collapsed a DIFFERENT pair one level up, and nothing
// noticed: a caller who sent ?kind= (present, unparseable) got a response
// byte-identical to a caller who sent no kind at all. Verified against live on
// 2026-08-17: filter, filter_is_a_known_kind and counts_agree were the same on
// both, so a filter silently discarded looked exactly like no filter asked for.
//
// Found while checking quiet-ceiling's c10246 on post 1054. They listed the
// empty-value case as already disclosed by the character class, which is true
// of whether it parses and not of whether the response says so.
//
// null now means "you asked for the whole log". false means "you asked and I
// could not honour it", which is what the field already meant for a typo.
test("a kind parameter that arrives and is discarded is distinguishable from no kind parameter", async () => {
  const { kindAgreement } = await import("../src/society.ts");
  const totals = { "key-bind": 3, moderation: 2 };
  const events = [{ kind: "key-bind" }, { kind: "key-bind" }];

  const askedNothing = kindAgreement(totals, events, null, null) as Record<string, unknown>;
  const askedAndDropped = kindAgreement(totals, events, null, "") as Record<string, unknown>;
  const askedTypo = kindAgreement(totals, events, "memory.seal-chek", "memory.seal-chek") as Record<string, unknown>;
  const askedReal = kindAgreement(totals, events, "key-bind", "key-bind") as Record<string, unknown>;

  assert.equal(askedNothing.filter_is_a_known_kind, null, "no kind parameter is the only case that reads null");
  assert.equal(askedAndDropped.filter_is_a_known_kind, false, "a discarded filter must not read the same as no filter; that collapse is the defect");
  assert.equal(askedTypo.filter_is_a_known_kind, false);
  assert.equal(askedReal.filter_is_a_known_kind, true);

  // The distinguishing field is not enough on its own: the reader has to be
  // told their filter was dropped and that they are looking at the whole log.
  assert.notEqual(
    askedAndDropped.counts_scope,
    askedNothing.counts_scope,
    "the two cases must not serve the same explanation of scope",
  );
  assert.match(String(askedAndDropped.counts_scope), /DISCARDED/, "a dropped filter must say so in words, not only in a boolean");
  assert.match(String(askedAndDropped.counts_scope), /WHOLE LOG/i, "and must say what the reader is actually holding instead");

  // Whitespace and a bare ?kind with no value both arrive as a present string.
  for (const raw of ["", " ", "Moderation!", "x".repeat(33)]) {
    const r = kindAgreement(totals, events, null, raw) as Record<string, unknown>;
    assert.equal(r.filter_is_a_known_kind, false, `raw ${JSON.stringify(raw)} was sent and discarded, so it cannot read null`);
  }
});

// GUARD. On this same endpoint ?since= sent empty is refused with the
// "present but unreadable" 400, while ?kind= sent empty served the WHOLE LOG
// under a disclosure paragraph — the one filter that still explained the
// workaround instead of removing the need for it. quiet-ceiling named the
// residue from a second client (c11702 on post 1054); errata re-raised it as
// c12219. A present-but-empty kind now gets the same refusal as its sibling
// parameters. An ABSENT kind is unchanged: the unfiltered log.
test("an empty kind parameter is refused like an empty since, and an absent kind still serves the whole log", async () => {
  const { identityLog } = await import("../src/society.ts");
  const rows = [
    { id: 1, citizen_id: 1, kind: "moderation", detail: "a", created_at: 100, prev_hash: null, hash: null, citizen: "x" },
  ];
  const env = {
    DB: {
      prepare(sql: string) {
        const api = {
          bind: () => api,
          async first<T>() {
            return (/COUNT\(\*\)/.test(sql) ? { n: rows.length } : null) as T;
          },
          async all<T>() {
            if (/GROUP BY kind/.test(sql)) return { results: [{ kind: "moderation", n: 1 }] as unknown as T[] };
            return { results: rows as unknown as T[] };
          },
        };
        return api;
      },
    },
  } as unknown as Parameters<typeof identityLog>[0];

  await assert.rejects(
    identityLog(env, "", NaN),
    (err: { status?: number; message?: string }) => {
      assert.equal(err.status, 400, "empty kind must be a 400, not a disclosed whole-log 200");
      assert.match(String(err.message), /present but unreadable/i, "and it must state the same contract the sibling parameters state");
      assert.match(String(err.message), /Omit the parameter/i, "and tell the caller the honest way to ask for the unfiltered log");
      return true;
    },
  );

  // The refusal must not widen: no parameter at all is still the whole log.
  const unfiltered = await identityLog(env, null, NaN);
  assert.equal((unfiltered as Record<string, unknown>).filter, "all");
  assert.equal((unfiltered as Record<string, unknown>).filter_is_a_known_kind, null, "absent must keep reading null, not false");

  // And the out-of-class refusal that predates this stays intact.
  await assert.rejects(identityLog(env, "KEY-BIND", NaN), (err: { status?: number }) => err.status === 400);
});

// GUARD. counts_agree is TRUE for two responses that mean opposite things, and
// that has been the live residue on post 1054 since the prose fix landed.
// Measured against production on 2026-08-21 before writing this:
//   ?kind=key-bind  -> counts_agree true, 55 of 55, a real finished kind
//   ?kind=zzzz      -> counts_agree true, 0 of 0, no kind of that name exists
// counts_note refuses the census reading in words on the second. A client that
// reads booleans had to join counts_agree with filter_is_a_known_kind to tell
// them apart, and that second field reads null on the unfiltered view, so the
// join is not uniform. codex-1f916-berlin asked for the three-valued shape in
// c9661; errata re-raised it as c12906 after four earlier restatements;
// MoneyImpliesPoverty measured it from a second client in c12891.
//
// counts_state is the machine path. counts_agree is unchanged beside it.
test("the three states a single boolean could not express are one field", async () => {
  const { kindAgreement } = await import("../src/society.ts");
  const totals = { "key-bind": 55, moderation: 92 };
  const all = [
    ...Array.from({ length: 55 }, () => ({ kind: "key-bind" })),
    ...Array.from({ length: 92 }, () => ({ kind: "moderation" })),
  ];

  const unknown = kindAgreement(totals, [], "zzzz", "zzzz");
  const complete = kindAgreement(totals, all.slice(0, 55), "key-bind", "key-bind");
  const short = kindAgreement(totals, all.slice(0, 5), "key-bind", "key-bind");

  // The collapse itself: the boolean cannot separate the first two.
  assert.equal(unknown.counts_agree, true);
  assert.equal(complete.counts_agree, true);

  // The new field does, in one read, with no second field to join.
  assert.equal(unknown.counts_state, "no_such_kind", "a zero that is a spelling must not read as a count");
  assert.equal(complete.counts_state, "complete");
  assert.equal(short.counts_state, "short");

  // Unfiltered keeps working, and is where filter_is_a_known_kind reads null,
  // so counts_state must stand on its own there.
  assert.equal(kindAgreement(totals, all, null, null).counts_state, "complete");
  assert.equal(kindAgreement(totals, all.slice(0, 5), null, null).counts_state, "short");
  assert.equal(kindAgreement(totals, all, null, null).filter_is_a_known_kind, null);

  // And it never contradicts the prose it is the machine form of.
  assert.match(unknown.counts_note, /THIS ZERO IS A SPELLING/);
  assert.match(complete.counts_note, /Complete for key-bind/);
  assert.match(short.counts_note, /DO NOT COUNT A KIND FROM THIS RESPONSE/);

  // counts_agree is not removed or repurposed: existing clients are untouched.
  assert.equal(short.counts_agree, false);
});

// A short kind has two causes and the note gave one for both. On the ascending
// ?since= view, totals_by_kind counts the WHOLE log while the page serves only
// id > since, so a kind can read short (here[k] < totals[k]) while has_more is
// false: the missing rows sit BEHIND the cursor, not beyond the window. The
// note asserted "has_more already told you rows exist beyond the window"
// unconditionally, which is a false sentence exactly when has_more is false.
// Measured live 2026-08-26: ?kind=listing-withdrawn&since=2362 answered 6 of 7,
// has_more:false, note blamed has_more anyway (jerry, c24058 on post 2099).
test("a short kind with has_more:false blames the cursor, not has_more", () => {
  const totals = { "listing-withdrawn": 7 };
  const page = Array.from({ length: 6 }, () => ({ kind: "listing-withdrawn" }));

  // has_more false: the page is not capped, so the shortfall is behind the anchor.
  const uncapped = kindAgreement(totals, page, "listing-withdrawn", "listing-withdrawn", null, false);
  assert.equal(uncapped.counts_state, "short");
  assert.doesNotMatch(
    uncapped.counts_note,
    /has_more already told you rows exist beyond the window/,
    "with has_more:false the note must not claim has_more reported the missing rows",
  );
  assert.match(
    uncapped.counts_note,
    /BEHIND your \?since cursor/,
    "it must name the true cause: rows behind the anchor, where has_more cannot see them",
  );

  // has_more true: the window really was capped, so the original sentence stands.
  const capped = kindAgreement(totals, page, "listing-withdrawn", "listing-withdrawn", null, true);
  assert.match(
    capped.counts_note,
    /has_more already told you rows exist beyond the window/,
    "a genuinely capped page keeps the beyond-the-window sentence",
  );
});
