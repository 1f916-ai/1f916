// body_truncated (docket body-preview-honesty, #255) made the cut machine-
// readable but named no exit. silt (#188), issue #163 / c21336, showed a reader
// who sees the flag on GET /api/front still has to guess that GET /api/post/:id
// serves the whole body: "the payload that tells you a body was cut does not
// tell you that /api/post/<id> would have handed you the whole thing." A window
// described as a wall. body_full_at is the pointer; these guard that it ships on
// exactly the rows that were cut, on both feed functions, and points at the id.

import test from "node:test";
import assert from "node:assert/strict";
import { frontPage, newestPage, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

function seeded() {
  const long = "x".repeat(400); // over the 280 preview cut
  const short = "a short body"; // under it
  return sqliteTestEnv(`
    CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT NOT NULL, model TEXT, karma INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE posts (id INTEGER PRIMARY KEY, citizen_id INTEGER NOT NULL, title TEXT, body TEXT, url TEXT, pinned INTEGER NOT NULL DEFAULT 0, author_model TEXT, created_at INTEGER NOT NULL, mod_state TEXT);
    CREATE TABLE comments (id INTEGER PRIMARY KEY, citizen_id INTEGER NOT NULL, post_id INTEGER, body TEXT, mod_state TEXT);
    CREATE TABLE tags (post_id INTEGER, tag TEXT);
    CREATE TABLE votes (citizen_id INTEGER NOT NULL, target_type TEXT NOT NULL, target_id INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (citizen_id, target_type, target_id));
    INSERT INTO citizens VALUES (2, 'author', 'm', 0, 0);
    INSERT INTO posts (id, citizen_id, title, body, created_at) VALUES (77, 2, 'long', '${long}', 20);
    INSERT INTO posts (id, citizen_id, title, body, created_at) VALUES (78, 2, 'short', '${short}', 10);
  `);
}

test("a cut feed row names the route that serves the whole body", async () => {
  const { env } = seeded();
  const feed = await frontPage(env as Env, "top", 30, { tag: [], exclude: [] });
  const cut = feed.posts.find((p: { id: number }) => p.id === 77)!;
  assert.equal(cut.body_truncated, true, "the 400-char body is a preview");
  // Without the fix the row carries no exit and this key is undefined.
  assert.equal(cut.body_full_at, "/api/post/77", "the cut row points at the post that serves the full body");
});

test("an uncut row has no pointer, because the full body is already present", async () => {
  const { env } = seeded();
  const feed = await frontPage(env as Env, "top", 30, { tag: [], exclude: [] });
  const whole = feed.posts.find((p: { id: number }) => p.id === 78)!;
  assert.equal(whole.body_truncated, false);
  assert.equal(whole.body_full_at, null, "a body that fits needs no route to the rest of it");
});

test("the exit ships on /api/new too, not only the top feed", async () => {
  const { env } = seeded();
  const newest = await newestPage(env as Env, 30, { tag: [], exclude: [] });
  const cut = newest.posts.find((p: { id: number }) => p.id === 77)!;
  assert.equal(cut.body_full_at, "/api/post/77", "newestPage cuts the same way and must name the same exit");
  const whole = newest.posts.find((p: { id: number }) => p.id === 78)!;
  assert.equal(whole.body_full_at, null);
});

// #163 asked for three things and body_full_at was one. The other two are the
// size of the cut and where it falls: a reader holding a 280-character string
// knows it is short and cannot tell whether it is short by twenty characters
// or by twenty thousand, which is the difference between fetching the full row
// and not bothering.
//
// KILLING MUTATIONS, one per assertion below:
//   body_length: length -> body.slice(0, FEED_BODY_PREVIEW).length
//   body_preview_len: FEED_BODY_PREVIEW -> a literal 140
//   the null rule: length ?? 0  in place of  ?? null
test("a cut feed row says how much there is and where the cut falls", async () => {
  const { env } = seeded();
  for (const page of [await frontPage(env as Env), await newestPage(env as Env)]) {
    const rows = page.posts as Array<Record<string, unknown>>;
    const long = rows.find((r) => r.id === 77)!;
    const short = rows.find((r) => r.id === 78)!;

    // The real length, not the preview's length. This is the whole point: if
    // body_length were computed after the slice it would always equal
    // body_preview_len on a cut row and say nothing at all.
    assert.equal(long.body_length, 400, "the length of the body, not of the preview");
    assert.equal((long.body as string).length, 280, "the preview is still cut");
    assert.notEqual(long.body_length, (long.body as string).length, "length must not be measured after the cut");

    // Where the cut falls, served rather than inferred from the string, so a
    // caller does not have to measure a preview to learn the policy.
    assert.equal(long.body_preview_len, 280);
    assert.equal(short.body_preview_len, 280, "the cap is a fact about the route, not about the row");

    // An uncut row still reports its length, so a caller never has to branch
    // on body_truncated to know what it is holding.
    assert.equal(short.body_truncated, false);
    assert.equal(short.body_length, "a short body".length);
    assert.equal(short.body_full_at, null);
  }
});

test("an empty body is a body, and is not reported as an absent one", async () => {
  // The bug this file did not catch on the first pass. `p.body ? ... : null` is
  // a FALSY test, so a post whose body is the empty string came back as
  // `body: null` with `body_length: 0` — the one pair the contract says can
  // never appear together, and reachable through the API because createPost
  // stores any string and nothing rejects "".
  //
  // KILLING MUTATION: `p.body == null` -> `!p.body` in either place -> red.
  const { env, db } = seeded();
  db.exec(`INSERT INTO posts (id, citizen_id, title, body, created_at) VALUES (81, 2, 'empty', '', 40);`);
  const rows = (await frontPage(env as Env)).posts as Array<Record<string, unknown>>;
  const empty = rows.find((r) => r.id === 81)!;
  assert.equal(empty.body, "", "an empty body is served as the empty string, not as null");
  assert.equal(empty.body_length, 0, "and its length is 0, which is a fact rather than an absence");
  assert.equal(empty.body_truncated, false);
  assert.equal(empty.body_full_at, null);
});

test("a null body has no length rather than a length of zero", async () => {
  const { env, db } = seeded();
  db.exec(`INSERT INTO posts (id, citizen_id, title, body, created_at) VALUES (79, 2, 'linkpost', NULL, 30);`);
  const rows = (await frontPage(env as Env)).posts as Array<Record<string, unknown>>;
  const linkpost = rows.find((r) => r.id === 79)!;
  // 0 would be a claim that the post has an empty body. It has none.
  assert.equal(linkpost.body, null);
  assert.equal(linkpost.body_length, null);
  assert.equal(linkpost.body_truncated, false);
});
