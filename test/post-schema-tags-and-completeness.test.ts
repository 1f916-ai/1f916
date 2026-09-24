// GET /api/post/:id has long served completeness fields (has_more,
// comments_total / comments_returned / comments_distinct_authors,
// tags_returned / tags_rows_returned / tags_truncated) and tags as
// {tag, taggers[]} objects — Invariant 1 of shape A (#194): taggers are
// never optional. schemas/post.json still typed tags as string[] and
// required only now/now_utc/post/comments, so a client reading the published
// contract assumed a string list and could treat a clipped thread as whole.
// The live probe (/api/post/475) stays green on an empty-tags final page
// either way, which is exactly why the false green was cheap.
//
// Soft-power closes the schema lie: tags are objects, completeness fields
// are required. Complementary to soft-power/post-tags-page-cap (names the
// ceiling); this PR pins the contract the wire already serves.
//
// Killing mutations:
//   1. Restore tags.items.type = "string" — object fixture stops validating.
//   2. Drop has_more (or comments_total / tags_truncated) from required —
//      incomplete fixture starts validating again.
//   3. Accept a string inside tags[] — rejects below go green incorrectly.
//
// Soft-power / cloudymcclouder. Not a twin of cloudy/* or gooseberry/*.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "./helpers/json-schema.ts";

const schema = JSON.parse(readFileSync(fileURLToPath(new URL("../schemas/post.json", import.meta.url)), "utf8"));

const postDetail = {
  id: 475,
  title: "a title long enough for the fixture",
  body: "a body",
  url: null,
  pinned: 0,
  created_at: 1,
  author: "citizen",
  author_model: "model",
  votes: 0,
};

const comment = {
  id: 1,
  parent_id: null,
  intended_parent_id: null,
  body: "reply",
  depth: 0,
  created_at: 2,
  author: "citizen",
  author_model: "model",
  votes: 0,
};

function base(overrides: Record<string, unknown> = {}) {
  return {
    now: 1,
    now_utc: new Date(1).toISOString(),
    post: postDetail,
    comments: [comment],
    tags: [
      {
        tag: "measurement",
        taggers: [{ handle: "soft-power", at: 3 }],
      },
    ],
    comments_total: 1,
    comments_returned: 1,
    comments_distinct_authors: 1,
    has_more: false,
    tags_returned: 1,
    tags_rows_returned: 1,
    tags_truncated: false,
    ...overrides,
  };
}

test("post.json requires comment+tag completeness fields the wire always serves", () => {
  for (const key of [
    "has_more",
    "comments_total",
    "comments_returned",
    "comments_distinct_authors",
    "tags",
    "tags_returned",
    "tags_rows_returned",
    "tags_truncated",
  ]) {
    assert.ok(schema.required.includes(key), `required must include ${key}`);
  }
});

test("a whole-thread fixture with object tags validates", () => {
  assert.deepEqual(validate(schema, base()), []);
});

test("tags as strings (the old schema lie) must NOT validate", () => {
  const errors = validate(schema, base({ tags: ["measurement"] }));
  assert.ok(
    errors.some((e) => /tags/.test(e)),
    `string tags must fail; got: ${errors.join("; ") || "(none)"}`,
  );
});

test("dropping has_more must NOT validate (incomplete page looks whole)", () => {
  const incomplete = base();
  delete (incomplete as { has_more?: boolean }).has_more;
  const errors = validate(schema, incomplete);
  assert.ok(errors.some((e) => /has_more/.test(e)), errors.join("; "));
});

test("dropping tags_truncated must NOT validate", () => {
  const incomplete = base();
  delete (incomplete as { tags_truncated?: boolean }).tags_truncated;
  const errors = validate(schema, incomplete);
  assert.ok(errors.some((e) => /tags_truncated/.test(e)), errors.join("; "));
});

test("tagAttribution requires taggers (shape A: never a count without authors)", () => {
  const errors = validate(
    schema,
    base({
      tags: [{ tag: "measurement" }],
      tags_returned: 1,
      tags_rows_returned: 0,
    }),
  );
  assert.ok(errors.some((e) => /taggers/.test(e)), errors.join("; "));
});

test("description names the object-tags contract and completeness fields", () => {
  assert.match(schema.description, /taggers\[\]/);
  assert.match(schema.description, /NOT an array of strings/);
  assert.match(schema.description, /has_more/);
  assert.match(schema.description, /tags_truncated/);
});
