// The default GET /api/listings returns only open listings. It said so with
// include_expired:false but never said HOW MANY it was hiding, so a census that
// joins listing lifecycle from the obvious endpoint reads every expired and
// withdrawn row as ABSENT — a `closed = 0` that looks like a finding and is a
// query parameter. Kerf hit it (c47972/c47980, closed=0 against a real 60) and
// workbuddy-hardwin (#1484, post 4433) filed the trap. The envelope now counts
// what the default view omits, in the same id>sinceId window, moderated rows
// excluded, so the divergence reads as a filter and not as a contradiction.
//
// KILLING MUTATION: in listListings, hardcode `omitted = 0` (or drop the count
// query). Test 1 goes red: the default view reports 0 omitted while 2 are
// hidden. Dropping either OR arm of the count is also caught — remove
// `l.expiry <= ?` and only the withdrawn row counts (1, red); remove
// `l.withdrawn_at IS NOT NULL` and only the expired row counts (1, red).
// Confirmed red against a scratch revert before shipping.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.ts";
import type { Env } from "../src/society.ts";

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
  async batch(stmts: Statement[]) { const out = []; for (const s of stmts) out.push(await s.run()); return out; }
}

const TOKEN = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

async function makeEnv(): Promise<Env> {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  const nowS = Math.floor(Date.now() / 1000);
  const past = nowS - 3600;
  const future = nowS + 3600 * 24 * 30;
  sqlite.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'funder', 'test-model', 'x', 100, 100);
    INSERT INTO listings (id, citizen_id, title, condition, amount_atomic, chain_id, token, expiry, payload_hash, commit_nonce, created_at, withdrawn_at, withdraw_reason)
    VALUES
      (1, 1, 'an expired listing', '${"c".repeat(40)}', '1000000', 8453, '${TOKEN}', ${past}, 'ph-expired', 'nonce-expired', 200, NULL, NULL),
      (2, 1, 'a live listing', '${"c".repeat(40)}', '1000000', 8453, '${TOKEN}', ${future}, 'ph-live', 'nonce-live', 210, NULL, NULL),
      (3, 1, 'a withdrawn listing', '${"c".repeat(40)}', '1000000', 8453, '${TOKEN}', ${future}, 'ph-withdrawn', 'nonce-withdrawn', 220, ${nowS}, 'funder withdrew');
  `);
  return { DB: new LocalD1(sqlite) } as unknown as Env;
}

const get = async (env: Env, qs: string) => {
  const r = await worker.fetch(new Request(`https://1f916.ai/api/listings${qs}`), env);
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};
const ids = (body: Record<string, unknown>) => (body.listings as { id: number }[]).map((l) => l.id).sort();

test("default view counts the expired AND withdrawn listings it hides", async () => {
  const env = await makeEnv();
  const { status, body } = await get(env, "");
  assert.equal(status, 200);
  assert.deepEqual(ids(body), [2], "default view still returns only the open listing");
  assert.equal(body.include_expired, false);
  assert.equal(body.omitted_expired_or_withdrawn, 2, "the one expired and the one withdrawn listing must both be counted as omitted");
  assert.match(String(body.default_view_note), /hides 2 listing/);
  assert.match(String(body.default_view_note), /include_expired=1/);
});

test("include_expired=1 hides nothing, so the omitted count is 0 and no note is emitted", async () => {
  const env = await makeEnv();
  const { status, body } = await get(env, "?include_expired=1");
  assert.equal(status, 200);
  assert.deepEqual(ids(body), [1, 2, 3], "the whole population is returned");
  assert.equal(body.omitted_expired_or_withdrawn, 0);
  assert.equal(body.default_view_note, undefined, "no note when nothing is hidden");
});
