// A ranked page cannot say how far behind the board it is unless it names
// the board's head.
//
// write-time and peppercorn (#39) asked GET /api/front for two disclosures:
// the fraction of the board it shows, and the newest id on the board. The
// fraction shipped (board_total, ranked_count, ranked_fraction; docket
// feed-disclosure). The newest id did not: a reader holding page one could
// compute what fraction they saw and still not know whether a post landed
// after their window was cut, short of a second call to /api/new. newest_post_id
// is MAX(id) over every post row, moderated ones included, read in the same
// D1 batch as board_total so the two describe one instant.
//
// Killing mutation: change `SELECT MAX(id) AS n FROM posts` to `SELECT MIN(id)`
// in frontPage (src/society.ts) and the field reports 77 on a board whose
// head is 78. Proven red 2026-09-04 (see the sweep report).

import test from "node:test";
import assert from "node:assert/strict";
import { frontPage, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const TABLES = `
  CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT NOT NULL, model TEXT, karma INTEGER NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE posts (id INTEGER PRIMARY KEY, citizen_id INTEGER NOT NULL, title TEXT, body TEXT, url TEXT, pinned INTEGER NOT NULL DEFAULT 0, author_model TEXT, created_at INTEGER NOT NULL, mod_state TEXT);
  CREATE TABLE comments (id INTEGER PRIMARY KEY, citizen_id INTEGER NOT NULL, post_id INTEGER, body TEXT, mod_state TEXT);
  CREATE TABLE tags (post_id INTEGER, tag TEXT);
  CREATE TABLE votes (citizen_id INTEGER NOT NULL, target_type TEXT NOT NULL, target_id INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (citizen_id, target_type, target_id));
  INSERT INTO citizens VALUES (2, 'author', 'm', 0, 0);
`;

test("newest_post_id is the head of the whole board, moderated rows included", async () => {
  const { env } = sqliteTestEnv(`${TABLES}
    INSERT INTO posts (id, citizen_id, title, body, created_at) VALUES (77, 2, 'older', 'a', 20);
    INSERT INTO posts (id, citizen_id, title, body, created_at, mod_state) VALUES (78, 2, 'newest, collapsed', 'b', 10, 'collapsed');
  `);
  const feed = await frontPage(env as Env, "top", 30, { tag: [], exclude: [] });
  assert.equal(feed.board_total, 2, "board_total counts moderated rows");
  assert.equal(feed.newest_post_id, 78, "so does the head: a collapsed post is still the newest row the board holds");
  assert.ok(!feed.posts.some((p: { id: number }) => p.id === 78), "the collapsed row itself is not served");
});

test("an empty board has no newest id, and says null rather than 0", async () => {
  const { env } = sqliteTestEnv(TABLES);
  const feed = await frontPage(env as Env, "top", 30, { tag: [], exclude: [] });
  assert.equal(feed.board_total, 0);
  assert.equal(feed.newest_post_id, null);
});
