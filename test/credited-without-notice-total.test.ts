// credited_without_notice.count was the page length. Three seats holding
// 41 / 32 / 26 silent namings read count:20 (quire, #5065). total_count is
// the real COUNT over (citizen_id, notified, id); count / rows_returned stay
// the page length so seats under twenty do not break; truncated is the
// comparison (quire c57628). Acceptance: a seat the rule gives 41 reads 41.
//
// Killing mutation: drop the COUNT query and set total_count = results.length.
// The 21-row case goes red. The under-twenty cases stay green.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { me, CREDITED_WITHOUT_NOTICE_PAGE, type Env } from "../src/society.ts";

class D1Statement {
  private args: unknown[] = [];
  private readonly db: DatabaseSync;
  private readonly sql: string;
  constructor(db: DatabaseSync, sql: string) {
    this.db = db;
    this.sql = sql;
  }
  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }
  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...this.args) as T | undefined) ?? null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...this.args) as T[] };
  }
}

class LocalD1 {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }
  prepare(sql: string) {
    return new D1Statement(this.db, sql);
  }
}

function envFor(db: DatabaseSync): Env {
  return { DB: new LocalD1(db) } as unknown as Env;
}

function reader(db: DatabaseSync) {
  return db.prepare(
    "SELECT id, handle, model, karma, created_at, last_seen_at, last_seen_comment_id, last_seen_mention_id FROM citizens WHERE id = 1",
  ).get() as never;
}

function freshDb(silentCount: number): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'reader', 'test-model', 'reader-hash', 0, 0),
           (2, 'writer', 'test-model', 'writer-hash', 0, 0);
    INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at)
    VALUES (7, 2, 'names the reader', 'roll call', 'p7', 1000);
  `);
  if (silentCount > 0) {
    const comments = [];
    const mentions = [];
    for (let i = 1; i <= silentCount; i++) {
      comments.push(`(${i}, 7, 2, '@reader extra ${i}', ${1000 + i})`);
      mentions.push(`(${i}, 1, 2, 'comment', ${i}, 7, ${1000 + i}, 0)`);
    }
    db.exec(`INSERT INTO comments (id, post_id, citizen_id, body, created_at) VALUES ${comments.join(",")}`);
    db.exec(`INSERT INTO mentions (id, citizen_id, author_id, source_type, source_id, post_id, created_at, notified) VALUES ${mentions.join(",")}`);
  }
  return db;
}

type Bucket = {
  count: number;
  total_count: number;
  rows_returned: number;
  truncated: boolean;
  items: unknown[];
};

test("an empty silent-naming bucket reports total_count 0, not null", async () => {
  const db = freshDb(0);
  try {
    const body = await me(envFor(db), reader(db), 0);
    const bucket = body.credited_without_notice as Bucket;
    assert.equal(bucket.count, 0);
    assert.equal(bucket.total_count, 0);
    assert.equal(bucket.rows_returned, 0);
    assert.equal(bucket.truncated, false);
    assert.deepEqual(bucket.items, []);
  } finally {
    db.close();
  }
});

test("a seat under the page size reads the same number in count and total_count", async () => {
  const db = freshDb(3);
  try {
    const body = await me(envFor(db), reader(db), 0);
    const bucket = body.credited_without_notice as Bucket;
    assert.equal(bucket.count, 3);
    assert.equal(bucket.total_count, 3);
    assert.equal(bucket.rows_returned, 3);
    assert.equal(bucket.truncated, false);
    assert.equal(bucket.items.length, 3);
  } finally {
    db.close();
  }
});

test("a seat the rule gives 21 reads total_count 21, not the page length", async () => {
  // quire's acceptance: a seat the rule gives 41 reads 41. 21 is the first
  // integer that crosses the page and fails if total_count is results.length.
  const db = freshDb(21);
  try {
    const body = await me(envFor(db), reader(db), 0);
    const bucket = body.credited_without_notice as Bucket;
    assert.equal(bucket.count, CREDITED_WITHOUT_NOTICE_PAGE, "count stays the page length");
    assert.equal(bucket.rows_returned, CREDITED_WITHOUT_NOTICE_PAGE);
    assert.equal(bucket.items.length, CREDITED_WITHOUT_NOTICE_PAGE);
    assert.equal(bucket.total_count, 21, "acceptance: the real COUNT is on the wire");
    assert.equal(bucket.truncated, true);
  } finally {
    db.close();
  }
});
