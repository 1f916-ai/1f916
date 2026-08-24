// The published schema and the running registry disagreed about what an event
// can be, and the test built to catch that class could only notice after the
// fact — and then only on a day the offending row happened to be inside the
// 500-row window.
//
// What happened, 2026-08-18: identity event 1400 was written at 20:02:36.496Z
// with kind "binding-verified", the first row of a kind schemas/events.json
// did not list. From that moment `live: /api/events conforms to events.json`
// failed on a clean checkout of main. Nothing on main runs the suite — the
// workflow that fires on a push to main is the witness job — so main stayed
// green while every pull request opened after 20:02Z went red for a reason
// its author had not caused. PR #127's own green check was earned at
// 2026-08-18T15:52:49Z, four hours and ten minutes before the event that
// breaks it existed, so a stale pass and a fresh failure sat on the same
// unchanged code.
//
// "binding-lapsed" is the same defect that had not fired yet: it is written by
// the same binding sweep and no domain had lapsed, so adding only the kind that
// had already appeared would have fixed the symptom and left the mechanism.
//
// This test derives the emitted kinds from the source rather than restating
// them, so the next kind added to the code fails here — in a PR, on the change
// that introduces it — instead of failing every unrelated PR opened afterwards.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/society.ts", import.meta.url), "utf8");
const schema = JSON.parse(readFileSync(new URL("../schemas/events.json", import.meta.url), "utf8"));

// Every identity event is committed as an object literal carrying citizen_id
// and kind together. Anchoring on citizen_id is what keeps unrelated `kind`
// fields out: the cursor union in changes() and the mojibake finding records
// both use `kind` and neither has a citizen_id beside it.
function emittedKinds(src: string): string[] {
  const found = new Set<string>();
  for (const m of src.matchAll(/citizen_id:[\s\S]{0,120}?kind:\s*"([a-z._-]+)"/g)) found.add(m[1]);
  return [...found].sort();
}

function schemaKinds(): string[] {
  const k = schema.properties?.events?.items?.properties?.kind?.enum;
  assert.ok(Array.isArray(k), "events.json must declare the kind enum where this test reads it");
  return [...k].sort();
}

test("the derivation finds the kinds it is supposed to find", () => {
  // A guard whose extractor silently returns nothing would pass forever. Two
  // anchors: a floor on the count, and two kinds asserted by name — one that
  // has fired and one that has not.
  const emitted = emittedKinds(source);
  assert.ok(emitted.length >= 19, `expected at least 19 emitted kinds, derived ${emitted.length}`);
  assert.ok(emitted.includes("binding-verified"), "the kind that broke the live schema check");
  assert.ok(emitted.includes("binding-lapsed"), "and the one that had not fired yet");
  assert.ok(emitted.includes("moderation"), "and an ordinary long-standing one");
});

test("the extractor does not sweep up non-identity kind fields", () => {
  // These are real `kind:` occurrences in the codebase that are NOT identity
  // events. If the anchor is ever loosened, this fails before the enum does.
  const emitted = emittedKinds(source);
  for (const notAnEvent of ["live", "snapshot"]) {
    assert.ok(!emitted.includes(notAnEvent), `${notAnEvent} is a cursor kind, not an identity event`);
  }
});

test("every event kind the code can write is allowed by the published schema", () => {
  const emitted = emittedKinds(source);
  const allowed = new Set(schemaKinds());
  const missing = emitted.filter((k) => !allowed.has(k));
  assert.deepEqual(
    missing,
    [],
    `schemas/events.json rejects ${missing.length} kind(s) this code writes: ${missing.join(", ")}. ` +
      "The live endpoint will serve them and test/schema.test.ts will fail for every open PR until the enum is updated.",
  );
});

test("the check is one-directional, and deliberately so", () => {
  // The reverse containment is NOT asserted. A kind can legitimately sit in the
  // schema with no writer left in the code: the rows it already wrote are still
  // in the log and still have to validate. Removing a kind from the enum
  // because nothing emits it any more would break the archive, so this test
  // never asks the schema to shrink.
  const allowed = schemaKinds();
  const emitted = new Set(emittedKinds(source));
  const schemaOnly = allowed.filter((k) => !emitted.has(k));
  // Schema-only kinds are legitimate: a kind retired from the code still has
  // historical rows that must keep validating. So this direction is RECORDED,
  // never failed on. But `Array.isArray` of a value we just built with .filter
  // is true no matter what the code does, and it printed nothing either, so
  // the record was empty and the case could never go red. Pin the set instead:
  // a new schema-only kind is a deliberate act and should have to say so here.
  assert.deepEqual(
    schemaOnly.sort(),
    [],
    "every kind the schema allows currently has a code path that can emit it. " +
      "A kind appearing here is allowed and sometimes correct (one retired from " +
      "the code whose historical rows must still validate), but it is a decision, " +
      "so name it here rather than letting the schema drift ahead of the code. " +
      "Note this is about EMISSION, not rows: witness-rotate, listing-withdrawn " +
      "and binding-lapsed are all emittable and merely have no live rows yet.",
  );
});
