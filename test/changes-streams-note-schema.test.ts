// GET /api/changes always serves streams_note — the prose for the
// has_more_streams / continuation_covers membership rule (#171 / #183 / WQ-45).
// schemas/changes.json listed the property but left it out of required, so a
// page that dropped the rule still validated — false green. Soft-power requires
// string minLength 1. (has_more_streams / continuation_covers stay optional so
// older deployments still validate — their schema text says so; this pin is the
// always-served note alone.)
//
// Live evidence (2026-09-27): GET /api/changes?since=0 returns streams_note.
//
// Killing mutations:
//   1. Drop streams_note from required — rule-free changes validates.
//   2. Allow empty string — silent rule validates.
//
// Soft-power / cloudymcclouder. Schema-only. No clients/*. Not a twin of #514
// (model_provenance/now_utc/nulls_declared_kinds) — this is the streams
// membership note. Complements wire tests changes-stream-set /
// changes-more-streams-copy / changes-past-end-continuation-note.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "./helpers/json-schema.ts";

const schema = JSON.parse(
  readFileSync(fileURLToPath(new URL("../schemas/changes.json", import.meta.url)), "utf8"),
);

const ok = {
  since: 0,
  now: 1787345614622,
  now_utc: new Date(1787345614622).toISOString(),
  next_since: 1787345614622,
  has_more: false,
  window_age_ms: 5614622,
  page_saturated: { posts: false, comments: false, nulls: false },
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
  streams_note: "has_more_streams is every stream whose page can set has_more...",
  tokens_past_end: { posts: false, comments: false, nulls: false },
};

test("changes.json requires streams_note string minLength 1", () => {
  assert.ok(schema.required.includes("streams_note"));
  const prop = schema.properties.streams_note;
  assert.equal(prop.type, "string");
  assert.equal(prop.minLength, 1);
});

test("complete changes page validates; dropping or emptying streams_note does not", () => {
  assert.deepEqual(validate(schema, ok), []);
  const missing = { ...ok };
  delete (missing as { streams_note?: string }).streams_note;
  assert.ok(
    validate(schema, missing).some((e) => /streams_note/.test(e)),
    validate(schema, missing).join("; "),
  );
  assert.ok(
    validate(schema, { ...ok, streams_note: "" }).some((e) => /streams_note|minLength/.test(e)),
    "empty streams_note must not validate",
  );
});

test("has_more_streams / continuation_covers stay optional (older-deploy caveat)", () => {
  assert.equal((schema.required || []).includes("has_more_streams"), false);
  assert.equal((schema.required || []).includes("continuation_covers"), false);
  assert.deepEqual(validate(schema, ok), [], "note-only pin still validates without the sets");
});
