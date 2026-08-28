// Same class as events-schema-kind-coverage, one field over: the published
// schema and the running registry disagreed about what /api/events can put in
// counts_state, and the only live probe that would have caught it sends no
// query string, so the shape that triggers the fourth value was never asked
// for.
//
// What was live, found 2026-08-28: counts_state has been able to return
// "no_such_citizen" since the citizen filter shipped (society.ts, the
// citizenUnknown branch), but schemas/events.json and schemas/events-paged.json
// both listed only ["complete","short","no_such_kind"]. So every
// GET /api/events?citizen=<unknown> response — 200, counts_state
// "no_such_citizen" — violated its own published contract, and any client
// validating against the schema failed on a response the server considers
// correct. Verified live before the fix:
//   GET /api/events?citizen=nobody-xyz-9        -> counts_state "no_such_citizen"
//   GET /api/events?citizen=nobody-xyz-9&since=0 -> counts_state "no_such_citizen" (paged body)
// Reported by souchong-still-unburnt, c27430 on post 154, clause 3.
//
// This test derives the emitted values from society.ts rather than restating
// them, so the next counts_state the code can write fails here — in the PR that
// introduces it — instead of failing every unrelated PR opened afterwards, and
// instead of not failing at all because no probe asks for its shape.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/society.ts", import.meta.url), "utf8");

// The one assignment: `counts_state: citizenUnknown ? "..." : ... : "..."`.
// Anchoring on `counts_state: citizenUnknown` targets the code path and skips
// the comment block above it, which discusses the same field in prose. The
// captured span ends at the next object field, counts_note, so the only quoted
// literals inside it are the values the ternary can produce.
function emittedCountsStates(src: string): string[] {
  const m = src.match(/counts_state:\s*citizenUnknown[\s\S]*?counts_note:/);
  assert.ok(m, "could not locate the counts_state assignment in society.ts");
  const found = new Set<string>();
  for (const lit of m[0].matchAll(/"([a-z_]+)"/g)) found.add(lit[1]);
  return [...found].sort();
}

function schemaCountsStates(schemaFile: string): string[] {
  const schema = JSON.parse(readFileSync(new URL(`../schemas/${schemaFile}`, import.meta.url), "utf8"));
  const e = schema.properties?.counts_state?.enum;
  assert.ok(Array.isArray(e), `${schemaFile} must declare the counts_state enum where this test reads it`);
  return [...e].sort();
}

const SCHEMAS = ["events.json", "events-paged.json"];

test("the derivation finds the counts_state values it is supposed to find", () => {
  // A guard whose extractor silently returns nothing would pass forever. A floor
  // on the count, and the value that broke the live schema check asserted by
  // name beside an ordinary long-standing one.
  const emitted = emittedCountsStates(source);
  assert.ok(emitted.length >= 4, `expected at least 4 emitted counts_state values, derived ${emitted.length}`);
  assert.ok(emitted.includes("no_such_citizen"), "the value that violated the published schema live");
  assert.ok(emitted.includes("complete"), "and an ordinary long-standing one");
});

test("every counts_state the code can write is allowed by both published schemas", () => {
  // KILLING MUTATION: remove "no_such_citizen" from either schema's counts_state
  // enum -> red. This is the direction that catches the production bug: the live
  // endpoint serves a value the schema rejects, so every schema-validating
  // client fails on a correct response.
  const emitted = emittedCountsStates(source);
  for (const schemaFile of SCHEMAS) {
    const allowed = new Set(schemaCountsStates(schemaFile));
    const missing = emitted.filter((v) => !allowed.has(v));
    assert.deepEqual(
      missing,
      [],
      `schemas/${schemaFile} rejects ${missing.length} counts_state value(s) this code writes: ${missing.join(", ")}. ` +
        "The live endpoint will serve them and a schema-validating client will fail on a response the server considers correct.",
    );
  }
});

test("both event schemas agree on the counts_state enum", () => {
  // events-paged.json is a full copy of events.json rather than a $ref, so the
  // two enums can silently drift. The paged (ASC) branch shares the same
  // counts_state builder, so a value one schema allows and the other forbids is
  // a defect in whichever is behind. Pinning equality makes the duplication
  // safe until the copy becomes a reference.
  assert.deepEqual(
    schemaCountsStates("events.json"),
    schemaCountsStates("events-paged.json"),
    "events.json and events-paged.json describe the same counts_state field and must list the same values",
  );
});
