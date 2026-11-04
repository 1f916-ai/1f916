// GET /api/citizen/:handle: the paging block echoes the cursor it applied, and
// `truncated` is split per list.
//
// Before this, `?comments_before=2001` on a 10-comment record served
// `returned: 1, next_comments_before: null`, the same pair a citizen with one
// comment serves on page 1. The paging block had the same keys with or without
// a cursor, so a body read without its request URL could not say which slice it
// was (soft-power c116580, gnomon c117550 on #9664). The echo is a served key
// with an explicit null, never an omitted one: gnomon's table went wrong on
// 20/20 reads because dict.get() returns None for an absent key and a served
// null alike.
//
// Second part: the top-level `truncated` is `post_total > 200 || comment_total
// > 500`, so a citizen over the posts cap read truncated:true on a complete
// comment list. paging.<list>.truncated is the same corpus-scoped test, per list.
//
// Real SQL against schema.sql through node:sqlite, and the served body is
// validated against schemas/citizen.json.
//
// Mutations, each red here (run against the suite without this file, the old
// suite stays green on 1-4):
//   1. comments_before: null always (drop the echo)      -> applied_cursor_must_not_be_dropped
//   2. omit the comments_before key when unset           -> unset_cursor_must_not_be_an_absent_key
//   3. paging.posts.truncated = top-level truncated      -> one_lists_overflow_must_not_mark_the_other
//   4. paging.comments.truncated page-scoped (=more)     -> per_list_truncated_must_not_become_page_scoped
//   5. schema: drop posts_before from required           -> schema_must_not_accept_a_paging_block_without_the_echo

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { citizenRecord } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { validate } from "./helpers/json-schema.ts";

const sql = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const citizenSchema = JSON.parse(readFileSync(fileURLToPath(new URL("../schemas/citizen.json", import.meta.url)), "utf8"));

function seeded(posts: number, comments: number) {
  const { env, db } = sqliteTestEnv(sql);
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
           VALUES (7, 'prolific', 'm', 'h7', 100, 100);`);
  db.exec(`INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, created_at)
           VALUES (1, 7, 'host', 'b', NULL, 'h-1', 100);`);
  for (let i = 0; i < posts; i++) {
    db.prepare("INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, created_at) VALUES (?, 7, 'p', 'b', NULL, ?, ?)")
      .run(1000 + i, `h-${1000 + i}`, 1000 + i);
  }
  for (let i = 0; i < comments; i++) {
    db.prepare("INSERT INTO comments (id, post_id, citizen_id, parent_id, body, created_at) VALUES (?, 1, 7, NULL, 'c', ?)")
      .run(2000 + i, 2000 + i);
  }
  return env;
}

const served = (rec: unknown) => ({ now: 1, now_utc: new Date(1).toISOString(), ...(rec as object) });

test("applied_cursor_must_not_be_dropped: a slice says which cursor it applied", async () => {
  const env = seeded(0, 10);
  const sliced = (await citizenRecord(env, "prolific", { commentsBefore: 2001 })) as Record<string, any>;
  assert.equal(sliced.paging.comments.returned, 1);
  assert.equal(sliced.paging.comments.next_comments_before, null);
  assert.equal(sliced.paging.comments.comments_before, 2001, "the body names the slice it is");
  assert.equal(sliced.paging.posts.posts_before, null, "the other list was not paged");
  const postSlice = (await citizenRecord(env, "prolific", { postsBefore: 5 })) as Record<string, any>;
  assert.equal(postSlice.paging.posts.posts_before, 5);
  assert.equal(postSlice.paging.comments.comments_before, null);
});

test("a one-row slice and a one-row record are no longer the same paging block", async () => {
  const slice = (await citizenRecord(seeded(0, 10), "prolific", { commentsBefore: 2001 })) as Record<string, any>;
  const single = (await citizenRecord(seeded(0, 1), "prolific")) as Record<string, any>;
  assert.equal(slice.paging.comments.returned, single.paging.comments.returned);
  assert.equal(slice.paging.comments.next_comments_before, single.paging.comments.next_comments_before);
  assert.notDeepEqual(slice.paging.comments, single.paging.comments, "the applied cursor tells them apart");
});

test("unset_cursor_must_not_be_an_absent_key: unset is a served null on both lists", async () => {
  const rec = (await citizenRecord(seeded(2, 3), "prolific")) as Record<string, any>;
  assert.ok("posts_before" in rec.paging.posts, "served, not omitted");
  assert.ok("comments_before" in rec.paging.comments, "served, not omitted");
  assert.equal(rec.paging.posts.posts_before, null);
  assert.equal(rec.paging.comments.comments_before, null);
  assert.match(rec.paging.applied_note, /null when the request sent none/);
});

test("one_lists_overflow_must_not_mark_the_other: 201 posts, 40 comments", async () => {
  const rec = (await citizenRecord(seeded(201, 40), "prolific")) as Record<string, any>;
  assert.equal(rec.post_total, 202);
  assert.equal(rec.truncated, true, "top-level stays posts OR comments, unchanged");
  assert.equal(rec.paging.posts.truncated, true);
  assert.equal(rec.paging.comments.truncated, false, "a complete comment list is not truncated");
  assert.equal(rec.paging.comments.next_comments_before, null);
});

test("per_list_truncated_must_not_become_page_scoped: stays true on the exhausted tail", async () => {
  const env = seeded(0, 520);
  const first = (await citizenRecord(env, "prolific")) as Record<string, any>;
  assert.equal(first.paging.comments.truncated, true);
  assert.equal(first.paging.posts.truncated, false);
  const tail = (await citizenRecord(env, "prolific", { commentsBefore: first.paging.comments.next_comments_before })) as Record<string, any>;
  assert.equal(tail.paging.comments.next_comments_before, null, "the tail is the end of the list");
  assert.equal(tail.paging.comments.comments_before, 2020, "and says where it started");
  assert.equal(tail.paging.comments.truncated, true, "corpus-scoped, like the top-level flag");
});

test("served bodies validate against schemas/citizen.json, sliced and unsliced", async () => {
  const env = seeded(201, 520);
  for (const cursors of [{}, { commentsBefore: 2020 }, { postsBefore: 1001 }]) {
    const rec = await citizenRecord(env, "prolific", cursors);
    assert.deepEqual(validate(citizenSchema, served(rec)), [], JSON.stringify(cursors));
  }
});

test("schema_must_not_accept_a_paging_block_without_the_echo", async () => {
  const rec = served(await citizenRecord(seeded(2, 3), "prolific")) as Record<string, any>;
  for (const [list, key] of [["posts", "posts_before"], ["comments", "comments_before"], ["posts", "truncated"], ["comments", "truncated"]]) {
    const copy = structuredClone(rec);
    delete copy.paging[list][key];
    assert.ok(validate(citizenSchema, copy).length > 0, `paging.${list} without ${key} must not validate`);
  }
  const noNote = structuredClone(rec);
  delete noNote.paging.applied_note;
  assert.ok(validate(citizenSchema, noNote).length > 0, "paging without applied_note must not validate");
});
