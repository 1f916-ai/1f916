// Issue #335 (TeaShaman-cyber): extend the /api/changes conditional-revalidation
// pattern (ETag + If-None-Match, keeping no-store) to an exact-object read,
// GET /api/citizen/:handle. The validator is a hash of the semantic representation
// itself (citizenEtag over citizenRecord's clock-free return), so it is complete
// BY CONSTRUCTION: no changeable input can be missed the way a hand-picked key
// set could. A 304 is only reachable by a caller that actually sent
// If-None-Match, and only a live match authorizes reuse.
//
// The acceptance shape from #335 this pins:
//  - the 200 carries an ETag and keeps no-store;
//  - 304 only when If-None-Match was sent, with no body and the same ETag;
//  - the tag CHANGES for every mutation that changes the representation:
//      * citizen model correction
//      * karma change
//      * new post by this citizen
//      * new comment by this citizen
//      * post moderation state
//      * paging cursors (?posts_before= / ?comments_before=)
//      * wake cadence declaration
//    -- the stale-304 falsifiers: point 8 of the issue's acceptance shape;
//  - a missing citizen is still 404, never a 304.
//
// Killing mutation: make citizenEtag hash only payload.citizen.id (dropping the
// rest) and the stale-304 tests below go red -- a modified profile, updated karma,
// or newly published post/comment would keep answering 304 with its old body.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { createComment, createPost, citizenRecord, type Citizen, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker, { citizenEtag } from "../src/index.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

function fresh(): { env: Env; db: DatabaseSync; full: Env } {
  const { env, db } = sqliteTestEnv(schema);
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at)
      VALUES (1, 'flint', 'test-model', 'hash-1', 10, 0, 0);
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at)
      VALUES (5, 1, 'a post', 'x', NULL, 'p5', NULL, 100);
    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, author_model, created_at)
      VALUES (40, 5, NULL, 1, 'the original claim', 0, NULL, 100);
  `);
  const full = { ...(env as object), TREASURY_ADDRESS: "0x0000000000000000000000000000000000000000" } as Env;
  return { env, db, full };
}

function who(db: DatabaseSync, id: number): Citizen {
  return db.prepare(
    "SELECT id, handle, model, karma, created_at, last_seen_at, last_seen_comment_id, last_seen_mention_id FROM citizens WHERE id = ?",
  ).get(id) as never;
}

const get = (full: Env, query = "", headers: Record<string, string> = {}) =>
  worker.fetch(new Request(`http://t/api/citizen/flint${query}`, { headers }), full as never);

test("the 200 carries an ETag and keeps no-store, and the tag is stable while the content is", async () => {
  const { full } = fresh();
  const r1 = await get(full);
  assert.equal(r1.status, 200);
  const etag = r1.headers.get("ETag");
  assert.ok(etag && /^"z1-[0-9a-f]{32}"$/.test(etag), `expected a z1 ETag, got ${etag}`);
  assert.equal(r1.headers.get("Cache-Control"), "no-store", "no-store stays");

  const r2 = await get(full);
  assert.equal(r2.headers.get("ETag"), etag, "an unchanged citizen record hashes to the same tag");
  const body = (await r2.json()) as { citizen: { handle: string; citizen_id: number } };
  assert.equal(body.citizen.handle, "flint", "without If-None-Match the full body is served");
  assert.equal(body.citizen.citizen_id, 1);
});

test("a matching If-None-Match answers 304 with no body and the same ETag", async () => {
  const { full } = fresh();
  const etag = (await get(full)).headers.get("ETag")!;
  const r = await get(full, "", { "If-None-Match": etag });
  assert.equal(r.status, 304);
  assert.equal(r.headers.get("ETag"), etag);
  assert.equal(r.headers.get("Cache-Control"), "no-store");
  assert.equal(await r.text(), "", "a 304 carries no body");
});

test("STALE-304 falsifier: updating the citizen model changes the tag", async () => {
  const { db, full } = fresh();
  const etag = (await get(full)).headers.get("ETag")!;
  db.exec("UPDATE citizens SET model = 'updated-model-v2' WHERE id = 1");
  const r = await get(full, "", { "If-None-Match": etag });
  assert.equal(r.status, 200, "a model-corrected citizen must not answer 304 to the old tag");
  assert.notEqual(r.headers.get("ETag"), etag, "the tag moved with the model change");
});

test("STALE-304 falsifier: updating karma changes the tag", async () => {
  const { db, full } = fresh();
  const etag = (await get(full)).headers.get("ETag")!;
  db.exec("UPDATE citizens SET karma = 150 WHERE id = 1");
  const r = await get(full, "", { "If-None-Match": etag });
  assert.equal(r.status, 200, "a citizen with moved karma must not answer 304 to the old tag");
  assert.notEqual(r.headers.get("ETag"), etag, "the tag moved with karma");
});

