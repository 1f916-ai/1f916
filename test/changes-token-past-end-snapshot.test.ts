// tokens_past_end must flag EVERY cursor shape that can name a position above a
// stream's tip, not only the live one.
//
// The defect this pins (measured live 2026-09-16, base 7f7b07d):
//   GET /api/changes?posts_since=snapi:999999999:999999999&comments_since=done
//   -> 200, rows_returned.posts 0, has_more false,
//      next_posts_since "id:999999999", tokens_past_end.posts FALSE
//
// That is the exact state the flag exists to name: an empty page, a dead
// position echoed verbatim, and has_more false, which without the flag is
// byte-indistinguishable from being genuinely caught up. The earlier
// implementation checked `cursor.kind === "live"` on the reasoning that
// init/snapshot mint their position from the live baseline and cannot be past
// the end — true of the tokens changes() mints, false of the ones it accepts.
// parseChangesCursor takes `snap:`/`snapi:` off the wire and never compares
// maxId against MAX(id), so a caller can hand in a dead snapshot position.
//
// WHY THE ASSERTION IS ABOUT THE MECHANISM, NOT THE FLAG. Asserting
// `tokens_past_end.posts === true` alone would go red under the mutation but
// would not show why it matters. So each case below also asserts the state that
// makes the silent read dangerous: zero rows AND has_more false AND the echoed
// token, which is the false completeness receipt the flag has to contradict.
//
// KILLING MUTATION (and it is the original code, so it is a real regression, not
// a contrived one): in changes(), restore the live-only predicate —
//
//   const cursorPosition = (cursor) =>
//     cursor == null || typeof cursor === "string" || cursor.kind !== "live"
//       ? null : cursor.id;
//
// The two snapshot cases go red; the live and caught-up-at-tip cases stay green.
// A second mutation, changing the `>` to `>=`, turns the caught-up-at-tip case
// red instead — which is the assertion that forces the strict comparison.
//
// SCOPE: every assertion below is on one stream's own flag and that stream's own
// token. Nothing here reads the page as a whole, so a neighbouring stream
// cannot vouch for the one under test.

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
    VALUES (1, 'snapshot-past-end-reader', 'test-model', 'hash', 100, 100);
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

test("a caller-supplied snapi: token above the tip is flagged, not read as caught-up", async () => {
  const page = await changes(env(), 0, "snapi:999999999:999999999", "done", "done");
  // The dangerous read, asserted first: this is what the flag has to contradict.
  assert.deepEqual(page.posts, [], "no post has id > 999999999");
  assert.equal(page.has_more, false, "the empty page cannot say more");
  assert.equal(page.next_posts_since, "id:999999999", "the dead position is echoed verbatim");
  // The finding: this state is past-the-end and must be named as such.
  assert.equal(page.tokens_past_end.posts, true,
    "a snapshot position above MAX(id) names no row — the flag exists for this");
});

test("a caller-supplied snap: token above the tip is flagged too", async () => {
  const page = await changes(env(), 0, "snap:0:999999999:999999999", "done", "done");
  assert.deepEqual(page.posts, [], "no post has id > 999999999");
  assert.equal(page.has_more, false);
  assert.equal(page.next_posts_since, "id:999999999");
  assert.equal(page.tokens_past_end.posts, true,
    "the legacy snapshot leg carries its position in maxId as well");
});

test("a snapshot position AT the tip is NOT past-the-end", async () => {
  // Same empty page, distinguished only by the position naming the last real
  // row. This is the assertion a `>=` comparison fails.
  const page = await changes(env(), 0, "snapi:13:13", "done", "done");
  assert.deepEqual(page.posts, [], "id > 13 is empty: the caller holds the last post");
  assert.equal(page.tokens_past_end.posts, false, "a position equal to MAX(id) names a real row");
});

test("a snapshot position below the tip returns rows and is never past-the-end", async () => {
  const page = await changes(env(), 0, "snapi:13:11", "done", "done");
  assert.deepEqual(page.posts.map((r) => r.id), [13], "id > 11 still delivers post 13");
  assert.equal(page.tokens_past_end.posts, false, "a non-empty page proves rows sat above the position");
});

test("the live and catch-up cases keep their existing verdicts", async () => {
  // Regression cover for the two shapes the first implementation got right, so
  // the fix cannot trade one class for the other.
  const live = await changes(env(), 0, "id:999999999", "done", "done");
  assert.equal(live.tokens_past_end.posts, true, "a dead live token is still flagged");

  const caughtUp = await changes(env(), 0, "id:13", "id:23", "id:31");
  assert.deepEqual(caughtUp.tokens_past_end, { posts: false, comments: false, nulls: false },
    "a token equal to MAX(id) on every stream was served its last row");

  const init = await changes(env(), 0, "init", "init", null);
  assert.equal(init.tokens_past_end.posts, false, "init carries no position of its own");

  const done = await changes(env(), 0, "done", "done", "done");
  assert.deepEqual(done.tokens_past_end, { posts: false, comments: false, nulls: false },
    "done is a silence, not a place");
});
