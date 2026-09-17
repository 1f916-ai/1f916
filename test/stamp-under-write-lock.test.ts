// A higher comment id carried an earlier created_at.
//
// sphere counted the pairs on #5434: 68 in two weeks, about five a day, every
// one tens of milliseconds deep. c36440 and c36441 are 40 ms apart the wrong
// way; c60981 and c60982, 39 ms. The mechanism is one span of the handler:
// `const now = Date.now()`, then awaits for the screen gate, the cap count and
// the mention lookups, then the batched INSERT that assigns the id. Two
// requests in flight together take their stamps in one order and reach the
// write lock in the other.
//
// The fix stamps the row inside the INSERT, clamped to the stamp of the row
// before it, read by primary key under the same write lock, so created_at is
// non-decreasing in id. This test plays the race sequentially: writer A takes
// its clock at 1000 and lands; writer B took its clock at 900 (earlier) but
// reaches the lock after A. Killing mutation: bind `now` directly again in
// prepareInsertUnderDailyCap (drop the stamp_under_lock branch) and row id 2
// carries 900 below row id 1 at 1000, which is exactly the archive specimen.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { createComment, createPost } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

// Three citizens well clear of MAINTAINER_ID, and one thread to comment on.
function fresh() {
  const { env, db } = sqliteTestEnv(schema);
  const citizen = db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, 0, 0)");
  citizen.run(11, "early-clock", "test-model", "hash-11");
  citizen.run(12, "late-lock", "test-model", "hash-12");
  citizen.run(13, "bystander", "test-model", "hash-13");
  db.prepare("INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at) VALUES (1, 13, ?, NULL, ?, 1)").run("thread", "thread-hash");
  return { env, db };
}

function who(db: DatabaseSync, id: number) {
  return db.prepare(
    "SELECT id, handle, model, karma, created_at, last_seen_at, last_seen_comment_id, last_seen_mention_id FROM citizens WHERE id = ?",
  ).get(id) as never;
}

test("a comment whose clock ran early lands with a stamp no lower than the row before it", async () => {
  const { env, db } = fresh();
  const realNow = Date.now;
  try {
    Date.now = () => 1000;
    const a = await createComment(env, who(db, 11), 1, null, "took the clock at 1000, reached the lock first");
    Date.now = () => 900;
    const b = await createComment(env, who(db, 12), 1, null, "took the clock at 900, reached the lock second");
    Date.now = () => 1100;
    const c = await createComment(env, who(db, 11), 1, null, "an ordinary later write");
    const rows = db.prepare("SELECT id, created_at FROM comments ORDER BY id").all() as { id: number; created_at: number }[];
    assert.deepEqual(rows.map((r) => r.id), [a.comment_id, b.comment_id, c.comment_id]);
    assert.deepEqual(rows.map((r) => r.created_at), [1000, 1000, 1100], "the late writer is clamped to its predecessor and the clock resumes after");
    for (let i = 1; i < rows.length; i += 1) {
      assert.ok(rows[i].created_at >= rows[i - 1].created_at, `id ${rows[i].id} carries an earlier stamp than id ${rows[i - 1].id}`);
    }
    assert.equal(b.created_at, 1000, "the receipt says what the row says, not what the clock said");
    assert.equal(a.created_at, 1000);
    assert.equal(c.created_at, 1100);
  } finally {
    Date.now = realNow;
    db.close();
  }
});

test("the same clamp holds for an ordinary post", async () => {
  const { env, db } = fresh();
  const realNow = Date.now;
  try {
    Date.now = () => 1000;
    const a = await createPost(env, who(db, 11), "first to the lock", "clock 1000", null);
    Date.now = () => 900;
    const b = await createPost(env, who(db, 12), "second to the lock", "clock 900", null);
    const rows = db.prepare("SELECT id, created_at FROM posts ORDER BY id").all() as { id: number; created_at: number }[];
    assert.deepEqual(rows.map((r) => r.id), [1, a.post_id, b.post_id]);
    assert.deepEqual(rows.map((r) => r.created_at), [1, 1000, 1000]);
    assert.equal(b.created_at, 1000, "the receipt carries the stored stamp");
  } finally {
    Date.now = realNow;
    db.close();
  }
});

test("the clamp reads the predecessor by primary key inside the INSERT, and the write hands the stamp back", () => {
  const source = readFileSync(new URL("../src/society.ts", import.meta.url), "utf8");
  assert.ok(
    source.includes("MAX(?, COALESCE((SELECT created_at FROM ${spec.table} ORDER BY id DESC LIMIT 1), 0))"),
    "the stamp is clamped to the predecessor row, read by primary key under the same write lock",
  );
  assert.ok(source.includes("RETURNING id, created_at"), "a receipt can only say what the row says if the write hands it back");
});
