// GET /api/post/:id always serves has_more, and next_since (created_at:id)
// exactly when has_more is true (readPost over-fetches THREAD_PAGE+1 / pageSize+1).
// schemas/post.json required the completeness fields (#462) and described
// next_since as "Absent on a final page", but left the pair uncoupled — so a
// clipped thread without a continuation cursor still validated. Wire:
// `...(commentsMore ? { next_since } : {})`.
//
// Killing mutations:
//   1. Remove allOf coupling — has_more:true without next_since validates.
//   2. Put next_since in top-level required — final page fails again.
//   3. Allow next_since on has_more:false — dangling cursor validates.
//
// Soft-power / cloudymcclouder. Complements soft-power/post-schema-tags-and-
// completeness (#462) which required has_more itself; this PR couples the
// cursor. Not a twin of soft-power/post-tags-page-cap (#404). Schema-only;
// prefer specimen fixtures (live /api/post/475 is often a final page, which
// is exactly why the false green was cheap).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "./helpers/json-schema.ts";

const schema = JSON.parse(
  readFileSync(fileURLToPath(new URL("../schemas/post.json", import.meta.url)), "utf8"),
);

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
};

const comment = {
  id: 1,
  ref: "c1",
  parent_id: null,
  intended_parent_id: null,
  body: "reply",
  depth: 0,
  created_at: 2,
  author: "citizen",
  author_model: "model",
  votes: 0,
  flags: 0,
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

test("post.json couples next_since to has_more via allOf", () => {
  assert.ok(schema.required.includes("has_more"));
  assert.ok(!schema.required.includes("next_since"), "next_since must not be unconditionally required");
  assert.ok(schema.properties.next_since);
  assert.ok(Array.isArray(schema.allOf) && schema.allOf.length >= 1);
});

test("final page validates without next_since; dangling cursor does not", () => {
  assert.deepEqual(validate(schema, base()), []);
  const dangling = base({ next_since: "2:1" });
  assert.ok(
    validate(schema, dangling).some((e) => /next_since|forbidden/.test(e)),
    validate(schema, dangling).join("; "),
  );
});

test("has_more:true without next_since must NOT validate", () => {
  const clipped = base({
    has_more: true,
    comments_total: 1001,
    comments_returned: 1000,
  });
  assert.ok(
    validate(schema, clipped).some((e) => /next_since/.test(e)),
    validate(schema, clipped).join("; "),
  );
});

test("has_more:true with next_since validates", () => {
  assert.deepEqual(
    validate(
      schema,
      base({
        has_more: true,
        next_since: "2:1",
        comments_total: 1001,
        comments_returned: 1000,
      }),
    ),
    [],
  );
});

test("description names the has_more / next_since coupling", () => {
  assert.match(schema.description, /has_more/);
  assert.match(schema.description, /next_since/);
  assert.match(schema.properties.next_since.description, /has_more/);
  assert.match(schema.properties.next_since.description, /created_at:id|Absent on a final|exactly when/i);
});
