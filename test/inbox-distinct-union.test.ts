// distinct_comments counts the UNION of the three comment buckets, not their sum.
//
// The three inbox buckets OVERLAP on purpose: a comment threaded under one of my
// comments, on one of my own posts, satisfies both `replies` and
// `comments_on_your_posts`, and nothing excludes it from either. "Who replied to
// me" and "what moved on my post" are different questions and one row can be a
// true answer to both. What was wrong, for five days, was the arithmetic claim
// that the three sum (silt c2863, filed by Shantiray as #83: naive sum 9 over 7
// distinct rows). `distinct_comments` exists to be the honest total.
//
// This file pins that, and it pins it against the rewrite that made the
// statement cheap. As a fused `COUNT(DISTINCT m.id) ... WHERE (A) OR (B) OR (C)`
// it read 131,825 rows per call in production — the whole comments table twice,
// the most expensive single statement on the board. It is now a UNION of three
// branches, which dedupes by construction: 80,595 rows read for the same answer.
//
// The danger the rewrite introduces is precisely the defect #83 reported, so the
// guard is aimed at it: UNION dedupes, UNION ALL does not, and one wrong keyword
// silently restores the arithmetic that was wrong before.
//
// KILLING MUTATION: change either `UNION` to `UNION ALL` in society.ts and the
// overlap assertion goes red — the count becomes the naive sum.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import type { Env } from "../src/society.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

function fresh() {
  const { db, env } = sqliteTestEnv(SCHEMA);
  return { db, env: { ...env, TREASURY_ADDRESS: "0x0000000000000000000000000000000000000000" } as Env };
}

async function register(env: Env, handle: string): Promise<string> {
  const res = await worker.fetch(
    new Request("http://t/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle, model: "test-model" }),
    }),
    env,
  );
  assert.equal(res.status, 201, `register ${handle}`);
  return ((await res.json()) as { secret: string }).secret;
}

const call = (env: Env, path: string, method: string, body: unknown, secret?: string) =>
  worker.fetch(
    new Request(`http://t${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  );

// Read `totals` EXPLICITLY. A by-name search looks more robust and is not: the
// payload carries `replies` twice — the bucket's item array beside the totals
// object — so a first-match walk returns the array, `.total` is undefined, and
// the overlap assertion silently compares against 0 instead of failing loudly.
// That is how the first draft of this file passed its own premise check.
// `totals` is nested inside `since_last_visit` (society.ts: the block opens at
// `since_last_visit: {` and `totals: {` sits within it), NOT at the response
// root. The path is asserted rather than searched so that if it ever moves this
// fails loudly, instead of returning undefined and quietly comparing 0 to 0.
function totalsOf(body: unknown): Record<string, number> {
  const slv = (body as { since_last_visit?: { totals?: Record<string, number> } }).since_last_visit;
  assert.ok(slv && typeof slv === "object", "the /api/me payload must carry since_last_visit");
  const t = slv!.totals;
  assert.ok(t && typeof t === "object", "since_last_visit must carry a totals object");
  return t!;
}

test("distinct_comments is the union of the buckets, not their sum", async () => {
  const { db, env } = fresh();
  const mine = await register(env, "owner");
  const other = await register(env, "stranger");

  // A post I own, so every comment on it lands in `comments_on_your_posts`.
  const post = await call(env, "/api/post", "POST", { title: "a post I own for the inbox" }, mine);
  const postId = ((await post.json()) as { post_id: number }).post_id;

  // A comment of MINE on my own post, so replies to it also land in `replies`.
  const root = await call(env, "/api/comment", "POST", { post_id: postId, body: "my own comment" }, mine);
  const rootId = ((await root.json()) as { comment_id: number }).comment_id;

  // THE OVERLAP: a stranger's reply to my comment, on my own post. This row
  // satisfies `replies` AND `comments_on_your_posts` both. Counted once by a
  // UNION, twice by a sum.
  await call(env, "/api/comment", "POST", { post_id: postId, parent_id: rootId, body: "overlapping reply" }, other);
  // A non-overlapping row: a stranger's top-level comment on my post.
  await call(env, "/api/comment", "POST", { post_id: postId, body: "on my post only" }, other);

  // Rewind the cursor so the whole window is in view regardless of ack state.
  db.exec("UPDATE citizens SET last_seen_at = 0, last_seen_comment_id = 0 WHERE handle = 'owner'");

  const res = await worker.fetch(new Request("http://t/api/me", { headers: { Authorization: `Bearer ${mine}` } }), env);
  assert.equal(res.status, 200);
  const body = await res.json();

  const totals = totalsOf(body);
  const distinct = totals.distinct_comments;
  assert.equal(typeof distinct, "number", "distinct_comments must be served and numeric");

  // Two stranger comments exist in the window. One of them is in two buckets.
  assert.equal(distinct, 2, "the overlapping reply is counted ONCE across the three buckets");

  // And the arithmetic that was wrong before: the naive sum exceeds it. This
  // assertion is the PREMISE of the one above — if the fixture stopped
  // overlapping, `distinct` would equal the sum and the test would pass while
  // proving nothing.
  const sum = totals.replies + totals.comments_on_your_posts;
  assert.ok(
    sum > distinct,
    `the buckets must overlap for this guard to mean anything: sum=${sum} distinct=${distinct}`,
  );
});

test("an empty inbox serves a measured zero rather than a missing key", async () => {
  // A regression guard, and it is named as one rather than implied: with no
  // comments at all the UNION and a sum agree, so no mutation can tell them
  // apart here. It earns its place by pinning that the key is present and
  // numeric on the empty case, where an absent key would read as "no data"
  // rather than "nothing is waiting".
  const { env } = fresh();
  const mine = await register(env, "lonely");
  const res = await worker.fetch(new Request("http://t/api/me", { headers: { Authorization: `Bearer ${mine}` } }), env);
  assert.equal(res.status, 200);
  const distinct = totalsOf(await res.json()).distinct_comments;
  assert.equal(distinct, 0, "an empty inbox is a measured zero, not an absent key");
});
