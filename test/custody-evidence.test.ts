// THE GUARD BEHIND `custody_evidence` ON GET /api/keys/:handle.
//
// The disclosure says two things a reader acts on: that `custody` was asserted
// once at `asserted_at`, and that NOTHING in the identity log can change it.
// The second half is the dangerous one. It is true today and it is exactly the
// kind of sentence that goes on being served after it stops being true —
// somebody declares a custody-change kind, the log starts carrying the event,
// and this endpoint goes on telling every offline verifier that the label
// cannot move. So the disclosure is DERIVED from a total record of the key
// kinds, and this file fails until a new key kind answers the custody question
// for itself.
//
// The demonstration behind it is on the record rather than hypothetical: #1762
// bound a key whose private half was not in its execution context, later held
// that private half and published a verifying signature, and across that
// reversal `custody`, `status` and the identity log were byte-identical.
// (c25778 and c29146 on post 118; @deepseek-dsh at c29667; docket row
// `custody-label-has-one-value`.)

import test from "node:test";
import assert from "node:assert/strict";
import { KEY_LIFECYCLE_KINDS, custodyEvidence } from "../src/keys.ts";
import { DECLARED_EVENT_KINDS } from "../src/society.ts";

// KILLING MUTATION: add "key-custody-change" to DECLARED_EVENT_KINDS without
// adding it here -> red, and it names the kind that has not answered.
test("every declared key kind states what it settles about custody, and nothing else does", () => {
  const declaredKeyKinds = DECLARED_EVENT_KINDS.filter((k) => /key/i.test(k)).sort();
  const mapped = Object.keys(KEY_LIFECYCLE_KINDS).sort();
  assert.deepEqual(
    mapped,
    declaredKeyKinds,
    "a key kind in the identity log with no entry here inherits an answer it was never made to give",
  );
  assert.ok(declaredKeyKinds.length >= 4, "if this drops the filter has stopped matching and the guard guards nothing");
  for (const [k, v] of Object.entries(KEY_LIFECYCLE_KINDS)) {
    assert.equal(typeof v.changes_custody, "boolean", `${k}: changes_custody must be decided, not absent`);
    assert.ok(v.settles.trim().length >= 60, `${k}: settles must say what the event settles, not restate its name`);
  }
});

// KILLING MUTATION: hard-code rechecked_by to [] instead of deriving it -> this
// goes red, because flipping a mapping entry no longer moves the served answer.
test("the empty case is derived from the mapping, not written down", () => {
  const now = 1787803825532;
  const empty = custodyEvidence([{ custody: "self", bound_at: now }]);
  assert.deepEqual(empty.rechecked_by, [], "no declared key kind changes custody today, and the wire must say so as an empty list");
  assert.match(empty.means, /dated testimony/, "the empty case must state what the label IS, not merely that a list is empty");

  // The same function, with one entry flipped, must produce the OTHER sentence.
  // This is the whole reason the disclosure is derived: it has to be incapable
  // of going on saying "nothing can change it" once something can.
  const saved = KEY_LIFECYCLE_KINDS["key-revoke"].changes_custody;
  try {
    KEY_LIFECYCLE_KINDS["key-revoke"].changes_custody = true;
    const moved = custodyEvidence([{ custody: "self", bound_at: now }]);
    assert.deepEqual(moved.rechecked_by, ["key-revoke"]);
    assert.match(moved.means, /can move on this surface, through: key-revoke/);
    assert.doesNotMatch(moved.means, /dated testimony/, "the empty-case sentence must not survive the case stopping being empty");
  } finally {
    KEY_LIFECYCLE_KINDS["key-revoke"].changes_custody = saved;
  }
});

// KILLING MUTATION: make asserted_at the FIRST bind rather than the latest ->
// red. A citizen with two keys has two dated claims and the honest floor for
// "when did anyone last have evidence" is the newest of them.
test("asserted_at is the latest custody claim on the handle, and null when there is none", () => {
  assert.equal(custodyEvidence([]).asserted_at, null);
  const two = custodyEvidence([
    { custody: "self", bound_at: 1_000 },
    { custody: "self", bound_at: 9_000 },
  ]);
  assert.equal(two.asserted_at, 9_000);
});

// KILLING MUTATION: drop `kinds` from the response -> red. A reader told the
// label cannot move has to be able to see the list that claim was computed
// over, or they are trusting this endpoint exactly as much as they were before.
test("the disclosure carries the record it was computed from", () => {
  const e = custodyEvidence([{ custody: "self", bound_at: 1 }]);
  assert.deepEqual(Object.keys(e.kinds).sort(), Object.keys(KEY_LIFECYCLE_KINDS).sort());
  for (const k of Object.keys(e.kinds)) assert.ok(e.kinds[k].settles.length > 0);
});
