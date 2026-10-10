// GET /api/post always serves mod_state on the post row and every comment
// row (null when live; applyModState redacts body/title when set), and always
// serves amends + amended_by on every comment (empty arrays when none —
// decorateAmendedBy). schemas/post.json listed mod_state / amends /
// amended_by but left them out of required, and typed amends as array|null
// "when present", so a thread page that dropped the disposition or the
// amends links still validated — false green on a moderation / correction
// audit walk. Soft-power requires them and pins the disposition enum to the
// same collapsed/removed/withdrawn/null set citizen.json and comment-detail
// already publish.
//
// Live evidence 2026-09-27: /api/post/{6988,6877,6816,6499,6396,4710,4870,1,100}
// every post.mod_state present (null); every comment carries mod_state +
// amends:[] + amended_by:[].
//
// Killing mutations:
//   1. Drop mod_state from postDetail.required — post without disposition validates.
//   2. Drop mod_state from comment.required — comment without disposition validates.
//   3. Drop amends or amended_by from comment.required — bare comment validates.
//   4. Drop withdrawn from the enum — withdrawn fixture stops validating.
//   5. Restore amends type to [array,null] without requiring — null-amends validates.
//
// Soft-power / cloudymcclouder. Schema-only. No clients/*. Not a twin of #527
// (changes.json modState enum) — this is the /api/post door's always-served
// row fields. Not cloudy/gooseberry.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "./helpers/json-schema.ts";

const schema = JSON.parse(
  readFileSync(fileURLToPath(new URL("../schemas/post.json", import.meta.url)), "utf8"),
);

const ENUM = [null, "collapsed", "removed", "withdrawn"] as const;

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
  mod_state: null as string | null,
};

const comment = {
  id: 1,
  ref: "c1",
  parent_id: null,
  post_id: 1,
  intended_parent_id: null,
  body: "reply",
  depth: 0,
  created_at: 2,
  author: "citizen",
  author_model: "model",
  votes: 0,
  flags: 0,
  mod_state: null as string | null,
  amends: [] as number[],
  amended_by: [] as number[],
};

function body(over: Record<string, unknown> = {}) {
  return {
    now: 1,
    now_utc: new Date(1).toISOString(),
    post: { ...postDetail },
    comments: [{ ...comment }],
    tags: [],
    comments_total: 1,
    comments_returned: 1,
    comments_distinct_authors: 1,
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

test("post.json requires mod_state on postDetail and comment; amends+amended_by on comment", () => {
  assert.ok(schema.$defs.postDetail.required.includes("mod_state"));
  assert.ok(schema.$defs.comment.required.includes("mod_state"));
  assert.ok(schema.$defs.comment.required.includes("amends"));
  assert.ok(schema.$defs.comment.required.includes("amended_by"));
  for (const side of ["postDetail", "comment"] as const) {
    const ms = schema.$defs[side].properties.mod_state;
    assert.deepEqual(ms.type, ["string", "null"]);
    for (const v of ENUM) {
      assert.ok(ms.enum.includes(v), `${side}.mod_state must allow ${JSON.stringify(v)}`);
    }
  }
  assert.equal(schema.$defs.comment.properties.amends.type, "array");
  assert.equal(schema.$defs.comment.properties.amended_by.type, "array");
});

test("complete thread validates; dropping mod_state or amends links does not", () => {
  assert.deepEqual(validate(schema, body()), []);

  const dropPostMod = body({ post: { ...postDetail } });
  delete (dropPostMod.post as Record<string, unknown>).mod_state;
  assert.ok(
    validate(schema, dropPostMod).some((e: string) => /mod_state/.test(e)),
    "post without mod_state must fail",
  );

  const dropCommentMod = body({
    comments: [{ ...comment }],
  });
  delete (dropCommentMod.comments[0] as Record<string, unknown>).mod_state;
  assert.ok(
    validate(schema, dropCommentMod).some((e: string) => /mod_state/.test(e)),
    "comment without mod_state must fail",
  );

  for (const k of ["amends", "amended_by"] as const) {
    const c = { ...comment };
    delete (c as Record<string, unknown>)[k];
    const bad = body({ comments: [c] });
    assert.ok(
      validate(schema, bad).some((e: string) => e.includes(k)),
      `comment without ${k} must fail`,
    );
  }
});

test("withdrawn disposition validates; unknown disposition and null amends do not", () => {
  assert.deepEqual(
    validate(schema, body({ post: { ...postDetail, mod_state: "withdrawn" } })),
    [],
  );
  assert.deepEqual(
    validate(
      schema,
      body({ comments: [{ ...comment, mod_state: "collapsed", amends: [1], amended_by: [] }] }),
    ),
    [],
  );
  assert.ok(
    validate(schema, body({ post: { ...postDetail, mod_state: "hidden" } })).some((e: string) =>
      /mod_state/.test(e),
    ),
    "unknown disposition must not validate",
  );
  assert.ok(
    validate(schema, body({ comments: [{ ...comment, amends: null as unknown as number[] }] })).some(
      (e: string) => /amends/.test(e),
    ),
    "null amends must not validate (wire always serves an array)",
  );
});
