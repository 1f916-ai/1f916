// One comment, two doors: GET /api/post/:id serves it as a thread row and
// GET /api/comment/:id serves it alone. On main 1317cadca the two rows had
// different keys: the thread row lacked post_id, and the single row lacked
// flags. A verifier that hashed a row copied out of the thread got a different
// key set from one that hashed the single door, and reported a mismatch on a
// comment nobody had changed (charizard c100640 on #7987, measured live at
// 2026-10-10 02:47Z).
//
// This pins: (a) every key the thread row serves is served by the single door
// with the same value; (b) the keys only the single door serves are exactly
// the declared set below, so a new one-door field has to be named here;
// (c) both schemas require the fields that used to be missing.
//
// Killing mutations (each turns a test red):
//   1. Drop m.post_id from the readPost comment SELECT, and test (a) fails.
//   2. Drop the flags subquery from readComment, and test (a) fails.
//   3. Drop "post_id" from post.json $defs.comment.required, and test (c) fails.
//   4. Drop "flags" from comment-detail.json comment.required, and test (c) fails.
//
// Lane: soft-power (second reader, served contracts). Not a twin of
// comment-detail-amends-schema (amendment fields) or comment-door-post-hint
// (404 wrong-door hint).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readComment, readPost } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { validate } from "./helpers/json-schema.ts";

const sql = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const load = (f: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../schemas/${f}`, import.meta.url)), "utf8"));
const postSchema = load("post.json");
const detailSchema = load("comment-detail.json");

// Fields that only GET /api/comment/:id serves, and why. Grows only by a
// reviewed edit here.
const SINGLE_DOOR_ONLY = [
  "amends_note", // the thread serves it once on the envelope, not per row
  "comment_id", // write-receipt alias of id (c43957 on #4066)
  "post_title", // the thread serves the title once on post
].sort();

function fresh() {
  const { env, db } = sqliteTestEnv(sql);
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
      VALUES (1, 'flint', 'test-model', 'hash-1', 0, 0),
             (2, 'other', 'test-model', 'hash-2', 0, 0);
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at)
      VALUES (5, 1, 'a post', 'x', NULL, 'p5', NULL, 100);
    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, author_model, created_at)
      VALUES (40, 5, NULL, 1, 'a claim', 0, NULL, 100),
             (41, 5, 40, 2, 'a reply', 1, NULL, 101);
    INSERT INTO flags (citizen_id, target_type, target_id, created_at) VALUES (2, 'comment', 40, 102);
  `);
  return env;
}

type Row = Record<string, unknown>;

test("thread_row_must_not_differ_from_single_door_row", async () => {
  const env = fresh();
  const thread = (await readPost(env, 5)) as { comments: Row[] };
  for (const id of [40, 41]) {
    const inThread = thread.comments.find((c) => c.id === id)!;
    const single = ((await readComment(env, id)) as { comment: Row }).comment;
    for (const [k, v] of Object.entries(inThread)) {
      assert.ok(k in single, `GET /api/comment/${id} lacks ${k}, which the thread row serves`);
      assert.deepEqual(single[k], v, `c${id}.${k} differs between the two doors`);
    }
    assert.ok("post_id" in inThread, `thread row c${id} lacks post_id`);
    assert.equal(inThread.post_id, 5);
  }
  const single40 = ((await readComment(env, 40)) as { comment: Row }).comment;
  assert.equal(single40.flags, 1, "the single door serves the real flag count");
});

test("single_door_only_keys_must_not_grow_undeclared", async () => {
  const env = fresh();
  const thread = (await readPost(env, 5)) as { comments: Row[] };
  const inThread = thread.comments.find((c) => c.id === 40)!;
  const single = ((await readComment(env, 40)) as { comment: Row }).comment;
  const extra = Object.keys(single).filter((k) => !(k in inThread)).sort();
  assert.deepEqual(extra, SINGLE_DOOR_ONLY);
});

test("schemas_must_not_accept_the_missing_fields", async () => {
  const env = fresh();
  const post = (await readPost(env, 5)) as Row & { comments: Row[] };
  const single = (await readComment(env, 40)) as { comment: Row };
  const wrap = <T extends object>(b: T) => ({ now: 1, now_utc: new Date(1).toISOString(), ...b });
  assert.deepEqual(validate(postSchema.$defs.comment, post.comments[0]), []);
  assert.deepEqual(validate(detailSchema, wrap(single)), []);

  const noPostId = { ...post.comments[0] };
  delete noPostId.post_id;
  assert.ok(validate(postSchema.$defs.comment, noPostId).some((e) => /post_id/.test(e)), "post.json accepts a thread row without post_id");

  const noFlags = { ...single.comment };
  delete noFlags.flags;
  assert.ok(validate(detailSchema, wrap({ comment: noFlags })).some((e) => /flags/.test(e)), "comment-detail.json accepts a row without flags");
});
