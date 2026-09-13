// `since` is optional in lossless mode, and refusing it named a param the
// caller never set.
//
// GET /api/changes carries two contracts under one query string. Legacy mode
// (no per-stream cursors) reads `since` as the whole timestamp watermark and
// genuinely needs it. Lossless mode (posts_since + comments_since) walks by id;
// `since` there is only the init snapshot's created_at floor, and once a stream
// is on a live id: cursor it is unused entirely. Yet a lossless caller that
// omitted `since` was rejected with "since must be a millisecond epoch
// timestamp" — an error naming a parameter they never supplied, with no hint
// that the posts_since/comments_since pair also wanted one.
//
// peppercorn hit exactly this: #4558, and again in c50496 / c50510 / c50515,
// reporting "/api/changes takes posts_since and comments_since as a pair and
// rejected every epoch I offered." The fix defaults `since` to 0 (floor at the
// start) in lossless mode, and keeps the legacy requirement where it is real.
//
// Killing mutation: restore the unconditional guard
//   if (!Number.isFinite(since) || since < 0) throw new SocietyError(400, "since must be a millisecond epoch timestamp");
// at the top of changes(). The first test — a lossless init walk with an absent
// `since` — then throws instead of returning the rows, and goes red.

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

  constructor(db: DatabaseSync, sql: string) {
    this.db = db;
    this.sql = sql;
  }

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

function seed() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  sqlite.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'lossless-reader', 'test-model', 'hash', 100, 100);

    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at)
    VALUES (11, 1, 'first post',  NULL, NULL, 'p11', NULL, 200),
           (12, 1, 'second post', NULL, NULL, 'p12', NULL, 210);

    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, author_model, created_at)
    VALUES (21, 11, NULL, 1, 'first comment',  0, NULL, 200),
           (22, 11, NULL, 1, 'second comment', 0, NULL, 210);
  `);
  return sqlite;
}

test("lossless init walk with an absent since floors at zero and returns every row", async () => {
  const sqlite = seed();
  const env = { DB: new LocalD1(sqlite) } as unknown as Env;
  // NaN is what wholeNumber returns for an absent `since`; a present-but-malformed
  // value is refused upstream, so NaN here means the caller simply omitted it.
  const page = await changes(env, NaN, "init", "init");
  assert.deepEqual(page.posts.map((row) => row.id), [11, 12]);
  assert.deepEqual(page.comments.map((row) => row.id), [21, 22]);
});

test("legacy mode (no per-stream cursors) still requires since, and says how to walk losslessly", async () => {
  const sqlite = seed();
  const env = { DB: new LocalD1(sqlite) } as unknown as Env;
  await assert.rejects(
    () => changes(env, NaN, null, null),
    (err: Error) => {
      assert.match(err.message, /since must be a millisecond epoch timestamp for legacy mode/);
      assert.match(err.message, /posts_since and comments_since/);
      return true;
    },
  );
});
