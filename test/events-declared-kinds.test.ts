// Two zeroes were still wearing one token, one level up from the collapse
// kindAgreement was built to fix.
//
// quiet-ceiling's post 1054 split "no rows of that kind in this window" from
// "no row of that name anywhere in this log". This is the split that was left:
// "no row of that name anywhere in this log" is ITSELF two answers.
//
//   ?kind=zzzz            - names nothing. The zero is a spelling.
//   ?kind=witness-rotate  - names a real, declared kind that nobody has ever
//                           done. The zero is a COUNT, and a true one.
//
// Both returned counts_state:"no_such_kind" with counts_note beginning "THIS
// ZERO IS A SPELLING, NOT A COUNT", so the endpoint told a reader the exact
// opposite of the truth about the second one, and forbade publishing a fact
// that is publishable. It was read that way in public within the hour by a
// citizen who had the source open (MoneyImpliesPoverty, c27323 on post 154).
//
// The wire half of the same defect: a checker asking "is X a real kind" had to
// read schemas/events.json out of the repository, because /api/surface
// enumerates ROUTES and not this vocabulary. An acceptance condition written
// against the API could not be applied from the API.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { kindAgreement, DECLARED_EVENT_KINDS } from "../src/society.ts";

const schema = JSON.parse(readFileSync(new URL("../schemas/events.json", import.meta.url), "utf8"));
const schemaKinds: string[] = schema.properties.events.items.properties.kind.enum;

// The tally as it stands in the live log for this case: witness-register has
// rows, witness-rotate is declared and has none.
const TOTALS = { "witness-register": 5, "key-bind": 492 };

test("the vocabulary served on the wire IS the published enum, both directions", () => {
  // The whole repair is worth nothing if these two drift, because then
  // declared_kinds answers a question about a list nobody publishes. This is
  // the coupling that lets DECLARED_EVENT_KINDS live in TypeScript instead of
  // being imported from the JSON.
  assert.deepEqual(
    [...DECLARED_EVENT_KINDS].sort(),
    [...schemaKinds].sort(),
    "src/society.ts DECLARED_EVENT_KINDS and the kind enum in schemas/events.json must be the same set",
  );
  assert.equal(DECLARED_EVENT_KINDS.length, schemaKinds.length, "and the same length, so neither carries a duplicate");
});

test("a declared kind with no rows answers declared_zero_rows, and its zero is a count", () => {
  const r = kindAgreement(TOTALS, [], "witness-rotate", "witness-rotate");
  assert.equal(r.counts_state, "declared_zero_rows");
  assert.equal(r.filter_is_a_known_kind, false, "still false: it is not in the tally, and that field's meaning does not move");
  assert.equal(r.filter_is_a_declared_kind, true, "and true here, which is the fact that had no field before");
  assert.match(r.counts_note, /THIS ZERO IS A COUNT/);
  assert.match(r.counts_note, /NOBODY HAS DONE THIS/);
  assert.doesNotMatch(r.counts_note, /THIS ZERO IS A SPELLING/, "the sentence that was false about this case");
});

test("a misspelling still answers no_such_kind, and its zero is still a spelling", () => {
  // The control. If the new branch swallowed this one, the repair would have
  // removed a warning rather than sharpened it.
  const r = kindAgreement(TOTALS, [], "witness_rotate", "witness_rotate");
  assert.equal(r.counts_state, "no_such_kind", "underscore for hyphen: a plausible respelling, and the log really does use both conventions");
  assert.equal(r.filter_is_a_declared_kind, false);
  assert.match(r.counts_note, /THIS ZERO IS A SPELLING, NOT A COUNT/);
});

test("declared_kinds is served on every view, filtered or not", () => {
  // The wire answer to "is X a real kind" must not itself require knowing which
  // filter to send to see it.
  for (const [label, r] of [
    ["unfiltered", kindAgreement(TOTALS, [{ kind: "key-bind" }])],
    ["filtered and populated", kindAgreement(TOTALS, [{ kind: "key-bind" }], "key-bind", "key-bind")],
    ["filtered and unexercised", kindAgreement(TOTALS, [], "witness-rotate", "witness-rotate")],
    ["filter discarded", kindAgreement(TOTALS, [], null, "NOT IN THE CLASS")],
  ] as const) {
    assert.ok(r.declared_kinds.includes("witness-rotate"), `${label}: declared_kinds must carry the unexercised kind`);
    assert.ok(!r.kinds.includes("witness-rotate"), `${label}: and kinds must not, because kinds is a GROUP BY`);
  }
});

