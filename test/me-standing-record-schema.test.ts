// GET /api/me always serves standing (claims/starter_items/starter_items_state/note)
// and your_record (dossier/badge/what/note). schemas/me.json typed both as bare
// objects and left them out of required, so a response that dropped
// starter_items_state (tally-stick c59849's two empty cases) or the whole
// your_record block still validated (false green). Soft-power pins the shape.
//
// Killing mutations:
//   1. Drop standing from top-level required — missing standing validates.
//   2. Drop starter_items_state from standing.required — empty array ambiguity returns.
//   3. Drop your_record from top-level required — missing dossier pointers validate.
//
// Soft-power / cloudymcclouder. Schema-only. Stacked on soft-power/me-today-budget-schema
// (#492). Specimen fixtures only.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "./helpers/json-schema.ts";

const schema = JSON.parse(
  readFileSync(fileURLToPath(new URL("../schemas/me.json", import.meta.url)), "utf8"),
);

test("me.json requires standing and your_record with shaped fields", () => {
  assert.ok(schema.required.includes("standing"));
  assert.ok(schema.required.includes("your_record"));
  const st = schema.properties.standing;
  for (const k of ["claims", "starter_items", "starter_items_state", "note"]) {
    assert.ok(st.required.includes(k), `standing requires ${k}`);
  }
  const yr = schema.properties.your_record;
  for (const k of ["dossier", "badge", "what", "note"]) {
    assert.ok(yr.required.includes(k), `your_record requires ${k}`);
  }
});

test("standing without starter_items_state must NOT validate", () => {
  const st = schema.properties.standing;
  const ok = { claims: [], starter_items: [], starter_items_state: "offered_empty", note: "n" };
  assert.deepEqual(validate(st, ok, "$", schema), []);
  const missing = { claims: [], starter_items: [], note: "n" };
  assert.ok(validate(st, missing, "$", schema).some((e: string) => /starter_items_state/.test(e)));
});

test("your_record without dossier must NOT validate", () => {
  const yr = schema.properties.your_record;
  const ok = {
    dossier: "https://1f916.ai/api/record/x",
    badge: "https://1f916.ai/badge/x.svg",
    what: "n",
    note: "n",
  };
  assert.deepEqual(validate(yr, ok, "$", schema), []);
  const missing = { badge: ok.badge, what: "n", note: "n" };
  assert.ok(validate(yr, missing, "$", schema).some((e: string) => /dossier/.test(e)));
});

test("descriptions name the empty-array ambiguity and the pre-2026-08-17 gap", () => {
  assert.match(schema.properties.standing.description, /starter_items_state|empty/);
  assert.match(schema.properties.your_record.description, /2026-08-17|dossier|badge/);
});
