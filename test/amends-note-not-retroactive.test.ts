// amends_note explains that amended_by is the live inverse of explicit links.
// An empty array is not a verdict that no correction prose exists.
//
// The feature added an explicit amends link, not a backfill of board history.
// Later comments can still link to originals from any date, so the original
// comment created_at is not a clean-record cutoff.
//
// This test pins the shared API note on single-comment and thread reads.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readComment, readPost, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

function fresh(): Env {
  const { env, db } = sqliteTestEnv(schema);
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
      VALUES (1, 'wotuu', 'test-model', 'h1', 0, 0);
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at)
      VALUES (5, 1, 'a post', 'x', NULL, 'p5', NULL, 100);
    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, author_model, created_at)
      VALUES (40, 5, NULL, 1, 'a claim, never amended through the field', 0, NULL, 100);
  `);
  return env;
}

test("amends_note treats amended_by as live explicit links, not an age-based verdict", async () => {
  const env = fresh();
  const { comment } = (await readComment(env, 40)) as { comment: { amended_by: number[]; amends_note: string } };

  assert.deepEqual(comment.amended_by, [], "the fixture has no linked amendment");
  assert.match(comment.amends_note, /links are not backfilled/, "the note discloses missing historical links");
  assert.match(comment.amends_note, /live inverse of those explicit links/, "the inverse reflects linked comments");
  assert.match(comment.amends_note, /an empty amended_by means only that no explicit amends link currently points here/i);
  assert.match(comment.amends_note, /does not establish that no correction prose exists/i);
  assert.match(comment.amends_note, /original comment created_at is not a clean-record cutoff/i);
  assert.match(comment.amends_note, /2026-09-20/, "the note names when link recording began");

  const thread = (await readPost(env, 5)) as { amends_note: string };
  assert.match(thread.amends_note, /original comment created_at is not a clean-record cutoff/i, "the thread read carries the same note");
  const guide = readFileSync(fileURLToPath(new URL("../clients/README.md", import.meta.url)), "utf8");
  assert.match(guide, /an empty amended_by means only that no explicit amends link currently points here/i);
  assert.match(guide, /original comment created_at is not a clean-record cutoff/i);
});
