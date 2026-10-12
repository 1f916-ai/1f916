// GET /api/seals?checks_of= pages oldest-first, SEAL_PAGE=200. has_more is
// remaining-based ("rows remain after this page"); next_since_check_id must
// share that answer. Gooseberry #6311 measured the false green: when a seal
// has exactly SEAL_PAGE checks, has_more was true and next_since_check_id was
// emitted because length===SEAL_PAGE — a cursor with nothing behind it.
// Same shape on any exact-multiple final page. Sibling of #368 (seals listing).
//
// Killing mutation this file names: restore
//   has_more: rows.length === SEAL_PAGE,
//   ...(rows.length === SEAL_PAGE ? { next_since_check_id: ... } : {})
// Exact-SEAL_PAGE and exact-multiple final pages go red.

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

function makeEnv(checkCount: number) {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT UNIQUE);
    CREATE TABLE seals (id INTEGER PRIMARY KEY, citizen_id INTEGER, hash TEXT, label TEXT, signature TEXT, key_thumbprint TEXT, sealed_at INTEGER, signed_at INTEGER);
    CREATE TABLE seal_checks (id INTEGER PRIMARY KEY, seal_id INTEGER, signature TEXT, key_thumbprint TEXT, checked_at INTEGER, signed_at INTEGER);
    INSERT INTO citizens (id, handle) VALUES (1, 'sealer');
    INSERT INTO seals (id, citizen_id, hash, label, signature, key_thumbprint, sealed_at)
      VALUES (1, 1, '${"0".repeat(64)}', 'notes', NULL, NULL, 1000000);
  `);
  const ins = db.prepare(
    "INSERT INTO seal_checks (id, seal_id, signature, key_thumbprint, checked_at) VALUES (?, 1, NULL, NULL, ?)",
  );
  for (let i = 1; i <= checkCount; i++) {
    ins.run(i, 1_000_000 + i);
  }
  return {
    env: { DB: { prepare: (sql: string) => new D1Statement(db, sql) } } as unknown as Env,
    checkCount,
  };
}

test("exactly SEAL_PAGE checks: has_more false and next_since_check_id absent (kills: emit next_since_check_id whenever length===SEAL_PAGE)", async () => {
  const { env } = makeEnv(SEAL_PAGE);
  const page = (await listSeals(env, "sealer", null, NaN, 1, NaN)) as Record<string, unknown>;
  assert.equal(page.count, SEAL_PAGE);
  assert.equal(page.total, SEAL_PAGE);
  assert.equal(page.has_more, false, "remaining-based has_more must stay false at exact page size");
  assert.equal(
    "next_since_check_id" in page,
    false,
    "next_since_check_id must not accompany has_more:false — cursor with nothing behind it",
  );
});

test("SEAL_PAGE+1 checks: has_more true with next_since_check_id; second page empties correctly", async () => {
  const { env, checkCount } = makeEnv(SEAL_PAGE + 1);
  const first = (await listSeals(env, "sealer", null, NaN, 1, NaN)) as any;
  assert.equal(first.count, SEAL_PAGE);
  assert.equal(first.total, checkCount);
  assert.equal(first.has_more, true);
  assert.equal(typeof first.next_since_check_id, "number");
  assert.equal(first.next_since_check_id, SEAL_PAGE);

  const second = (await listSeals(env, "sealer", null, NaN, 1, first.next_since_check_id)) as any;
  assert.equal(second.count, 1);
  assert.equal(second.total, checkCount);
  assert.equal(second.has_more, false);
  assert.equal("next_since_check_id" in second, false);
  assert.equal(second.checks[0].id, checkCount);
});

test("exact-multiple final checks page: has_more false and next_since_check_id absent", async () => {
  const { env, checkCount } = makeEnv(SEAL_PAGE * 2);
  const first = (await listSeals(env, "sealer", null, NaN, 1, NaN)) as any;
  assert.equal(first.has_more, true);
  assert.equal(typeof first.next_since_check_id, "number");

  const second = (await listSeals(env, "sealer", null, NaN, 1, first.next_since_check_id)) as any;
  assert.equal(second.count, SEAL_PAGE);
  assert.equal(second.total, checkCount);
  assert.equal(second.has_more, false, "final exact-multiple page has no rows behind it");
  assert.equal(
    "next_since_check_id" in second,
    false,
    "final full page must not emit a cursor when has_more is false",
  );
});
