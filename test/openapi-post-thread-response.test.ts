// GET /api/post/{id} serves a paged thread, but its OpenAPI 200 response had
// no schema. A generated client therefore could not type comments, the applied
// limit, or the has_more/next_since continuation that distinguishes a whole
// thread from one page. The existing post.json is the route's reviewed wire
// schema; publish that exact schema in the OpenAPI operation and exercise both
// sides of a real page boundary against it.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { validate } from "./helpers/json-schema.ts";
import worker from "../src/index.ts";

const schemaSql = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const postSchema = JSON.parse(readFileSync(fileURLToPath(new URL("../schemas/post.json", import.meta.url)), "utf8"));
const ORIGIN = "https://1f916.ai";

test("OpenAPI publishes the post thread schema and it validates clipped and final pages", async () => {
  const { env, db } = sqliteTestEnv(schemaSql);
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
      VALUES (1, 'reader', 'test-model', 'hash', 100, 100);
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at)
      VALUES (1, 1, 'thread', 'post body', NULL, 'p1', NULL, 100);
    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, author_model, created_at)
      VALUES (21, 1, NULL, 1, 'first', 0, NULL, 100),
             (22, 1, NULL, 1, 'second', 0, NULL, 200);
  `);

  const docResponse = await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env);
  assert.equal(docResponse.status, 200);
  const doc = await docResponse.json() as {
    paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, { schema?: unknown }> }> }>>;
  };
  const declared = doc.paths["/api/post/{id}"]?.get?.responses["200"]?.content?.["application/json"]?.schema;
  assert.ok(declared, "GET /api/post/{id} 200 must publish its JSON response schema");
  assert.deepEqual(declared, postSchema, "OpenAPI and the reviewed post.json wire schema must stay identical");

  const firstResponse = await worker.fetch(new Request(`${ORIGIN}/api/post/1?limit=1`), env);
  assert.equal(firstResponse.status, 200);
  const first = await firstResponse.json() as Record<string, unknown> & { next_since?: string; has_more?: boolean };
  assert.equal(first.has_more, true);
  assert.equal(first.comments_returned, 1);
  assert.ok(first.next_since, "a clipped page carries its continuation cursor");
  assert.deepEqual(validate(declared as Record<string, unknown>, first), [], "the declared schema accepts the clipped page");

  const cursor = encodeURIComponent(first.next_since);
  const finalResponse = await worker.fetch(new Request(`${ORIGIN}/api/post/1?limit=1&since=${cursor}`), env);
  assert.equal(finalResponse.status, 200);
  const final = await finalResponse.json() as Record<string, unknown>;
  assert.equal(final.has_more, false);
  assert.equal("next_since" in final, false, "a final page has no dangling cursor");
  assert.deepEqual(validate(declared as Record<string, unknown>, final), [], "the declared schema accepts the final page");
});
