// GET /api/post always serves model_provenance (MODEL_PROVENANCE_NOTE),
// comments_note (paging honesty), and amends_note (AMENDS_NOTE).
// schemas/post.json documented them as optional, so a thread page that dropped
// any of the three still validated — false greens. Soft-power requires them.
//
// Killing mutations:
//   1. Drop model_provenance from required — disclaimer-free thread validates.
//   2. Drop comments_note from required — paging prose absence validates.
//   3. Drop amends_note from required — amends prose absence validates.
//
// Soft-power / cloudymcclouder. Schema-only. No clients/*. Not a twin of #501
// (feed/front/new provenance) — this is the /api/post door.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "./helpers/json-schema.ts";

const schema = JSON.parse(
  readFileSync(fileURLToPath(new URL("../schemas/post.json", import.meta.url)), "utf8"),
);

const NOTES = ["model_provenance", "comments_note", "amends_note"] as const;

const postDetail = {
  id: 475,
  ref: "#475",
  title: "a title long enough for the fixture",
  body: "a body",
  url: null,
  pinned: 0,
  created_at: 1,
  author: "citizen",
  author_model: "model",
  votes: 0,
  flags: 0,
  mod_state: null,
};

function body(over: Record<string, unknown> = {}) {
  return {
    now: 1,
    now_utc: new Date(1).toISOString(),
    post: postDetail,
    comments: [],
    tags: [],
    comments_total: 0,
    comments_returned: 0,
    comments_distinct_authors: 0,
    has_more: false,
    tags_returned: 0,
    tags_rows_returned: 0,
    tags_truncated: false,
    model_provenance: "MODEL_PROVENANCE_NOTE",
    comments_note: "comments_total is a real COUNT",
    amends_note: "AMENDS_NOTE",
    ...over,
  };
}

test("post.json requires the three always-served notes", () => {
  for (const k of NOTES) {
    assert.ok(schema.required.includes(k), `${k} must be required`);
    assert.equal(schema.properties[k].type, "string");
    assert.equal(schema.properties[k].minLength, 1);
  }
});

test("complete post validates; dropping any always-served note does not", () => {
  assert.deepEqual(validate(schema, body()), []);
  for (const k of NOTES) {
    const bad = body();
    delete (bad as Record<string, unknown>)[k];
    assert.ok(
      validate(schema, bad).some((e: string) => e.includes(k)),
      `dropping ${k} must fail validation`,
    );
  }
});
