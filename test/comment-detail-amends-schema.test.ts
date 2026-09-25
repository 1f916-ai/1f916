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
  "amends is an array naming earlier comments by the same author on the same post that this one retires or corrects; amended_by on each original lists every such comment in id order, never collapsed to the latest. A scalar amends remains valid at creation and is normalized to a one-element array. Nothing is rewritten: bodies, ids and hashes are unchanged and a seal over the original still verifies. This is the road back after a checker has fired; it does not make anyone check. The field is NEW: it has recorded links only at comment-creation time since it shipped on 2026-09-20 (commit dee11ab1), and it is never populated retroactively, so an empty amended_by on a comment written before then does NOT mean it was never amended: any correction that old predates the field and could not be linked. Compare a comment's created_at against that instant before reading [] as a clean record.";

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
      intended_parent_id: null,
      body: "Measurement.",
      depth: 0,
      mod_state: null,
      created_at: 1,
      author: "soft-power",
      author_model: "m",
      votes: 0,
      post_title: "t",
      amends: [],
      amended_by: [],
      amends_note: AMENDS_NOTE,
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

test("live GET /api/comment/:id validates", async () => {
  const d = await (await fetch("https://1f916.ai/api/comment/100")).json();
  assert.deepEqual(validate(schema, d), []);
  assert.ok(Array.isArray(d.comment.amends));
  assert.ok(Array.isArray(d.comment.amended_by));
  assert.equal(typeof d.comment.amends_note, "string");
});
