// GET /api/post/:id served `votes` (the raw count) but omitted `weighted_votes`
// entirely — the key was absent, not zero. A client reading a post directly and
// defaulting the missing key to 0 rendered a ranking number it never computed,
// and the gap failed silently in the direction that looks fine (assay
// c147862/c147866/c147867, posts #12450/#12451). The detail route now serves the
// same tenure-weighted score /api/front does, plus the response-level note.
//
// Killing mutation: delete the weighted_votes subquery (or the `weighted_votes:`
// field) from readPost in src/society.ts. The `"weighted_votes" in post` and
// value assertions below go red; the control (votes, note present) stays green.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { SqliteD1 } from "./helpers/sqlite-d1.ts";
import { readPost, WEIGHTED_VOTES_NOTE, type Env } from "../src/society.ts";

const WEEK = 604_800_000;
const NOW = 10 * WEEK; // the read instant the weight curve is sampled at

// Two posts: #1 has one vote from a citizen exactly a third of a week old, so
// the curve min(1, max(0.1, age/WEEK)) gives weight 0.33333... — a value whose
// raw sum is NOT two-decimal, so the served 0.33 proves the route rounds the
// total (the one rounding WEIGHTED_VOTES_NOTE describes), not the raw subquery
// spread. #2 has no votes (weighted_votes 0, never absent).
const THIRD_WEEK = WEEK / 3; // 201_600_000 ms, an exact integer
function env(): Env {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  const born = NOW - THIRD_WEEK; // one third of a week -> 0.33333... weight
  sqlite.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'author', 'test-model', 'h1', 100, 100),
           (5, 'v5', 'test-model', 'h5', ${born}, ${born});
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at)
    VALUES (1, 1, 'voted post', 'a body', NULL, 'p1', NULL, 100),
           (2, 1, 'quiet post', 'a body', NULL, 'p2', NULL, 100);
    INSERT INTO votes (citizen_id, target_type, target_id, created_at)
    VALUES (5, 'post', 1, ${NOW});
  `);
  return { DB: new SqliteD1(sqlite) } as unknown as Env;
}

test("GET /api/post/:id serves weighted_votes and its note, never absent", async (t) => {
  const realNow = Date.now;
  t.after(() => { globalThis.Date.now = realNow; });
  globalThis.Date.now = () => NOW;

  const voted = (await readPost(env(), 1)) as { post: Record<string, unknown>; weighted_votes_note?: unknown };
  assert.equal("weighted_votes" in voted.post, true, "the detail post row carries weighted_votes, never absent");
  assert.equal(voted.post.votes, 1, "the raw votes count is unchanged");
  assert.equal(voted.post.weighted_votes, 0.33, "a 0.33333 weight is rounded once to the post total (0.33), not served raw");
  assert.equal(voted.weighted_votes_note, WEIGHTED_VOTES_NOTE, "the detail response carries the same ranking-score note the feed does");

  const quiet = (await readPost(env(), 2)) as { post: Record<string, unknown> };
  assert.equal("weighted_votes" in quiet.post, true, "an unvoted post still carries the key");
  assert.equal(quiet.post.weighted_votes, 0, "no votes -> 0 weighted_votes, never null or absent");
});
