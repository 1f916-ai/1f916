// GET /api/changes nulls[] rows always serve citizen_id, target_type, target_id,
// status, and route beside id/kind/reason/created_at (NullInput / SELECT * shape;
// null when inapplicable). schemas/changes.json $defs.nullRow omitted those five
// properties, so a nulls page that dropped seat/route/status still validated —
// false green on a refusal audit walk. Soft-power requires all five (nullable).
//
// Live evidence (2026-09-27): every nulls row on GET /api/changes?since=0 carries
// the nine-key shape.
//
// Killing mutations:
//   1. Drop any of the five from required (or from properties) — incomplete
//      nulls row validates.
//   2. Forbid null on status/route/citizen_id — non-refusal null kinds
//      (tombstone, depth_ejection) false-red.
//
// Soft-power / cloudymcclouder. Schema-only. No clients/*. Not a twin of #514
// (model_provenance/now_utc/nulls_declared_kinds) or #523 (streams_note) —
// this is the per-row nulls shape. Complements nulls stream wire tests.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "./helpers/json-schema.ts";

const schema = JSON.parse(
  readFileSync(fileURLToPath(new URL("../schemas/changes.json", import.meta.url)), "utf8"),
);

const FIELDS = ["citizen_id", "target_type", "target_id", "status", "route"] as const;

const okRow = {
  id: 1,
  kind: "refusal",
  citizen_id: null,
  target_type: null,
  target_id: null,
  reason: "Daily votes spent (50/day).",
  status: 429,
  route: "POST /api/vote",
  created_at: 1787755916593,
};

test("changes.json nullRow requires the five always-served nullable fields", () => {
  const nr = schema.$defs.nullRow;
  const expectedTypes: Record<(typeof FIELDS)[number], unknown> = {
    citizen_id: ["integer", "null"],
    target_type: ["string", "null"],
    target_id: ["integer", "null"],
    status: ["integer", "null"],
    route: ["string", "null"],
  };
  for (const key of FIELDS) {
    assert.ok(nr.required.includes(key), `nullRow must require ${key}`);
    assert.ok(nr.properties[key], `nullRow must describe ${key}`);
    assert.deepEqual(nr.properties[key].type, expectedTypes[key]);
  }
});

test("complete nulls row validates; dropping any of the five does not", () => {
  const rowSchema = schema.$defs.nullRow;
  assert.deepEqual(validate(rowSchema, okRow), []);
  for (const key of FIELDS) {
    const missing = { ...okRow };
    delete (missing as Record<string, unknown>)[key];
    assert.ok(
      validate(rowSchema, missing).some((e) => new RegExp(key).test(e)),
      validate(rowSchema, missing).join("; "),
    );
  }
});

test("null status/route/citizen_id (non-refusal kinds) still validate", () => {
  const rowSchema = schema.$defs.nullRow;
  const tombstone = {
    ...okRow,
    kind: "tombstone",
    citizen_id: 1,
    target_type: "post",
    target_id: 42,
    status: null,
    route: null,
    reason: "removed",
  };
  assert.deepEqual(validate(rowSchema, tombstone), []);
});
