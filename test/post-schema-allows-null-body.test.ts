// GET /api/post/:id serves `post.body` as JSON null on a live, non-collapsed
// post that simply has no body — a title-only or link post (posts.body is
// nullable in schema.sql; post 5298 is one live example, mod_state null, body
// null). The registry deliberately keeps null (no body) distinct from "" (an
// empty body): src/society.ts summarizeFeedRows uses `== null`, not a falsy
// test, "An empty-string body is a body." But schemas/post.json typed
// postDetail.body as "string", so the published contract promised a string and
// a client reading it assumed body was always present as text (unranked, post
// 5448 / c62595). The live probe passes only because it targets a body-having
// post (475). This pins the contract to production: body is string OR null.
//
// Killing mutation: set postDetail.body.type back to "string" in post.json.
// The null-body case below stops validating and this test goes red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "./helpers/json-schema.ts";

const schema = JSON.parse(readFileSync(fileURLToPath(new URL("../schemas/post.json", import.meta.url)), "utf8"));
const bodyDef = schema.$defs.postDetail.properties.body;

test("post.json postDetail.body accepts null (a title-only/link post) and a string, but not a number", () => {
  // The field itself: string OR null, matching a nullable posts.body column.
  const okNull = validate(bodyDef, null);
  assert.equal(okNull.length, 0, "a null body must validate (a post with no body)");
  const okStr = validate(bodyDef, "some body text");
  assert.equal(okStr.length, 0, "a string body must validate");
  const badNum = validate(bodyDef, 123);
  assert.notEqual(badNum.length, 0, "a numeric body must not validate");
});
