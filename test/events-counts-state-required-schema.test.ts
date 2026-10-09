// GET /api/events always serves counts_state (complete|short|no_such_kind|
// declared_zero_rows|no_such_citizen) and citizen_filter_is_a_known_citizen
// (null|boolean) beside the prose notes. schemas/events.json and
// schemas/events-paged.json listed both properties but left them out of
// required, so an events page that dropped the machine census token or the
// known-citizen flag still validated — false green on a walk that reads
// counts_note as optional color. Soft-power requires both on both schemas.
//
// Complements #525 (requires the prose counts_note / declared_kinds_note).
// Live evidence 2026-09-27: every probed shape serves counts_state; citizen
// filter flag is null without ?citizen=, true/false with a handle.
//
// Killing mutations:
//   1. Drop counts_state from required — token-free page validates.
//   2. Drop citizen_filter_is_a_known_citizen from required — omit validates.
//   3. Allow enum value outside the five — unknown token validates.
//
// Soft-power / cloudymcclouder. Schema-only. No clients/*. Not a twin of #525
// (prose notes) or cloudy/gooseberry.

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

const ENUM = ["complete", "short", "no_such_kind", "declared_zero_rows", "no_such_citizen"] as const;

function basePaged(over: Record<string, unknown> = {}) {
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
    counts_state: "complete",
    citizen_filter_is_a_known_citizen: null,
    counts_note: "Complete for this view.",
    declared_kinds_note: "declared_kinds is a literal in src/society.ts.",
    ...over,
  };
}

function baseDesc(over: Record<string, unknown> = {}) {
  const b = basePaged(over) as Record<string, unknown>;
  delete b.order;
  delete b.latest_event_id;
  return b;
}

for (const [label, schema] of [
  ["events-paged.json", paged],
  ["events.json", desc],
] as const) {
  test(`${label} requires counts_state enum + citizen_filter_is_a_known_citizen`, () => {
    assert.ok(schema.required.includes("counts_state"));
    assert.ok(schema.required.includes("citizen_filter_is_a_known_citizen"));
    assert.deepEqual(schema.properties.counts_state.enum, [...ENUM]);
    assert.deepEqual(schema.properties.citizen_filter_is_a_known_citizen.type, ["boolean", "null"]);
  });
}

test("complete pages validate; dropping machine census fields does not", () => {
  assert.deepEqual(validate(paged, basePaged()), []);
  assert.deepEqual(validate(desc, baseDesc()), []);
  for (const [schema, body] of [
    [paged, basePaged()],
    [desc, baseDesc()],
  ] as const) {
    for (const k of ["counts_state", "citizen_filter_is_a_known_citizen"] as const) {
      const bad = { ...body };
      delete (bad as Record<string, unknown>)[k];
      assert.ok(
        validate(schema, bad).some((e: string) => e.includes(k)),
        `drop ${k} must fail`,
      );
    }
    assert.ok(
      validate(schema, { ...body, counts_state: "unknown_token" }).some((e: string) =>
        /counts_state/.test(e),
      ),
      "unknown counts_state must fail",
    );
  }
});

test("each declared counts_state value validates", () => {
  for (const v of ENUM) {
    assert.deepEqual(validate(paged, basePaged({ counts_state: v })), []);
    assert.deepEqual(validate(desc, baseDesc({ counts_state: v })), []);
  }
  assert.deepEqual(
    validate(paged, basePaged({ citizen_filter_is_a_known_citizen: false, counts_state: "no_such_citizen" })),
    [],
  );
});
