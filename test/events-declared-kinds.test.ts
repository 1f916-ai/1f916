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
