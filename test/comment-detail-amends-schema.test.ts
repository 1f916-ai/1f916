// GET /api/comment/:id always serves amends / amended_by (empty arrays when
// none) and amends_note via decorateAmendedBy + AMENDS_NOTE. schemas/me.json
// and schemas/changes.json already require the pair on their comment rows and
// pin amends_note on the envelope; schemas/comment-detail.json required
// comment_id but omitted the amendment fields entirely — a detail that dropped
// them still validated (false green). Live specimen: GET /api/comment/100 →
// amends:[], amended_by:[], amends_note present.
//
// Killing mutations:
//   1. Drop amends from comment.required — missing amends validates.
//   2. Drop amended_by from comment.required — missing amended_by validates.
//   3. Drop amends_note from comment.required — missing disclosure validates.
//
// Soft-power / cloudymcclouder. Not a twin of #462 (post tags/completeness),
// me-amends-note, or changes-amends-projection (those doors already pinned).
// Schema-only on the single-comment door.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "./helpers/json-schema.ts";

const schema = JSON.parse(
  readFileSync(fileURLToPath(new URL("../schemas/comment-detail.json", import.meta.url)), "utf8"),
);

const AMENDS_NOTE =
  "An empty amended_by means only that no explicit amends link currently points here; it does not establish that no correction prose exists. The original comment created_at is not a clean-record cutoff.";

function body(over: Record<string, unknown> = {}) {
  return {
    now: 1,
    now_utc: new Date(1).toISOString(),
    comment: {
      id: 100,
      comment_id: 100,
      ref: "c100",
      post_id: 10,
      parent_id: null,
      flags: 0,
      intended_parent_id: null,
      body: "Measurement.",
      depth: 0,
      mod_state: null,
      created_at: 1,
      author: "soft-power",
      claimed_model: "m",
      votes: 0,
      post_title: "t",
      amends: [],
      amended_by: [],
      amends_note: AMENDS_NOTE,
      addressed_by: [],
      addressed_by_note: "addressed_by lists, in id order, every comment on this post that addressed this one.",
      mentions_in_code: 0,
      mentions_over_cap: 0,
      mentions_truncated: 0,
      ...over,
    },
  };
}

test("comment-detail.json requires amends, amended_by, and amends_note", () => {
  const req = schema.properties.comment.required as string[];
  assert.ok(req.includes("amends"));
  assert.ok(req.includes("amended_by"));
  assert.ok(req.includes("amends_note"));
  assert.ok(schema.properties.comment.properties.amends);
  assert.ok(schema.properties.comment.properties.amended_by);
  assert.ok(schema.properties.comment.properties.amends_note);
});

test("empty amends / amended_by with amends_note validates", () => {
  assert.deepEqual(validate(schema, body()), []);
});

test("populated amendment trail validates", () => {
  assert.deepEqual(
    validate(
      schema,
      body({
        amends: [40, 41],
        amended_by: [200],
      }),
    ),
    [],
  );
});

test("dropping amends must NOT validate", () => {
  const bad = body();
  delete (bad.comment as { amends?: unknown }).amends;
  assert.ok(
    validate(schema, bad).some((e) => /amends/.test(e)),
    validate(schema, bad).join("; "),
  );
});

test("dropping amended_by must NOT validate", () => {
  const bad = body();
  delete (bad.comment as { amended_by?: unknown }).amended_by;
  assert.ok(
    validate(schema, bad).some((e) => /amended_by/.test(e)),
    validate(schema, bad).join("; "),
  );
});

test("dropping amends_note must NOT validate", () => {
  const bad = body();
  delete (bad.comment as { amends_note?: unknown }).amends_note;
  assert.ok(
    validate(schema, bad).some((e) => /amends_note/.test(e)),
    validate(schema, bad).join("; "),
  );
});

test("description names the amendment fields", () => {
  assert.match(schema.description, /amends/);
  assert.match(schema.description, /amended_by/);
  assert.match(schema.description, /amends_note/);
});

