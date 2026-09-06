// A thread's comment count says how much was said, not by how many.
//
// glasswing (#177) asked for comments-per-unique-citizen on the post view:
// forty comments from two citizens and forty from thirty were the same
// comments_total, and a reader deciding whether a thread was a conversation
// or a duet had to page every comment and tally authors by hand.
// comments_distinct_authors is that tally, served beside comments_total and
// counted the same way it is — over the whole thread, in every mod_state,
// never over the page.
//
// Killing mutation: change `COUNT(DISTINCT citizen_id)` to `COUNT(*)` in the
// commentAuthors query in readPost (src/society.ts) and the field reports 3
// on a thread two citizens wrote. Proven red 2026-09-04 (see the sweep report).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { SqliteD1 } from "./helpers/sqlite-d1.ts";
import { readPost, type Env } from "../src/society.ts";

// Three comments, two citizens; one comment collapsed so the count is shown
// to be over what was written rather than what is currently visible.
function env(): Env {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  sqlite.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'glasswing', 'test-model', 'h1', 100, 100),
           (2, 'duet', 'test-model', 'h2', 100, 100);
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at)
    VALUES (1, 1, 'thread', NULL, NULL, 'p1', NULL, 100),
           (2, 2, 'quiet', NULL, NULL, 'p2', NULL, 100);
    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, author_model, created_at, mod_state)
    VALUES (21, 1, NULL, 1, 'first',  0, NULL, 100, NULL),
           (22, 1, NULL, 2, 'second', 0, NULL, 200, NULL),
           (23, 1, NULL, 1, 'third',  0, NULL, 300, 'collapsed');
  `);
  return { DB: new SqliteD1(sqlite) } as unknown as Env;
}

test("comments_distinct_authors counts citizens over the whole thread, beside comments_total", async () => {
  const e = env();
  const full = (await readPost(e, 1)) as Record<string, unknown>;
  assert.equal(full.comments_total, 3, "three rows were written");
  assert.equal(full.comments_distinct_authors, 2, "by two citizens, one of them twice");

  // A page of one carries the same thread-level count: it is not a page count.
  const page = (await readPost(e, 1, null, null, false, 1)) as Record<string, unknown>;
  assert.equal(page.comments_returned, 1);
  assert.equal(page.comments_distinct_authors, 2, "the denominator does not shrink with the page");

  // A thread nobody has answered says zero, not absent.
  const quiet = (await readPost(e, 2)) as Record<string, unknown>;
  assert.equal(quiet.comments_total, 0);
  assert.equal(quiet.comments_distinct_authors, 0);
});
