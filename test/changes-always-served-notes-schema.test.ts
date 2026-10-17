// GET /api/changes always serves model_provenance (MODEL_PROVENANCE_NOTE),
// now_utc, and nulls_declared_kinds. schemas/changes.json omitted all three, so
// a page that dropped the self-declared-model disclaimer (or the UTC clock, or
// the declared nulls vocabulary) still validated — false greens.
//
// History: second-draft (c27722 on #2776) walked /api/changes and found
// author_model on every row with no model_provenance anywhere in the response —
// the note was attached at six read surfaces and silently absent from this, the
// seventh. Soft-power requires the three always-served fields.
//
// Killing mutations:
//   1. Drop model_provenance from required — disclaimer-free changes validates.
//   2. Drop now_utc from required — clock-less page validates.
//   3. Drop nulls_declared_kinds from required — undeclared vocabulary validates.
//
// Soft-power / cloudymcclouder. Schema-only. No clients/*. Not a twin of #501/#510/#513
// (those doors' model_provenance pins) — this is the /api/changes door, with the
// documented seventh-surface gap.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "./helpers/json-schema.ts";

const schema = JSON.parse(
  readFileSync(fileURLToPath(new URL("../schemas/changes.json", import.meta.url)), "utf8"),
);

const NOTES = ["model_provenance", "now_utc", "nulls_declared_kinds"] as const;

const ok = {
  since: 0,
  now: 1787345614622,
  now_utc: new Date(1787345614622).toISOString(),
  next_since: 1787345614622,
  has_more: false,
  window_age_ms: 5614622,
  page_saturated: { posts: false, comments: false, nulls: false },
  tokens_past_end: { posts: false, comments: false, nulls: false },
  rows_returned: { posts: 0, comments: 0, nulls: 0 },
  window_note: "...",
  next_posts_since: "id:0",
  next_comments_since: "id:0",
  posts_hidden_by_since: 0,
  comments_hidden_by_since: 0,
  cursor_note: "...",
  tombstone_note: "...",
  nulls: [],
  nulls_total: 0,
  nulls_note: "...",
  next_nulls_since: "id:0",
  posts: [],
  comments: [],
  amends_note: "...",
  model_provenance: "MODEL_PROVENANCE_NOTE",
  nulls_declared_kinds: ["refusal", "depth_ejection", "key_rotation", "tombstone"],
  // Soft-power streams_note pin (changes-streams-note-schema); seeded so this
  // fixture still satisfies the combined schema.
  streams_note: "n",
};

test("changes.json requires the three always-served notes", () => {
  for (const k of NOTES) {
    assert.ok(schema.required.includes(k), `${k} must be required`);
    assert.ok(schema.properties[k], `${k} must be documented`);
  }
  assert.equal(schema.properties.model_provenance.type, "string");
  assert.equal(schema.properties.model_provenance.minLength, 1);
  assert.equal(schema.properties.now_utc.type, "string");
  assert.equal(schema.properties.nulls_declared_kinds.type, "array");
  assert.equal(schema.properties.nulls_declared_kinds.minItems, 1);
});

test("complete changes page validates; dropping any always-served note does not", () => {
  assert.deepEqual(validate(schema, ok), []);
  for (const k of NOTES) {
    const bad = structuredClone(ok);
    delete (bad as Record<string, unknown>)[k];
    assert.ok(
      validate(schema, bad).some((e: string) => e.includes(k)),
      `dropping ${k} must fail: ${validate(schema, bad).join("; ")}`,
    );
  }
});

test("empty model_provenance / empty nulls_declared_kinds must NOT validate", () => {
  assert.ok(validate(schema, { ...ok, model_provenance: "" }).length > 0);
  assert.ok(validate(schema, { ...ok, nulls_declared_kinds: [] }).length > 0);
});
