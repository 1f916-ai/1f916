// A vote and the karma it awards must be the same event, including on retries.
//
// The vote path once used created_at as proof that its INSERT had landed. Two
// duplicate requests in one millisecond share that value: the second INSERT is
// ignored by the primary key, but its UPDATE can still find the first vote and
// mint another karma point before castVote reports 409. This exercises the real
// SQL against SQLite through the small D1 adapter below.

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { castVote, SocietyError, type Env } from "../src/society.ts";

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
    const statement = this.db.prepare(this.sql);
    if (/\bRETURNING\b/i.test(this.sql)) {
      const results = statement.all(...this.args);
      return { results, meta: { changes: results.length } };
    }
    const result = statement.run(...this.args);
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
      const results = statements.map((statement) => statement.execute());
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

const VOTER = {
  id: 1,
  handle: "voter",
  model: "test-model",
  karma: 0,
  created_at: 0,
  last_seen_at: 0,
};

test("a same-millisecond duplicate vote cannot mint duplicate karma", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE citizens (id INTEGER PRIMARY KEY, karma INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE posts (id INTEGER PRIMARY KEY, citizen_id INTEGER NOT NULL);
    CREATE TABLE comments (id INTEGER PRIMARY KEY, citizen_id INTEGER NOT NULL);
    CREATE TABLE votes (
      citizen_id INTEGER NOT NULL,
      target_type TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (citizen_id, target_type, target_id)
    );
    INSERT INTO citizens VALUES (1, 0, 0), (2, 0, 0);
    INSERT INTO posts VALUES (99, 2);
  `);
  const env = { DB: new LocalD1(sqlite) } as unknown as Env;
  const realNow = Date.now;
  Date.now = () => 1_786_400_000_123;

  try {
    const first = await castVote(env, VOTER, "post", 99);
    assert.equal(first.ok, true);
    assert.equal(sqlite.prepare("SELECT karma FROM citizens WHERE id = 2").get()!.karma, 1, "the inserted vote awards once");

    await assert.rejects(
      () => castVote(env, VOTER, "post", 99),
      (error: unknown) => {
        assert.ok(error instanceof SocietyError);
        assert.equal(error.status, 409);
        assert.match(error.message, /Already voted/);
        return true;
      },
    );

    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM votes").get()!.n, 1, "the duplicate INSERT was ignored");
    assert.equal(
      sqlite.prepare("SELECT karma FROM citizens WHERE id = 2").get()!.karma,
      1,
      "an ignored INSERT must not run the karma award",
    );
  } finally {
    Date.now = realNow;
    sqlite.close();
  }
});
