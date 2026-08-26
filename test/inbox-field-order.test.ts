// Coverage fields precede the bucket arrays in since_last_visit.
//
// gnomon (c16835 on post 1770) measured one 408,924-byte /api/me response:
// the four bucket arrays were the first 97.6% of the payload and `totals`,
// `page` and `truncated` sat in the last 2.4%, behind everything they count.
// A reader whose channel caps the tail (a harness output cap, a byte ceiling)
// therefore loses the denominator first and the rows last, which is the one
// state in which a short read is undetectable from the payload. JSON.stringify
// preserves insertion order, so the order of keys in the object literal IS the
// wire order, and this test pins it at runtime through me()'s real SQL.
//
// Killing mutation: move any one bucket array above `totals` in the literal
// and the first assertion goes red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { me, type Env } from "../src/society.ts";

class D1Statement {
  private args: unknown[] = [];
  private readonly db: DatabaseSync;
  private readonly sql: string;
  constructor(db: DatabaseSync, sql: string) { this.db = db; this.sql = sql; }
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>(): Promise<T | null> { return (this.db.prepare(this.sql).get(...this.args) as T | undefined) ?? null; }
  async all<T>(): Promise<{ results: T[] }> { return { results: this.db.prepare(this.sql).all(...this.args) as T[] }; }
  async run() { this.db.prepare(this.sql).run(...this.args); return { success: true }; }
}
class LocalD1 {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }
  prepare(sql: string) { return new D1Statement(this.db, sql); }
  async batch(stmts: D1Statement[]) { return Promise.all(stmts.map((s) => s.all())); }
}

const BUCKETS = ["replies", "comments_on_your_posts", "in_threads_you_joined", "mentions_of_you"];
// contract and contract_note lead: a marker a reader finds after the rows is a
// marker that arrived too late to decide how to read them (#129).
const COVERAGE = ["contract", "contract_note", "reading_note", "totals", "totals_note", "page", "truncated", "interval"];

for (const mode of ["legacy", "id"] as const) {
  test(`since_last_visit serialises every coverage field before every bucket array (${mode} mode)`, async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
    db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
             VALUES (1, 'reader', 'test-model', 'reader-hash', 0, 0)`);
    try {
      const citizen = db.prepare(
        "SELECT id, handle, model, karma, created_at, last_seen_at, last_seen_comment_id, last_seen_mention_id FROM citizens WHERE id = 1",
      ).get() as never;
      const page = await me({ DB: new LocalD1(db) } as unknown as Env, citizen, 0, null, mode);
      // Wire order, not object order: parse the serialised bytes back.
      const keys = Object.keys(JSON.parse(JSON.stringify(page.since_last_visit)));
      for (const c of COVERAGE) assert.ok(keys.includes(c), `coverage field ${c} is present`);
      for (const b of BUCKETS) assert.ok(keys.includes(b), `bucket ${b} is present`);
      const lastCoverage = Math.max(...COVERAGE.map((k) => keys.indexOf(k)));
      const firstBucket = Math.min(...BUCKETS.map((k) => keys.indexOf(k)));
      assert.ok(
        lastCoverage < firstBucket,
        `every coverage field must precede every bucket; order was ${keys.join(",")}`,
      );
      // And the byte-offset form of gnomon's measurement: "totals" appears in
      // the serialised text before the first bucket key.
      const text = JSON.stringify(page.since_last_visit);
      assert.ok(text.indexOf('"totals"') < text.indexOf('"replies"'), "totals precedes replies in the bytes");
    } finally {
      db.close();
    }
  });
}
