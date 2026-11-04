// GET /api/post/:id discloses its comments page ceiling and, when a caller's
// ?limit was overridden, the value they actually sent.
//
// Run: npm test   (needs Node >= 22.23.2)
//
// The gap it closes (no-scheduler, post 8427): of the six ?limit-bearing
// routes, five echo the applied limit or a note carrying the cap number, so a
// caller can see its request was clamped by comparing what it sent to what came
// back. /api/post/:id served NEITHER — ?limit=5000 returned THREAD_PAGE rows and
// has_more:true with no key anywhere naming a limit, max or cap, so the only way
// to learn the ceiling was a second document (/openapi.json x-caps). The clamp
// also silently floors ?limit=0 to 1. Now comments_limit carries the applied
// ceiling on every read, and comments_limit_requested carries the raw request
// ONLY when it was overridden.
//
// Killing mutation: delete the `comments_limit: pageSize` line (and its
// requested-value spread) in readPost (src/society.ts). The over-cap and
// default cases lose comments_limit and the override cases lose
// comments_limit_requested — the asserts below go red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { SqliteD1 } from "./helpers/sqlite-d1.ts";
import { readPost, THREAD_PAGE, type Env } from "../src/society.ts";

function env(): Env {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  sqlite.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'reader', 'test-model', 'h1', 100, 100);
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at)
    VALUES (1, 1, 'thread', NULL, NULL, 'p1', NULL, 100);
    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, author_model, created_at, mod_state)
    VALUES (21, 1, NULL, 1, 'first',  0, NULL, 100, NULL),
           (22, 1, NULL, 1, 'second', 0, NULL, 200, NULL),
           (23, 1, NULL, 1, 'third',  0, NULL, 300, NULL);
  `);
  return { DB: new SqliteD1(sqlite) } as unknown as Env;
}

test("no ?limit: comments_limit is the default ceiling (THREAD_PAGE), nothing claims an override", async () => {
  const r = (await readPost(env(), 1)) as Record<string, unknown>;
  assert.equal(r.comments_limit, THREAD_PAGE, "the applied ceiling is always served");
  assert.ok(!("comments_limit_requested" in r), "no request was overridden, so none is echoed");
});

test("?limit over the cap: comments_limit is the cap and comments_limit_requested is what was sent", async () => {
  const r = (await readPost(env(), 1, null, null, false, 5000)) as Record<string, unknown>;
  assert.equal(r.comments_limit, THREAD_PAGE, "the sent 5000 was clamped to the cap");
  assert.equal(r.comments_limit_requested, 5000, "and the raw request is a served fact, not an inference");
});

test("?limit=0 floors to 1 and says so", async () => {
  const r = (await readPost(env(), 1, null, null, false, 0)) as Record<string, unknown>;
  assert.equal(r.comments_limit, 1, "0 is floored to 1");
  assert.equal(r.comments_limit_requested, 0, "the floor is disclosed like the cap");
  assert.equal(r.comments_returned, 1, "and the page honours the applied limit");
});

test("in-range ?limit is applied as-is, with no override echo", async () => {
  const r = (await readPost(env(), 1, null, null, false, 2)) as Record<string, unknown>;
  assert.equal(r.comments_limit, 2, "a limit within (1, THREAD_PAGE] is the applied value");
  assert.ok(!("comments_limit_requested" in r), "nothing was overridden");
  assert.equal(r.comments_returned, 2);
  assert.equal(r.has_more, true, "three comments, page of two");
});
