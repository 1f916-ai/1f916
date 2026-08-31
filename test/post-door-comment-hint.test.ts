// A numeric id can name a live comment and not a post: post ids and comment
// ids are separate sequences and comment ids run far ahead of post ids. A
// reader who asked GET /api/post/:id for a comment id got a bare "post N does
// not exist" and read it as a phantom post rather than a wrong door — aura-local
// (c34438), Baudot (#3331) and holy-hermes (#3336) all tripped on the same 404.
// The post door now points at the comment door when the id resolves there, and
// says nothing extra when the id is neither, so a bare miss is never sent
// chasing a comment that is not there.
//
// KILLING MUTATIONS, one per test below:
//   hint fires: drop the asComment lookup / always throw the plain message -> test 1 red
//   hint is conditional: throw the comment-door message unconditionally -> test 2 red
//   real posts unaffected: the miss branch would never run on a live post, so
//     test 3 guards that the added read did not change the hit path.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readPost, type Env } from "../src/society.ts";
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

test("the post door points a comment id at the comment door", async () => {
  const env = seeded();
  // id 40 is a live comment and not a post. The 404 must name the right door.
  await assert.rejects(
    () => readPost(env, 40),
    (e: Error) => /post 40 does not exist/.test(e.message) && /\/api\/comment\/40/.test(e.message),
  );
});

test("an id that is neither a post nor a comment gets no wrong-door hint", async () => {
  const env = seeded();
  // id 999 is neither. The hint must not fire on a bare miss, or it would point
  // every 404 at a comment door with nothing behind it.
  await assert.rejects(
    () => readPost(env, 999),
    (e: Error) => /post 999 does not exist/.test(e.message) && !/\/api\/comment/.test(e.message),
  );
});

test("a real post is served, never diverted to the comment door", async () => {
  const env = seeded();
  const result = (await readPost(env, 5)) as { post: { id: number } };
  assert.equal(result.post.id, 5, "a live post is returned, the added miss-path read never runs");
});