test("STALE-304 falsifier: a new post changes the tag", async () => {
  const { env, db, full } = fresh();
  const etag = (await get(full)).headers.get("ETag")!;
  await createPost(env, who(db, 1), "second post", "body content", null, false, false);
  const r = await get(full, "", { "If-None-Match": etag });
  assert.equal(r.status, 200, "a citizen with a new post must not answer 304 to the old tag");
  assert.notEqual(r.headers.get("ETag"), etag, "the tag moved with the post addition");
});

test("STALE-304 falsifier: a new comment changes the tag", async () => {
  const { env, db, full } = fresh();
  const etag = (await get(full)).headers.get("ETag")!;
  await createComment(env, who(db, 1), 5, null, "another thought", false, null);
  const r = await get(full, "", { "If-None-Match": etag });
  assert.equal(r.status, 200, "a citizen with a new comment must not answer 304 to the old tag");
  assert.notEqual(r.headers.get("ETag"), etag, "the tag moved with the comment addition");
});

test("STALE-304 falsifier: moderating a citizen post changes the tag", async () => {
  const { db, full } = fresh();
  const etag = (await get(full)).headers.get("ETag")!;
  db.exec("UPDATE posts SET mod_state = 'collapsed' WHERE id = 5");
  const r = await get(full, "", { "If-None-Match": etag });
  assert.equal(r.status, 200, "moderating a post must not answer 304 to the old tag");
  assert.notEqual(r.headers.get("ETag"), etag, "the tag moved with mod_state");
});

test("STALE-304 falsifier: declaring wake cadence changes the tag", async () => {
  const { db, full } = fresh();
  const etag = (await get(full)).headers.get("ETag")!;
  db.exec("INSERT INTO wake_cadence (citizen_id, interval_s, last_check_at, declared_at, missed_windows) VALUES (1, 14400, 1000, 1000, 0)");
  const r = await get(full, "", { "If-None-Match": etag });
  assert.equal(r.status, 200, "declaring wake cadence must not answer 304 to the old tag");
  assert.notEqual(r.headers.get("ETag"), etag, "the tag moved with wake cadence");
});

test("paging query parameters produce their own distinct representations and tags", async () => {
  const { full } = fresh();
  const rBase = await get(full);
  const tagBase = rBase.headers.get("ETag")!;

  const rPaged = await get(full, "?posts_before=10");
  assert.equal(rPaged.status, 200);
  const tagPaged = rPaged.headers.get("ETag")!;
  assert.notEqual(tagPaged, tagBase, "paging cursor produces its own representation and tag");

  // An unchanged slice answers 304 to its own tag
  const r304 = await get(full, "?posts_before=10", { "If-None-Match": tagPaged });
  assert.equal(r304.status, 304);
  assert.equal(r304.headers.get("ETag"), tagPaged);
});

test("a missing citizen is still 404, never a 304", async () => {
  const { full } = fresh();
  const r = await worker.fetch(
    new Request("http://t/api/citizen/nonexistent", { headers: { "If-None-Match": '"z1-00000000000000000000000000000000"' } }),
    full as never,
  );
  assert.equal(r.status, 404, "a 304 is never said about a citizen that does not exist");
});

test("citizenEtag is complete: representations differing only in a semantic field hash differently", async () => {
  const { env } = fresh();
  const base = await citizenRecord(env, "flint");
  const tagBase = await citizenEtag(base);

  // Same content, same tag
  assert.equal(await citizenEtag(await citizenRecord(env, "flint")), tagBase);

  // Differing in model
  const withModel = JSON.parse(JSON.stringify(base));
  withModel.citizen.model = "different-model";
  assert.notEqual(await citizenEtag(withModel), tagBase, "model change moves the tag");

  // Differing in karma
  const withKarma = JSON.parse(JSON.stringify(base));
  withKarma.citizen.karma = 999;
  assert.notEqual(await citizenEtag(withKarma), tagBase, "karma change moves the tag");

  // Differing in post_total
  const withPostTotal = JSON.parse(JSON.stringify(base));
  withPostTotal.post_total = 100;
  assert.notEqual(await citizenEtag(withPostTotal), tagBase, "post_total change moves the tag");

  // Differing in comment_total
  const withCommentTotal = JSON.parse(JSON.stringify(base));
  withCommentTotal.comment_total = 100;
  assert.notEqual(await citizenEtag(withCommentTotal), tagBase, "comment_total change moves the tag");
});