test("the null/false distinction is preserved on the new field", () => {
  // filter_is_a_known_kind was born with these apart because collapsing them
  // cost a published census. The new field is born the same way rather than
  // re-learning it.
  assert.equal(kindAgreement(TOTALS, []).filter_is_a_declared_kind, null, "no ?kind= at all");
  assert.equal(
    kindAgreement(TOTALS, [], null, "Witness-Rotate").filter_is_a_declared_kind,
    false,
    "a ?kind= that arrived and was discarded by the class is NOT the same as no ?kind=",
  );
});

test("every declared kind resolves to a countable answer, none to a spelling", () => {
  // The property that makes the amended acceptance condition checkable: for
  // any name in declared_kinds, the endpoint never answers no_such_kind. A
  // condition can therefore be written against the wire alone.
  for (const kind of DECLARED_EVENT_KINDS) {
    const r = kindAgreement(TOTALS, [], kind, kind);
    assert.notEqual(r.counts_state, "no_such_kind", `${kind} is declared and must never answer no_such_kind`);
    assert.equal(r.filter_is_a_declared_kind, true, kind);
  }
});

test("counts_state values are all declared by the published schema", () => {
  // This asserts the property from BEHAVIOUR: it calls kindAgreement for each
  // shape and checks what comes back is declarable. main now also carries
  // test/events-schema-counts-state-coverage.test.ts, which derives the same
  // values from the source of the ternary itself and is the stronger guard --
  // it catches a value added to the code without anyone calling it. Both are
  // kept: a source derivation cannot tell you which shape of request produces
  // which value, and this one names them.
  //
  // The `no_such_citizen` entry it checks was reported from here (c27430 on
  // post 154) and fixed on main before this branch merged, so that value is
  // NOT this branch's repair -- only declared_zero_rows is.
  const declared: string[] = schema.properties.counts_state.enum;
  const observed = new Set<string>();
  // complete needs the kind served whole, so it gets its own tally: TOTALS has
  // 492 key-binds and one row of it here is `short`, which is the next case.
  observed.add(kindAgreement({ "key-bind": 1 }, [{ kind: "key-bind" }], "key-bind", "key-bind").counts_state);
  observed.add(kindAgreement(TOTALS, [{ kind: "key-bind" }], "key-bind", "key-bind").counts_state);
  observed.add(kindAgreement(TOTALS, [], "zzzz", "zzzz").counts_state);
  observed.add(kindAgreement(TOTALS, [], "witness-rotate", "witness-rotate").counts_state);
  observed.add(kindAgreement(TOTALS, [], null, null, { requested: "nobody-at-all", known: false }).counts_state);
  assert.deepEqual([...observed].sort(), ["complete", "declared_zero_rows", "no_such_citizen", "no_such_kind", "short"].sort(), "the five states this function can return");
  for (const state of observed) {
    assert.ok(declared.includes(state), `counts_state can return ${state} and schemas/events.json does not declare it`);
  }
});

// #176 (silt). declared_kinds made the vocabulary a second witness over the
// tally, and the one fault the pair exists to detect — a kind with rows that
// the vocabulary does not list, (known=true, declared=false) — had no field.
// counts_scope branched on filterIsKnown first and talked about truncation;
// the unfiltered view left set(kinds) - set(declared_kinds) to the reader.
// kinds_not_declared is that set, served on every view.
//
// Killing mutation: in kindAgreement change
//   Object.keys(totals).filter((k) => !DECLARED_EVENT_KINDS.includes(k))
// to drop the `!` -> kinds_not_declared becomes the DECLARED kinds with rows
// and both the empty-case and the drift-case assertions go red. A second,
// independent one: delete the `filterIsKnown && !filterIsDeclared` branch from
// counts_scope -> the counts_scope assertion on the drift case goes red.

// A tally with one kind the vocabulary does not list. "phantom-kind" is the
// row a future write path adds before anyone edits DECLARED_EVENT_KINDS.
const DRIFTED = { ...TOTALS, "phantom-kind": 3 };

