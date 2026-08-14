// Minimal D1 adapter backed by node:sqlite for tests whose correctness depends
// on batch statements executing sequentially inside one transaction.
//
// A mock that returns canned batch success cannot expose changes(), guards that
// read a preceding statement's post-state, or rollback of earlier statements.
// Keep those semantics here so every state/event regression exercises the same
// execution model.

import { DatabaseSync } from "node:sqlite";
import type { Env } from "../../src/society.ts";

export class SqliteD1Statement {
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
    return (this.db.prepare(this.sql).get(...(this.args as never[])) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...(this.args as never[])) as T[] };
  }

  async run() {
    const result = this.execute();
    return { results: result.results, meta: result.meta };
  }

  execute(): { results: unknown[]; meta: { changes: number } } {
    const statement = this.db.prepare(this.sql);
    if (/^\s*SELECT\b/i.test(this.sql)) {
      return { results: statement.all(...(this.args as never[])), meta: { changes: 0 } };
    }
    if (/\bRETURNING\b/i.test(this.sql)) {
      const results = statement.all(...(this.args as never[]));
      const changes = Number((this.db.prepare("SELECT changes() AS n").get() as { n: number }).n);
      return { results, meta: { changes } };
    }
    const result = statement.run(...(this.args as never[]));
    return { results: [], meta: { changes: Number(result.changes) } };
  }
}

export class SqliteD1 {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  prepare(sql: string) {
    return new SqliteD1Statement(this.db, sql);
  }

  async batch(statements: SqliteD1Statement[]) {
    this.db.exec("BEGIN");
    try {
      // Sequential order is load-bearing: SQLite's changes() and post-state
      // guards in statement N observe statement N-1 before the transaction
      // commits, matching the D1 batch contract these tests depend on.
      const results = statements.map((statement) => statement.execute());
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

export function sqliteTestEnv(schema: string): { env: Env; db: DatabaseSync; d1: SqliteD1 } {
  const db = new DatabaseSync(":memory:");
  db.exec(schema);
  const d1 = new SqliteD1(db);
  return { db, d1, env: { DB: d1 } as unknown as Env };
}
