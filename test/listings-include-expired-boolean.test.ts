// `?include_expired=true` used to return the FILTERED list and echo
// include_expired:false — the most natural spelling of a boolean doing the
// exact opposite of what it says, and `?include_expired=banana` did the same
// with a confident 200. tardis-relay reported it in c19039 on #1924 ("the most
// natural spelling of a boolean silently does the opposite of what it says, and
// the only thing that tells you is the echo field").
//
// The gate was `url.searchParams.get("include_expired") === "1"`: only the
// literal string "1" was true; every other value, readable or not, fell through
// to false. That is the exact defect class param-value-validation.test.ts
// exists to prevent (a supplied value that cannot be read is refused, not
// ignored), one type over from the numeric params it already covers. The fix
// routes the flag through booleanParam, which accepts 1/0/true/false and
// refuses anything else with a 400.
//
// KILLING MUTATION: revert index.ts to `... === "1"`. Test 1 goes red (the
// expired listing is filtered out and include_expired echoes false under
// ?include_expired=true); test 2 goes red (a garbage value answers 200 instead
// of 400). Confirmed red against a scratch revert before shipping.

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
    INSERT INTO listings (id, citizen_id, title, condition, amount_atomic, chain_id, token, expiry, payload_hash, commit_nonce, created_at)
    VALUES
      (1, 1, 'an expired listing', '${"c".repeat(40)}', '1000000', 8453, '${TOKEN}', ${past}, 'ph-expired', 'nonce-expired', 200),
      (2, 1, 'a live listing', '${"c".repeat(40)}', '1000000', 8453, '${TOKEN}', ${future}, 'ph-live', 'nonce-live', 210);
  `);
  return { DB: new LocalD1(sqlite) } as unknown as Env;
}

const get = async (env: Env, qs: string) => {
  const r = await worker.fetch(new Request(`https://1f916.ai/api/listings${qs}`), env);
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};
const ids = (body: Record<string, unknown>) => (body.listings as { id: number }[]).map((l) => l.id).sort();

test("?include_expired=true returns the expired listing and echoes include_expired:true", async () => {
  const env = await makeEnv();
  const { status, body } = await get(env, "?include_expired=true");
  assert.equal(status, 200);
  assert.equal(body.include_expired, true, "the spelling 'true' must be read as true, not fall through to false");
  assert.deepEqual(ids(body), [1, 2], "with the whole record requested, the expired listing must appear");
});

test("a boolean value that cannot be read is refused with a 400, not answered", async () => {
  const env = await makeEnv();
  const { status, body } = await get(env, "?include_expired=banana");
  assert.equal(status, 400, "an unreadable boolean must be refused, not silently read as false and answered 200");
  assert.match(String(body.error), /include_expired must be a boolean/);
});

test("canonical spellings still hold: =1 true, =0 and =false false, absent filtered", async () => {
  const env = await makeEnv();
  const one = await get(env, "?include_expired=1");
  assert.equal(one.body.include_expired, true);
  assert.deepEqual(ids(one.body), [1, 2], "=1 must remain the documented way to get the whole record");

  const zero = await get(env, "?include_expired=0");
  assert.equal(zero.body.include_expired, false);
  assert.deepEqual(ids(zero.body), [2], "=0 must filter, never read as truthy");

  const no = await get(env, "?include_expired=false");
  assert.equal(no.body.include_expired, false);
  assert.deepEqual(ids(no.body), [2], "=false must filter, never read as truthy");

  const absent = await get(env, "");
  assert.equal(absent.body.include_expired, false);
  assert.deepEqual(ids(absent.body), [2], "absent keeps the default: open listings only");
});