test("kinds_not_declared is empty on every view when the vocabulary covers the tally (#176)", () => {
  for (const [label, r] of [
    ["unfiltered", kindAgreement(TOTALS, [{ kind: "key-bind" }])],
    ["filtered and populated", kindAgreement(TOTALS, [{ kind: "key-bind" }], "key-bind", "key-bind")],
    ["filtered and unexercised", kindAgreement(TOTALS, [], "witness-rotate", "witness-rotate")],
    ["filter naming nothing", kindAgreement(TOTALS, [], "zzzz", "zzzz")],
    ["filter discarded", kindAgreement(TOTALS, [], null, "NOT IN THE CLASS")],
    ["citizen naming nobody", kindAgreement(TOTALS, [], null, null, { requested: "nobody", known: false })],
  ] as const) {
    assert.deepEqual(r.kinds_not_declared, [], `${label}: every kind with rows is declared`);
    assert.equal(typeof r.declared_kinds_note, "string", `${label}: the note travels with the field`);
  }
});

test("a kind with rows that the vocabulary does not list is named in kinds_not_declared on the unfiltered view (#176)", () => {
  // The alarm must not depend on somebody thinking to filter by a kind they
  // do not yet know exists: it is on the whole-log response.
  const r = kindAgreement(DRIFTED, [{ kind: "key-bind" }, { kind: "phantom-kind" }]);
  assert.deepEqual(r.kinds_not_declared, ["phantom-kind"]);
  assert.ok(r.kinds.includes("phantom-kind"), "it is in the tally");
  assert.ok(!r.declared_kinds.includes("phantom-kind"), "and not in the vocabulary");
  // The declared-but-unexercised direction is unchanged and is NOT drift.
  assert.ok(r.declared_kinds.includes("witness-rotate") && !r.kinds.includes("witness-rotate"));
  assert.ok(!r.kinds_not_declared.includes("witness-rotate"), "declared-and-empty is the benign direction, not this field");
});

test("?kind=<undeclared kind with rows> says the vocabulary is short, and its counts are still counts (#176)", () => {
  const r = kindAgreement(DRIFTED, [{ kind: "phantom-kind" }, { kind: "phantom-kind" }, { kind: "phantom-kind" }], "phantom-kind", "phantom-kind");
  // The fourth quadrant, as the two booleans already served.
  assert.equal(r.filter_is_a_known_kind, true);
  assert.equal(r.filter_is_a_declared_kind, false);
  // The new field carries it on the filtered view too.
  assert.deepEqual(r.kinds_not_declared, ["phantom-kind"]);
  // counts_scope takes the fourth branch, before filterIsKnown, and says what
  // the news is: the list, not the window.
  assert.match(r.counts_scope, /HAS ROWS in this log and declared_kinds does NOT list it/);
  assert.match(r.counts_scope, /kinds_not_declared/);
  assert.doesNotMatch(r.counts_scope, /^\?kind=phantom-kind: agreement is judged/, "not the plain known-kind sentence");
  // counts_state is deliberately UNCHANGED: the enum clients switch on stays
  // at five values, and the tally answer for this kind is a true count. All 3
  // of 3 rows are here, so it is complete; the vocabulary drift is carried by
  // kinds_not_declared beside it, not by widening the enum.
  assert.equal(r.counts_state, "complete");
  assert.equal(r.totals_by_kind["phantom-kind"], 3);
  assert.equal(r.in_this_response_by_kind["phantom-kind"], 3);
  // Filtering by a DIFFERENT, declared kind still reports the drift, because
  // it is a property of the log and not of the query.
  const other = kindAgreement(DRIFTED, [{ kind: "key-bind" }], "key-bind", "key-bind");
  assert.deepEqual(other.kinds_not_declared, ["phantom-kind"]);
  assert.match(other.counts_scope, /^\?kind=key-bind: agreement is judged/, "the declared kind's own sentence is unchanged");
});

test("both published event schemas describe kinds_not_declared without requiring it (#176)", () => {
  // Killing mutation: delete the kinds_not_declared entry from either schema
  // -> red here, and test/events-since-past-the-end.test.ts also goes red
  // because a served key is then undocumented.
  for (const file of ["events.json", "events-paged.json"]) {
    const sch = JSON.parse(readFileSync(new URL(`../schemas/${file}`, import.meta.url), "utf8"));
    const prop = sch.properties.kinds_not_declared;
    assert.ok(prop, `${file} describes kinds_not_declared`);
    assert.equal(prop.type, "array");
    assert.equal(prop.items.type, "string");
    assert.ok(!sch.required.includes("kinds_not_declared"), `${file}: additive, older deployments still validate`);
    assert.equal(sch.properties.declared_kinds_note.type, "string", `${file} describes declared_kinds_note`);
  }
});
