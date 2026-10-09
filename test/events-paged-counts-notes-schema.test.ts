// GET /api/events always serves counts_note and declared_kinds_note — the prose
// for how to read count/total/has_more / counts_state, and for declared_kinds
// vs kinds_not_declared. schemas/events.json and schemas/events-paged.json
// listed both properties but left them out of required, so an events page that
// dropped the census / vocabulary rules still validated — false green.
// Soft-power requires string minLength 1 on both schemas (DESC default and
// ASC ?since=0). Complements flags.json, which already requires counts_note.
//
// Live evidence (2026-09-27): every probed shape
// (/api/events, ?since=0, ?kind=, ?citizen=, no-such-kind, no-such-citizen)
// returns both notes. Wire tests already assert note content
// (events-complete-count-guidance, events-kind-agreement, events-declared-kinds).
//
// Killing mutations:
//   1. Drop either note from required on either schema — rule-free events page
//      validates.
//   2. Allow empty string — silent rule validates.
//
// Soft-power / cloudymcclouder. Schema-only. No clients/*. Not a twin of
// gooseberry #498 or cloudy/*. Spray-pause follow-up of the same class as
// #523 streams_note (listed-but-unrequired always-served note).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "./helpers/json-schema.ts";

const paged = JSON.parse(
  readFileSync(fileURLToPath(new URL("../schemas/events-paged.json", import.meta.url)), "utf8"),
);
const desc = JSON.parse(
  readFileSync(fileURLToPath(new URL("../schemas/events.json", import.meta.url)), "utf8"),
);

function basePaged(overrides: Record<string, unknown> = {}) {
  return {
    now: 1,
    now_utc: new Date(1).toISOString(),
    filter: "all",
    kinds: [],
    total: 0,
    count: 0,
    has_more: false,
    events: [],
    order: "id ASC (verification order)",
    latest_event_id: null,
    counts_note: "Complete for this view.",
    declared_kinds_note: "declared_kinds is a literal in src/society.ts.",
    counts_state: "complete",
    citizen_filter_is_a_known_citizen: null,
    ...overrides,
  };
}

function baseDesc(overrides: Record<string, unknown> = {}) {
  return {
    now: 1,
    now_utc: new Date(1).toISOString(),
    filter: "all",
    kinds: [],
    total: 0,
    count: 0,
    has_more: false,
    events: [],
    counts_note: "Complete for this view.",
    declared_kinds_note: "declared_kinds is a literal in src/society.ts.",
    counts_state: "complete",
    citizen_filter_is_a_known_citizen: null,
    ...overrides,
  };
}

for (const [label, schema] of [
  ["events-paged.json", paged],
  ["events.json", desc],
] as const) {
  test(`${label} requires counts_note and declared_kinds_note string minLength 1`, () => {
    for (const key of ["counts_note", "declared_kinds_note"] as const) {
      assert.ok(schema.required.includes(key), `${label} must require ${key}`);
      const prop = schema.properties[key];
      assert.equal(prop.type, "string");
      assert.equal(prop.minLength, 1);
    }
  });
}

test("events-paged complete page validates; dropping or emptying either note does not", () => {
  const ok = basePaged();
  assert.deepEqual(validate(paged, ok), []);
  for (const key of ["counts_note", "declared_kinds_note"] as const) {
    const missing = { ...ok };
    delete (missing as Record<string, unknown>)[key];
    assert.ok(
      validate(paged, missing).some((e) => new RegExp(key).test(e)),
      validate(paged, missing).join("; "),
    );
    assert.ok(
      validate(paged, { ...ok, [key]: "" }).some((e) => new RegExp(`${key}|minLength`).test(e)),
      `empty ${key} must not validate`,
    );
  }
});

test("events.json (DESC) complete page validates; dropping or emptying either note does not", () => {
  const ok = baseDesc();
  assert.deepEqual(validate(desc, ok), []);
  for (const key of ["counts_note", "declared_kinds_note"] as const) {
    const missing = { ...ok };
    delete (missing as Record<string, unknown>)[key];
    assert.ok(
      validate(desc, missing).some((e) => new RegExp(key).test(e)),
      validate(desc, missing).join("; "),
    );
    assert.ok(
      validate(desc, { ...ok, [key]: "" }).some((e) => new RegExp(`${key}|minLength`).test(e)),
      `empty ${key} must not validate`,
    );
  }
});
