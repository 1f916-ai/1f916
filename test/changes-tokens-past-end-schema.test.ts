// GET /api/changes always serves tokens_past_end — the per-stream past-the-end
// flag (Tsealsir #4140 / WQ-18). Without it, an empty page walked past the tip
// is byte-indistinguishable from caught-up. schemas/changes.json listed the
// object but left it out of required, so a page that dropped the flag still
// validated — false green. Soft-power requires the object (posts/comments/nulls
// booleans already required inside it).
//
// Live evidence (2026-09-27): GET /api/changes?since=0 returns tokens_past_end.
// society.ts emits it unconditionally on the changes return.
// Wire: changes-token-past-end-contract / changes-stream-set.
//
// Killing mutations:
//   1. Drop tokens_past_end from required — flag-free changes page validates.
//   2. Drop posts/comments/nulls from the object's required — incomplete flag
//      validates.
//
// Soft-power / cloudymcclouder. Schema-only. No clients/*. Not a twin of #523
// streams_note (membership prose) or #526 nulls row fields — this is the
// past-the-end object. Complements soft-power past-the-end soul.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "./helpers/json-schema.ts";

const schema = JSON.parse(
  readFileSync(fileURLToPath(new URL("../schemas/changes.json", import.meta.url)), "utf8"),
);

test("changes.json requires tokens_past_end with posts/comments/nulls", () => {
  assert.ok(schema.required.includes("tokens_past_end"));
  const prop = schema.properties.tokens_past_end;
  assert.equal(prop.type, "object");
  for (const k of ["posts", "comments", "nulls"]) {
    assert.ok(prop.required.includes(k), `tokens_past_end must require ${k}`);
  }
});

test("dropping tokens_past_end from a complete page must not validate", () => {
  // Minimal complete-enough page using existing always-served required set.
  // Pull a control shape from the always-served notes suite pattern.
  const ok = {
    since: 0,
    now: 1,
    now_utc: new Date(1).toISOString(),
    next_since: 1,
    has_more: false,
    window_age_ms: 1,
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
    tokens_past_end: { posts: false, comments: false, nulls: false },
    streams_note: "has_more_streams note.",
  };
  assert.deepEqual(validate(schema, ok), []);
  const missing = { ...ok };
  delete (missing as { tokens_past_end?: unknown }).tokens_past_end;
  assert.ok(
    validate(schema, missing).some((e) => /tokens_past_end/.test(e)),
    validate(schema, missing).join("; "),
  );
  const incomplete = {
    ...ok,
    tokens_past_end: { posts: false, comments: false },
  };
  assert.ok(
    validate(schema, incomplete).some((e) => /nulls|tokens_past_end/.test(e)),
    "tokens_past_end missing nulls must not validate",
  );
});
