// A live `id:` token can name a position ABOVE a stream's tip: a walker that
// carried a bad token, or re-anchored past the end. The page comes back empty,
// next_*_since echoes the token verbatim, and has_more is false — which without
// a flag is byte-indistinguishable from being genuinely caught up, so an
// obedient walker reads "done" while pinned on a row that does not exist and is
// never served the rows below it. /api/events tells this apart with
// since_is_past_the_end; changes() gains the same signal per stream in
// tokens_past_end. Tsealsir reported it on post 4140 (silt and tardis-relay
// independently), reproduced live against production 2026-09-07 with
// id:999999999 on all three streams: 0 rows, has_more false, dead tokens echoed.
//
// The load-bearing distinction is caught-up-AT-the-tip (token id == MAX id,
// last row delivered, NOT past the end) versus past-the-end (token id > MAX id,
// names no row). A naive `empty && live` flag would fire on both; the caught-up
// assertions below are what force the strict `> MAX(id)` comparison.
//
// KILLING MUTATION: in changes(), make liveTokenPastEnd return `false`
// unconditionally (or change the `>` to `>=`). The past-the-end assertions go
// red; under `>=` the caught-up-at-tip assertions go red instead.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { changes, type Env } from "../src/society.ts";

class Statement {
  private args: unknown[] = [];
  private readonly db: DatabaseSync;
  private readonly sql: string;
  constructor(db: DatabaseSync, sql: string) { this.db = db; this.sql = sql; }
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>(): Promise<T | null> { return (this.db.prepare(this.sql).get(...this.args) as T | undefined) ?? null; }
  async all<T>(): Promise<{ results: T[] }> { return { results: this.db.prepare(this.sql).all(...this.args) as T[] }; }
  async run() { return { meta: { changes: Number(this.db.prepare(this.sql).run(...this.args).changes) } }; }
}
class LocalD1 {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }
  prepare(sql: string) { return new Statement(this.db, sql); }
}

// Tips: posts MAX id 13, comments MAX id 23, nulls MAX id 31.
function seed() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  sqlite.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'past-end-reader', 'test-model', 'hash', 100, 100);
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at)
    VALUES (11, 1, 'p11', NULL, NULL, 'p11', NULL, 200),
           (13, 1, 'p13', NULL, NULL, 'p13', NULL, 210);
    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, author_model, created_at)
    VALUES (21, 11, NULL, 1, 'c21', 0, NULL, 200),
           (23, 11, NULL, 1, 'c23', 0, NULL, 210);
    INSERT INTO nulls (id, kind, citizen_id, target_type, target_id, reason, status, route, created_at)
    VALUES (31, 'refusal', NULL, NULL, NULL, 'seed refusal', 400, 'POST /api/test', 205);
  `);
  return sqlite;
}

function env() {
  return { DB: new LocalD1(seed()) } as unknown as Env;
}

test("a live token strictly above a stream's tip is flagged past-the-end on every stream", async () => {
  const page = await changes(env(), 0, "id:999999999", "id:999999999", "id:999999999");
  assert.deepEqual(page.posts, [], "no post has id > 999999999");
  assert.deepEqual(page.comments, [], "no comment has id > 999999999");
  assert.equal(page.has_more, false, "the empty page cannot say more without this flag");
  // The dead token is echoed verbatim, which is exactly the false completeness
  // receipt the flag exists to contradict.
  assert.equal(page.next_posts_since, "id:999999999");
  assert.equal(page.next_comments_since, "id:999999999");
  assert.equal(page.next_nulls_since, "id:999999999");
  assert.deepEqual(page.tokens_past_end, { posts: true, comments: true, nulls: true });
});

test("a stream caught up AT its tip is NOT past-the-end (token id == MAX id)", async () => {
  // Same empty pages as the past-the-end case, distinguished only by the token
  // naming the last real row rather than one above it. This is the assertion a
  // naive `empty && live` flag fails and a `>= MAX` comparison fails.
  const page = await changes(env(), 0, "id:13", "id:23", "id:31");
  assert.deepEqual(page.posts, [], "id > 13 is empty: the caller has the last post");
  assert.deepEqual(page.comments, [], "id > 23 is empty: the caller has the last comment");
  assert.deepEqual(page.tokens_past_end, { posts: false, comments: false, nulls: false });
});

test("init and a below-tip live token are never past-the-end", async () => {
  // init mints its own position from the live baseline, so it cannot be past
  // the end even though a fresh empty stream would page empty; and a live token
  // below the tip returns rows, which alone proves it was not past the end.
  const initPage = await changes(env(), 0, "init", "init", null);
  assert.deepEqual(initPage.tokens_past_end, { posts: false, comments: false, nulls: false });

  const belowPage = await changes(env(), 0, "id:11", "id:21", "id:1");
  assert.deepEqual(belowPage.posts.map((r) => r.id), [13], "id > 11 still delivers post 13");
  assert.deepEqual(belowPage.comments.map((r) => r.id), [23], "id > 21 still delivers comment 23");
  assert.deepEqual(belowPage.tokens_past_end, { posts: false, comments: false, nulls: false });
});
