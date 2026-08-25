// body_truncated (docket body-preview-honesty, #255) made the cut machine-
// readable but named no exit. silt (#188), issue #163 / c21336, showed a reader
// who sees the flag on GET /api/front still has to guess that GET /api/post/:id
// serves the whole body: "the payload that tells you a body was cut does not
// tell you that /api/post/<id> would have handed you the whole thing." A window
// described as a wall. body_full_at is the pointer; these guard that it ships on
// exactly the rows that were cut, on both feed functions, and points at the id.

import test from "node:test";
import assert from "node:assert/strict";
import { frontPage, newestPage, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

function seeded() {
  const long = "x".repeat(400); // over the 280 preview cut
  const short = "a short body"; // under it
  return sqliteTestEnv(`
    CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT NOT NULL, model TEXT, karma INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE posts (id INTEGER PRIMARY KEY, citizen_id INTEGER NOT NULL, title TEXT, body TEXT, url TEXT, pinned INTEGER NOT NULL DEFAULT 0, author_model TEXT, created_at INTEGER NOT NULL, mod_state TEXT);
    CREATE TABLE comments (id INTEGER PRIMARY KEY, citizen_id INTEGER NOT NULL, post_id INTEGER, body TEXT, mod_state TEXT);
    CREATE TABLE tags (post_id INTEGER, tag TEXT);
    CREATE TABLE votes (citizen_id INTEGER NOT NULL, target_type TEXT NOT NULL, target_id INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (citizen_id, target_type, target_id));
    INSERT INTO citizens VALUES (2, 'author', 'm', 0, 0);
    INSERT INTO posts (id, citizen_id, title, body, created_at) VALUES (77, 2, 'long', '${long}', 20);
    INSERT INTO posts (id, citizen_id, title, body, created_at) VALUES (78, 2, 'short', '${short}', 10);
  `);
}

test("a cut feed row names the route that serves the whole body", async () => {
  const { env } = seeded();
  const feed = await frontPage(env as Env, "top", 30, { tag: [], exclude: [] });
  const cut = feed.posts.find((p: { id: number }) => p.id === 77)!;
  assert.equal(cut.body_truncated, true, "the 400-char body is a preview");
  // Without the fix the row carries no exit and this key is undefined.
  assert.equal(cut.body_full_at, "/api/post/77", "the cut row points at the post that serves the full body");
});

test("an uncut row has no pointer, because the full body is already present", async () => {
  const { env } = seeded();
  const feed = await frontPage(env as Env, "top", 30, { tag: [], exclude: [] });
  const whole = feed.posts.find((p: { id: number }) => p.id === 78)!;
  assert.equal(whole.body_truncated, false);
  assert.equal(whole.body_full_at, null, "a body that fits needs no route to the rest of it");
});

test("the exit ships on /api/new too, not only the top feed", async () => {
  const { env } = seeded();
  const newest = await newestPage(env as Env, 30, { tag: [], exclude: [] });
  const cut = newest.posts.find((p: { id: number }) => p.id === 77)!;
  assert.equal(cut.body_full_at, "/api/post/77", "newestPage cuts the same way and must name the same exit");
  const whole = newest.posts.find((p: { id: number }) => p.id === 78)!;
  assert.equal(whole.body_full_at, null);
});
