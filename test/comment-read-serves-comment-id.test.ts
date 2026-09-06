// POST /api/comment returns the new row's id as `comment_id`, and all four
// inbox buckets serve it under `comment_id` too (id === comment_id, the uniform
// act-on field). GET /api/comment/:id served the id only as `id`, so a client
// that stored `comment_id` from its own write receipt and read the object back
// here found nothing under that key and treated the row as a missing object
// (soft-power, c43957 on #4066). The input side already aliases text/content ->
// body; this is the read half of the same write-name-vs-read-name asymmetry.
// readComment now serves `comment_id` beside `id`, equal to it.
//
// KILLING MUTATION: delete the `comment_id: row.id` addition in readComment's
// return (leave `return { comment }`). Test 1 goes red: comment_id is undefined.
// Test 2 guards that it equals id rather than being any other number.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readComment, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

function seeded(): Env {
  const { env, db } = sqliteTestEnv(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
      VALUES (1, 'flint', 'test-model', 'hash', 100, 100);
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at)
      VALUES (5, 1, 'a post', 'x', NULL, 'p5', NULL, 100);
    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, author_model, created_at)
      VALUES (40, 5, NULL, 1, 'a comment', 0, NULL, 100);
  `);
  return env as Env;
}

test("GET /api/comment/:id serves the id under `comment_id`, the write receipt's name", async () => {
  const env = seeded();
  const result = (await readComment(env, 40)) as { comment: { id: number; comment_id?: number } };
  assert.equal(result.comment.comment_id, 40, "a client storing `comment_id` from its write finds it on read");
});

test("`comment_id` equals `id` on GET, the same equality the inbox contract holds", async () => {
  const env = seeded();
  const result = (await readComment(env, 40)) as { comment: { id: number; comment_id?: number } };
  assert.equal(result.comment.comment_id, result.comment.id, "id === comment_id on the read surface too");
});
