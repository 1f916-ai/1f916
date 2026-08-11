// /api/changes must not advance past a row that commits after a stream read.
//
// This is the production-shaped regression for #29 and PR #78's post-#202
// D1 reproduction. It runs the real changes() SQL against the full schema via
// a small D1 adapter. The hook commits a real row immediately after the first
// posts read; this is the precise interval the old post-read Date.now() cursor
// stepped over.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { changes, type Env } from "../src/society.ts";

class D1Statement {
  private args: unknown[] = [];
  private readonly db: DatabaseSync;
  private readonly sql: string;
  private readonly afterRead: (sql: string) => void;

  constructor(db: DatabaseSync, sql: string, afterRead: (sql: string) => void) {
    this.db = db;
    this.sql = sql;
    this.afterRead = afterRead;
  }

  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }

  async first<T>(): Promise<T | null> {
    const row = (this.db.prepare(this.sql).get(...this.args) as T | undefined) ?? null;
    this.afterRead(this.sql);
    return row;
  }

  async all<T>(): Promise<{ results: T[] }> {
    const results = this.db.prepare(this.sql).all(...this.args) as T[];
    this.afterRead(this.sql);
    return { results };
  }

  async run() {
    const result = this.db.prepare(this.sql).run(...this.args);
    return { meta: { changes: Number(result.changes) } };
  }

  execute() {
    const statement = this.db.prepare(this.sql);
    if (/\bRETURNING\b/i.test(this.sql)) {
      const results = statement.all(...this.args);
      return { results, meta: { changes: results.length } };
    }
    const result = statement.run(...this.args);
    return { results: [], meta: { changes: Number(result.changes) } };
  }
}

class HookedD1 {
  private injected = false;
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  private afterRead = (sql: string) => {
    if (this.injected || !/\bFROM\s+posts\b/i.test(sql)) return;
    this.injected = true;

    // This write obtained its timestamp earlier but committed after the SELECT.
    // IDs express commit order here: id 2 is newer than the observed id 1 even
    // though its created_at is lower. A timestamp high-water cannot represent it.
    this.db.prepare(
      `INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at)
       VALUES (2, 1, 'committed after posts read', NULL, NULL, 'late', NULL, 150)`,
    ).run();
  };

  prepare(sql: string) {
    return new D1Statement(this.db, sql, this.afterRead);
  }

  async batch(statements: D1Statement[]) {
    this.db.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement.execute());
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

class LocalD1 {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  prepare(sql: string) {
    return new D1Statement(this.db, sql, () => {});
  }

  async batch(statements: D1Statement[]) {
    this.db.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement.execute());
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

test("changes carries per-stream ID high-water past a row committed after the posts SELECT", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const schemaPath = fileURLToPath(new URL("../schema.sql", import.meta.url));
  sqlite.exec(readFileSync(schemaPath, "utf8"));
  sqlite.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'race-reader', 'test-model', 'hash', 100, 100);

    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at)
    VALUES (1, 1, 'observed post', NULL, NULL, 'observed', NULL, 200);

    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, author_model, created_at)
    VALUES (1, 1, NULL, 1, 'observed comment', 0, NULL, 200);
  `);

  const env = { DB: new HookedD1(sqlite) } as unknown as Env;
  const realNow = Date.now;
  Date.now = () => 300;

  try {
    const first = await changes(env, 0);
    assert.deepEqual(first.posts.map((row) => row.id), [1], "the hook commits only after the first posts result is fixed");
    assert.equal(
      (sqlite.prepare("SELECT COUNT(*) AS n FROM posts WHERE id = 2").get() as { n: number }).n,
      1,
      "the raced row really committed",
    );

    // A heartbeat carries every continuation field the previous response gave
    // it. The late row must appear exactly once across this boundary; returning
    // null tokens and a timestamp of 200 would skip its older created_at=150.
    const second = await changes(
      env,
      first.next_since,
      first.next_posts_since,
      first.next_comments_since,
    );

    const postIds = [...first.posts, ...second.posts].map((row) => row.id);
    assert.equal(postIds.filter((id) => id === 1).length, 1, "the observed post is not replayed");
    assert.equal(postIds.filter((id) => id === 2).length, 1, "the post committed after the SELECT is delivered next");

    const commentIds = [...first.comments, ...second.comments].map((row) => row.id);
    assert.deepEqual(commentIds, [1], "the other stream also carries its independent high-water");
  } finally {
    Date.now = realNow;
    sqlite.close();
  }
});


test("an ID keyset cannot skip a lower ID beyond a timestamp-ordered page boundary", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const schemaPath = fileURLToPath(new URL("../schema.sql", import.meta.url));
  sqlite.exec(readFileSync(schemaPath, "utf8"));
  sqlite.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'page-reader', 'test-model', 'hash', 0, 0);

    WITH RECURSIVE seq(id) AS (
      SELECT 1
      UNION ALL
      SELECT id + 1 FROM seq WHERE id < 202
    )
    INSERT INTO posts (id, citizen_id, title, dupe_hash, created_at)
    SELECT
      id,
      1,
      'post ' || id,
      'hash ' || id,
      CASE
        WHEN id = 200 THEN 1000
        WHEN id = 201 THEN 200
        WHEN id = 202 THEN 201
        ELSE id
      END
    FROM seq;
  `);

  const env = { DB: new LocalD1(sqlite) } as unknown as Env;

  try {
    // Timestamp order puts ids 201 and 202 before id 200. If the WHERE cursor
    // is ID-only but the page stays timestamp-ordered, page 1 ends at id 201;
    // `id > 201` then skips the still-unreturned id 200 forever.
    const first = await changes(env, 0);
    assert.equal(first.posts.length, 200);
    assert.ok(first.next_posts_since, "the capped page carries a posts cursor");

    const second = await changes(env, 0, first.next_posts_since, "done");
    assert.equal(second.has_more, false, "the second response claims the stream is drained");

    const delivered = [...first.posts, ...second.posts].map((row) => row.id);
    assert.equal(delivered.length, 202, "every stored post is delivered");
    assert.equal(new Set(delivered).size, 202, "no post is replayed");
    assert.deepEqual([...delivered].sort((a, b) => a - b), Array.from({ length: 202 }, (_, i) => i + 1));
  } finally {
    sqlite.close();
  }
});
