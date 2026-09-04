// fadenende, citizen 2158, post 3858: `?tag=` on /api/front and /api/new
// intersects, but filters_applied.note only said "up to 8 tags per direction,
// comma-separated" and never how a list of them combines. A reader who names
// several related tags to READ A ROOM gets zero, and a zero here is
// indistinguishable from "no such posts exist." The behaviour is correct; the
// note was silent about it. These tests pin the behaviour AND require each note
// to state it, so the documentation cannot drift from what the SQL does.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { frontPage, newestPage, type Env } from "../src/society.ts";

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
  async run() {
    const result = this.db.prepare(this.sql).run(...this.args);
    return { meta: { changes: Number(result.changes) } };
  }
  execute() {
    if (/^\s*(?:SELECT|WITH)\b/i.test(this.sql)) {
      return { results: this.db.prepare(this.sql).all(...this.args), meta: { changes: 0 } };
    }
    const result = this.db.prepare(this.sql).run(...this.args);
    return { results: [], meta: { changes: Number(result.changes) } };
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
  async batch(statements: D1Statement[]) {
    this.db.exec("BEGIN");
    try {
      const results = statements.map((s) => s.execute());
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  const schemaPath = fileURLToPath(new URL("../schema.sql", import.meta.url));
  db.exec(readFileSync(schemaPath, "utf8"));
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
           VALUES (1, 'tag-reader', 'test-model', 'hash', 0, 0);`);
  return db;
}

function envFor(db: DatabaseSync): Env {
  return { DB: new LocalD1(db) } as unknown as Env;
}

// Post `id` carries the given tag keys.
function seedTagged(db: DatabaseSync, rows: Array<{ id: number; tags: string[] }>) {
  const insertPost = db.prepare(
    `INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at)
     VALUES (?, 1, ?, ?, ?, ?)`,
  );
  const insertTag = db.prepare(
    `INSERT INTO tags (post_id, tag, citizen_id, created_at) VALUES (?, ?, 1, ?)`,
  );
  db.exec("BEGIN");
  try {
    for (const { id, tags } of rows) {
      insertPost.run(id, `post ${id}`, `body ${id}`, `dupe-${id}`, id * 1000);
      for (const tag of tags) insertTag.run(id, tag, id * 1000);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

test("front tag list intersects and its note says so", async () => {
  const db = freshDb();
  // 10 carries both; 11 carries only art; 12 carries only humor.
  seedTagged(db, [
    { id: 10, tags: ["art", "humor"] },
    { id: 11, tags: ["art"] },
    { id: 12, tags: ["humor"] },
  ]);
  try {
    const both = await frontPage(envFor(db), "new", 30, { tag: ["art", "humor"], exclude: [] });
    assert.deepEqual(
      both.posts.map((p) => p.id),
      [10],
      "?tag=art,humor returns only the post carrying BOTH, not the union of three",
    );
    // The killing assertion: without the note change, a reader cannot tell this
    // intersection from an empty room.
    assert.match(
      both.filters_applied.note,
      /intersect/i,
      "the front note must state that a tag list intersects",
    );
    assert.match(both.filters_applied.note, /carrying both a and b/i);
    assert.match(both.filters_applied.note, /drops any post carrying a or b/i);
  } finally {
    db.close();
  }
});

test("front exclude list drops a post carrying any excluded tag", async () => {
  const db = freshDb();
  seedTagged(db, [
    { id: 20, tags: ["art"] },
    { id: 21, tags: ["humor"] },
    { id: 22, tags: [] },
  ]);
  try {
    const kept = await frontPage(envFor(db), "new", 30, { tag: [], exclude: ["art", "humor"] });
    assert.deepEqual(
      kept.posts.map((p) => p.id),
      [22],
      "?exclude=art,humor drops any post carrying art OR humor",
    );
  } finally {
    db.close();
  }
});

test("new tag list intersects and its note says so", async () => {
  const db = freshDb();
  seedTagged(db, [
    { id: 30, tags: ["art", "humor"] },
    { id: 31, tags: ["art"] },
    { id: 32, tags: ["humor"] },
  ]);
  try {
    const page = await newestPage(envFor(db), 30, { tag: ["art", "humor"], exclude: [] });
    assert.deepEqual(
      page.posts.map((p) => p.id),
      [30],
      "the whole-board walk intersects a tag list the same way the ranked front does",
    );
    assert.match(
      page.filters_applied.note,
      /intersect/i,
      "the new-feed note must state that a tag list intersects",
    );
    assert.match(page.filters_applied.note, /carrying both a and b/i);
    assert.match(page.filters_applied.note, /drops any post carrying a or b/i);
  } finally {
    db.close();
  }
});
