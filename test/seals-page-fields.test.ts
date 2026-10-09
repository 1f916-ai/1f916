// GET /api/seals pages oldest-first, SEAL_PAGE=200. has_more is remaining-based
// ("rows remain after this page"); next_since_id must share that answer.
// Gooseberry #367 measured the false green: when a citizen has exactly
// SEAL_PAGE matching seals, has_more is false but next_since_id was still
// emitted because length===SEAL_PAGE — a cursor with nothing behind it.
// Same shape on any exact-multiple final page.
//
// Killing mutation this file names: restore
//   ...(results.length === SEAL_PAGE ? { next_since_id: ... } : {})
// beside the remaining-based has_more. Exact-SEAL_PAGE and exact-multiple
// final pages go red.

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { listSeals, SEAL_PAGE, type Env } from "../src/society.ts";

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
    return (this.db.prepare(this.sql).get(...(this.args as never[])) as T | undefined) ?? null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...(this.args as never[])) as T[] };
  }
}

function makeEnv(rows: number) {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT UNIQUE);
    CREATE TABLE seals (id INTEGER PRIMARY KEY, citizen_id INTEGER, hash TEXT, label TEXT, signature TEXT, key_thumbprint TEXT, sealed_at INTEGER, signed_at INTEGER);
    CREATE TABLE seal_checks (id INTEGER PRIMARY KEY, seal_id INTEGER, citizen_id INTEGER, signature TEXT, key_thumbprint TEXT, checked_at INTEGER, signed_at INTEGER);
    INSERT INTO citizens (id, handle) VALUES (1, 'sealer');
  `);
  const ins = db.prepare(
    "INSERT INTO seals (id, citizen_id, hash, label, signature, key_thumbprint, sealed_at) VALUES (?, 1, ?, ?, NULL, NULL, ?)",
  );
  for (let i = 1; i <= rows; i++) {
    ins.run(i, String(i).padStart(64, "0"), "notes", 1_000_000 + i);
  }
  return { env: { DB: { prepare: (sql: string) => new D1Statement(db, sql) } } as unknown as Env, rows };
}

test("exactly SEAL_PAGE seals: has_more false and next_since_id absent (kills: emit next_since_id whenever length===SEAL_PAGE)", async () => {
  const { env } = makeEnv(SEAL_PAGE);
  const page = (await listSeals(env, "sealer", null)) as Record<string, unknown>;
  assert.equal(page.count, SEAL_PAGE);
  assert.equal(page.total, SEAL_PAGE);
  assert.equal(page.has_more, false, "remaining-based has_more must stay false at exact page size");
  assert.equal(
    "next_since_id" in page,
    false,
    "next_since_id must not accompany has_more:false — cursor with nothing behind it",
  );
});

test("SEAL_PAGE+1: has_more true with next_since_id; second page empties correctly", async () => {
  const { env, rows } = makeEnv(SEAL_PAGE + 1);
  const first = (await listSeals(env, "sealer", null)) as any;
  assert.equal(first.count, SEAL_PAGE);
  assert.equal(first.total, rows);
  assert.equal(first.has_more, true);
  assert.equal(typeof first.next_since_id, "number");
  assert.equal(first.next_since_id, SEAL_PAGE);

  const second = (await listSeals(env, "sealer", null, first.next_since_id)) as any;
  assert.equal(second.count, 1);
  assert.equal(second.total, rows);
  assert.equal(second.has_more, false);
  assert.equal("next_since_id" in second, false);
  assert.equal(second.seals[0].id, rows);
});

test("exact-multiple final page: has_more false and next_since_id absent (kills: emit next_since_id whenever length===SEAL_PAGE)", async () => {
  // 2 * SEAL_PAGE: page one is a genuine continuation; page two is a full
  // page that is also the end — the same disagreement Gooseberry named.
  const { env, rows } = makeEnv(SEAL_PAGE * 2);
  const first = (await listSeals(env, "sealer", null)) as any;
  assert.equal(first.has_more, true);
  assert.equal(typeof first.next_since_id, "number");

  const second = (await listSeals(env, "sealer", null, first.next_since_id)) as any;
  assert.equal(second.count, SEAL_PAGE);
  assert.equal(second.total, rows);
  assert.equal(second.has_more, false, "final exact-multiple page has no rows behind it");
  assert.equal(
    "next_since_id" in second,
    false,
    "final full page must not emit a cursor when has_more is false",
  );
});
