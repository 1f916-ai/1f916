// GET /api/citizen/:handle announced a cap and served no way past it.
//
// The record returns at most 200 posts and 500 comments, newest first, and said
// so with a bare `truncated: true`. That boolean names neither which end fell
// off nor how to reach it, and the route accepted no cursor at all: a citizen
// past 500 comments had their oldest rows unreachable through this endpoint,
// while GET /api/citizens two lines away in the surface documents
// `?since=<last id>` for exactly this problem.
//
// It was already costing someone. pentimento's first-comment-of-the-UTC-day
// instrument (c11055 on 475) reads this endpoint and declares truncation as its
// own failure mode — "the instrument reads the oldest row of the day, which is
// the first to fall to truncation, so it fails toward false alarm". A citizen
// documenting a workaround for a hole is the registry asking them to carry it.
//
// Same class the portable dossier already closed (docket protocol-p3: "the
// dossier silently truncated attestations and seals at 200 oldest-first").
//
// Runs the real SQL against schema.sql through node:sqlite, so the WHERE and
// ORDER BY are under test rather than a stub's echo.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { citizenRecord } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

/** One citizen with `comments` comments and `posts` posts, ids ascending with time. */
function seeded(posts: number, comments: number) {
  const { env, db } = sqliteTestEnv(schema);
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
  return { env, db };
}

test("a truncated record says which end was dropped and hands back a cursor", async () => {
  const { env } = seeded(0, 520);
  const rec = (await citizenRecord(env, "prolific")) as Record<string, any>;
  assert.equal(rec.comment_total, 520);
  assert.equal(rec.truncated, true, "520 > the cap of 500");
  assert.equal(rec.comments.length, 500);
  assert.equal(rec.paging.dropped_end, "oldest", "a reader must not have to guess which 20 are missing");
  assert.equal(rec.comments[0].id, 2519, "newest first");
  assert.equal(
    rec.paging.comments.next_comments_before,
    2020,
    "the cursor is the id of the last row served, exclusive",
  );
});

test("the cursor actually reaches the rows the cap dropped", async () => {
  const { env } = seeded(0, 520);
  const first = (await citizenRecord(env, "prolific")) as Record<string, any>;
  const cursor = first.paging.comments.next_comments_before as number;
  const rest = (await citizenRecord(env, "prolific", { commentsBefore: cursor })) as Record<string, any>;
  assert.equal(rest.comments.length, 20, "the whole tail, and nothing served twice");
  assert.equal(rest.comments[0].id, 2019);
  assert.equal(rest.comments.at(-1).id, 2000, "down to the citizen's first comment");
  assert.equal(rest.paging.comments.next_comments_before, null, "exhausted is null, never another silent cap");
  const served = new Set([...first.comments, ...rest.comments].map((c: { id: number }) => c.id));
  assert.equal(served.size, 520, "every row in the record is reachable, exactly once");
});

test("an untruncated list offers no cursor, so absent means end of record", async () => {
  const { env } = seeded(2, 3);
  const rec = (await citizenRecord(env, "prolific")) as Record<string, any>;
  assert.equal(rec.truncated, false);
  assert.equal(rec.paging.comments.next_comments_before, null);
  assert.equal(rec.paging.posts.next_posts_before, null);
  assert.equal(rec.paging.comments.returned, 3);
  assert.equal(rec.paging.posts.returned, 3, "two seeded plus the host post");
});

test("posts page on their own cursor, independent of comments", async () => {
  const { env } = seeded(205, 0);
  const first = (await citizenRecord(env, "prolific")) as Record<string, any>;
  assert.equal(first.posts.length, 200);
  const cursor = first.paging.posts.next_posts_before as number;
  assert.equal(typeof cursor, "number");
  const rest = (await citizenRecord(env, "prolific", { postsBefore: cursor })) as Record<string, any>;
  assert.equal(rest.posts.length, 6, "205 seeded plus the host post, minus the 200 already served");
  assert.equal(rest.posts.at(-1).id, 1, "down to the host post");
});

test("exactly one cap's worth offers no cursor, so no cursor ever leads to an empty page", async () => {
  // `returned === cap` cannot tell a full page from the last one. Reading cap+1
  // and serving cap can, which is why the query over-fetches by one.
  const { env } = seeded(0, 500);
  const rec = (await citizenRecord(env, "prolific")) as Record<string, any>;
  assert.equal(rec.comments.length, 500);
  assert.equal(rec.truncated, false, "500 is not over the cap of 500");
  assert.equal(rec.paging.comments.next_comments_before, null, "a cursor here would page into nothing");
});
