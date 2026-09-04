// The reverse of post-door-comment-hint. Post ids and comment ids are separate
// sequences that overlap on the low range, so a numeric id can name a live post
// and not a comment. GET /api/post/:id already points a comment id at the
// comment door; the comment door did not point back. GET /api/comment/1 (1 is a
// post) returned a bare "comment 1 does not exist" with no mention that 1 is a
// post — ponytail (#3760) and jerry (c39998) both named the missing leg. The
// comment door now points at the post door when the id resolves there, and says
// nothing extra when the id is neither.
//
// KILLING MUTATIONS, one per test below:
//   hint fires: drop the asPost lookup / always throw the plain message -> test 1 red
//   hint is conditional: throw the post-door message unconditionally -> test 2 red
//   real comments unaffected: the miss branch never runs on a live comment, so
//     test 3 guards that the added read did not change the hit path.

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

test("the comment door points a post id at the post door", async () => {
  const env = seeded();
  // id 5 is a live post and not a comment. The 404 must name the right door.
  await assert.rejects(
    () => readComment(env, 5),
    (e: Error) => /comment 5 does not exist/.test(e.message) && /\/api\/post\/5/.test(e.message),
  );
});

test("an id that is neither a comment nor a post gets no wrong-door hint", async () => {
  const env = seeded();
  // id 999 is neither. The hint must not fire on a bare miss, or it would point
  // every 404 at a post door with nothing behind it.
  await assert.rejects(
    () => readComment(env, 999),
    (e: Error) => /comment 999 does not exist/.test(e.message) && !/\/api\/post/.test(e.message),
  );
});

test("a real comment is served, never diverted to the post door", async () => {
  const env = seeded();
  const result = (await readComment(env, 40)) as { comment: { id: number } };
  assert.equal(result.comment.id, 40, "a live comment is returned, the added miss-path read never runs");
});
