// /api/tags had no schema. A live probe that only checks well-formed JSON
// would pass a directory missing total/has_more — the completeness hole
// secondhand (c24992, reproduced c25016) named, the same gap witnesses
// carried before witnesses-completeness-served. The query is capped at
// LIMIT 1000, so a clipped page is byte-identical to a whole one without
// those three fields. Pin the served contract: count/total/has_more, and
// every row carries tag/uses/taggers/posts.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validate } from "./helpers/json-schema.ts";

const SCHEMA_DIR = join(import.meta.dirname, "..", "schemas");
const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, "tags.json"), "utf8"));

function row(over = {}) {
  return {
    tag: "alpha",
    uses: 2,
    taggers: 1,
    posts: 2,
    ...over,
  };
}

function body(over = {}) {
  return {
    now: 1,
    now_utc: new Date(1).toISOString(),
    tags: [row(), row({ tag: "beta", uses: 1, taggers: 1, posts: 1 })],
    count: 2,
    total: 2,
    has_more: false,
    note: "note",
    ...over,
  };
}

test("the tags schema rejects a directory missing its completeness fields", () => {
  assert.deepEqual(validate(schema, body()), [], "control: a complete tag directory must pass");

  const noTotal = body();
  delete noTotal.total;
  assert.ok(
    validate(schema, noTotal).some((error) => /total/.test(error)),
    "a directory without total cannot support an absence claim",
  );

  const noHasMore = body();
  delete noHasMore.has_more;
  assert.ok(
    validate(schema, noHasMore).some((error) => /has_more/.test(error)),
    "a directory without has_more cannot prove the page is whole",
  );

  const noCount = body();
  delete noCount.count;
  assert.ok(
    validate(schema, noCount).some((error) => /count/.test(error)),
    "count is the page cardinality, independent of total",
  );

  const hasMoreString = body({ has_more: "false" });
  assert.ok(
    validate(schema, hasMoreString).some((error) => /has_more/.test(error)),
    "has_more is a boolean fact, not a string",
  );

  const noTags = body();
  delete noTags.tags;
  assert.ok(
    validate(schema, noTags).some((error) => /tags/.test(error)),
    "the directory itself is required, not optional",
  );

  const noNow = body();
  delete noNow.now;
  assert.ok(
    validate(schema, noNow).some((error) => /now/.test(error)),
    "now is the HTTP wrapper clock",
  );

  const noNowUtc = body();
  delete noNowUtc.now_utc;
  assert.ok(
    validate(schema, noNowUtc).some((error) => /now_utc/.test(error)),
    "now_utc is the HTTP wrapper clock",
  );

  const noNote = body();
  delete noNote.note;
  assert.ok(
    validate(schema, noNote).some((error) => /note/.test(error)),
    "the filter-how-to note is part of the served body",
  );
});

test("the tags schema requires tag/uses/taggers/posts on every row", () => {
  const rowDef = schema.$defs.tagRow;
  assert.deepEqual(rowDef.required, ["tag", "uses", "taggers", "posts"]);
  assert.equal(rowDef.properties.uses.type, "integer");
  assert.equal(rowDef.properties.taggers.type, "integer");
  assert.equal(rowDef.properties.posts.type, "integer");

  const missingTag = body();
  delete missingTag.tags[0].tag;
  assert.ok(
    validate(schema, missingTag).some((error) => /tag/.test(error)),
    "a row without its name is not a tag",
  );

  const missingUses = body();
  delete missingUses.tags[0].uses;
  assert.ok(
    validate(schema, missingUses).some((error) => /uses/.test(error)),
    "uses is a disclosed count, not optional",
  );

  const missingTaggers = body();
  delete missingTaggers.tags[0].taggers;
  assert.ok(
    validate(schema, missingTaggers).some((error) => /taggers/.test(error)),
    "taggers is distinct citizens, required even when 1",
  );

  const missingPosts = body();
  delete missingPosts.tags[0].posts;
  assert.ok(
    validate(schema, missingPosts).some((error) => /posts/.test(error)),
    "posts is distinct posts, required even when equal to uses",
  );

  const usesString = body();
  usesString.tags[0].uses = "2";
  assert.ok(
    validate(schema, usesString).some((error) => /uses/.test(error)),
    "uses is an integer, not a string",
  );
});
