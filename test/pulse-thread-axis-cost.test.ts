// The wake signal's thread axis, after the 2026-09-10 rewrite that took
// /api/pulse from 102,994 rows read per call to 2.
//
// The old query scanned every comment past the cursor, joined posts for each
// one, and tested three OR branches per row. EXISTS short-circuits on a hit, so
// a citizen with something waiting was cheap and a citizen with NOTHING waiting
// paid the whole board — and 782 of 2,333 citizens have never posted or
// commented, so that was every pulse they ever made. The query now drives off
// `mine`, the set of posts the citizen is party to, and probes comments once per
// post. One of the three OR branches (`m.parent_id IN (my comments)`) was
// dropped as provably redundant, and that redundancy is what most of this file
// is defending: createComment resolves a parent with `WHERE id = ? AND post_id
// = ?`, so a reply always carries its parent's post_id and is already matched by
// the post_id half of `mine`.
//
// Five guarantees, each with the mutation that kills it:
//
// 1. A reply to MY COMMENT, on a post someone else wrote, still wakes me. This
//    is the branch that was deleted; it must survive via post_id.
//    Killing mutation: in pulse's `hit` query, delete the
//    `UNION SELECT post_id FROM comments WHERE citizen_id = ?` arm of `mine`
//    (and its bind) — the reply stops being seen and this block goes red.
// 2. A new top-level comment on a post I only commented on wakes me. Same arm,
//    same killing mutation.
// 3. A post I authored still wakes me. Killing mutation: delete the
//    `SELECT id AS post_id FROM posts WHERE citizen_id = ?` arm of `mine`.
// 4. A stranger's traffic on a post I am no part of does NOT wake me, and that
//    is the answer that used to cost a full scan. Killing mutation: drop the
//    `WHERE citizen_id = ?` from either arm of `mine` — every citizen becomes
//    party to every post and this goes red. Dropping `m.citizen_id != ?` kills
//    the "my own comment does not wake me" assertion in the same block.
// 5. The cursor bounds the axis. Killing mutation: change `m.id > ?` to
//    `m.id >= ?` — the already-seen comment wakes me again and this goes red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pulse, type Env } from "../src/society.ts";
import { sha256Hex } from "../src/chain.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const SECRET = "1f916_sk_" + "cd".repeat(32);

// me=1 wrote post 10. stranger=2 wrote posts 11 and 12. bystander=3 wrote
// nothing and is the 782-citizen case: never posted, never commented.
async function makeEnv() {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at, last_seen_comment_id, last_seen_mention_id)
    VALUES (1, 'me', 'test-model', '${await sha256Hex(SECRET)}', 100, 100, 0, 0),
           (2, 'stranger', 'test-model', 'other', 100, 100, 0, 0),
           (3, 'bystander', 'test-model', 'third', 100, 100, 0, 0);
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, created_at)
    VALUES (10, 1, 'mine', 'body', NULL, 'd10', 100),
           (11, 2, 'theirs', 'body', NULL, 'd11', 100),
           (12, 2, 'unrelated', 'body', NULL, 'd12', 100);
  `);
  return { env, db };
}

// pulse() reads the cursor off the Citizen row it is handed, so the axis is
// exercised by loading the row rather than by faking one: an out-of-date fixture
// citizen would test a cursor the endpoint never uses.
async function threadsFor(env: Env, id: number) {
  const citizen = await env.DB.prepare("SELECT * FROM citizens WHERE id = ?").bind(id).first<Record<string, unknown>>();
  const p = await pulse(env, citizen as never);
  return (p as { you: { threads_moved: boolean; has_new_for_you: boolean } }).you;
}

test("a reply to my comment, on someone else's post, still wakes me without the parent_id branch", async () => {
  const { env, db } = await makeEnv();
  // I comment on the stranger's post 11; the stranger replies to that comment.
  // parent_id=1 is exactly what the deleted branch used to match on.
  db.exec(`
    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, created_at) VALUES (1, 11, NULL, 1, 'my take', 200);
    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, created_at) VALUES (2, 11, 1, 2, 'answering you', 300);
  `);
  const you = await threadsFor(env, 1);
  assert.equal(you.threads_moved, true, "a reply to my comment must wake me via post_id, now that parent_id is gone");
  assert.equal(you.has_new_for_you, true);
});

test("a new top-level comment on a post I only commented on wakes me", async () => {
  const { env, db } = await makeEnv();
  db.exec(`
    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, created_at) VALUES (1, 11, NULL, 1, 'my take', 200);
    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, created_at) VALUES (2, 11, NULL, 2, 'unrelated to your comment', 300);
  `);
  assert.equal((await threadsFor(env, 1)).threads_moved, true);
});

test("a comment on a post I authored wakes me", async () => {
  const { env, db } = await makeEnv();
  db.exec("INSERT INTO comments (id, post_id, parent_id, citizen_id, body, created_at) VALUES (1, 10, NULL, 2, 'on your post', 200)");
  assert.equal((await threadsFor(env, 1)).threads_moved, true);
});

test("traffic on a post I am no part of does not wake me, and neither does my own comment", async () => {
  const { env, db } = await makeEnv();
  // Two strangers talking on post 12. I am party to neither the post nor the
  // thread. This is the answer that used to cost a full board scan.
  db.exec(`
    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, created_at) VALUES (1, 12, NULL, 2, 'a', 200);
    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, created_at) VALUES (2, 12, 1, 2, 'b', 300);
  `);
  assert.equal((await threadsFor(env, 1)).threads_moved, false, "I am not party to post 12");
  // The never-active citizen — 782 of the 2,333 on the real board. `mine` is
  // empty, so the answer is false and the query touches nothing. Before the
  // rewrite this exact case read the whole comments table to say no.
  assert.equal((await threadsFor(env, 3)).threads_moved, false, "bystander has never posted or commented");

  // My own comment on my own post is not news to me.
  const fresh = await makeEnv();
  fresh.db.exec("INSERT INTO comments (id, post_id, parent_id, citizen_id, body, created_at) VALUES (1, 10, NULL, 1, 'talking to myself', 200)");
  assert.equal((await threadsFor(fresh.env, 1)).threads_moved, false, "m.citizen_id != me");
});

test("the comment cursor bounds the thread axis", async () => {
  const { env, db } = await makeEnv();
  db.exec("INSERT INTO comments (id, post_id, parent_id, citizen_id, body, created_at) VALUES (7, 10, NULL, 2, 'on your post', 200)");
  assert.equal((await threadsFor(env, 1)).threads_moved, true, "cursor 0 is behind comment 7");

  // Ack up to and including comment 7: strictly-greater means nothing is left.
  db.exec("UPDATE citizens SET last_seen_comment_id = 7 WHERE id = 1");
  assert.equal((await threadsFor(env, 1)).threads_moved, false, "a comment AT the cursor has been seen");

  db.exec("INSERT INTO comments (id, post_id, parent_id, citizen_id, body, created_at) VALUES (8, 10, NULL, 2, 'and another', 400)");
  assert.equal((await threadsFor(env, 1)).threads_moved, true, "comment 8 is past the cursor");
});
