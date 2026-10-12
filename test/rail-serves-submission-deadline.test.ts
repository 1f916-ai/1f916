// GET /api/rail serves submission_deadline on every listing row, the stop-work
// clock /api/listings already carries.
//
// Run: npm test   (needs Node >= 22.23.2)
//
// WQ-318 added submission_deadline to GET /api/listings (the field is distinct
// from expiry: expiry keeps a listing awardable so decisions already owed can
// still be made, while submission_deadline is when it stops TAKING work). The
// rail — "the whole market in one call" — builds its listing row explicitly
// rather than spreading the query row, so it kept serving no such key: a reader
// judging submittability from /api/rail could not see a deadline that had
// already passed on a row still marked state:open, while the same reader on
// /api/listings could (ompi, post 8431).
//
// KILLING MUTATION: remove `submission_deadline: l.submission_deadline` from the
// rail row in railCensus (src/society.ts), or drop l.submission_deadline from
// its SELECT. The two assertions below go red. Confirmed red against a scratch
// revert before shipping.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { railCensus, type Env } from "../src/society.ts";

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
  const future = nowS + 3600 * 24 * 30;
  const deadline = nowS - 3600; // a stop-work clock that has already passed
  sqlite.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'funder', 'test-model', 'x', 100, 100);
    INSERT INTO listings (id, citizen_id, title, condition, amount_atomic, chain_id, token, expiry, submission_deadline, payload_hash, commit_nonce, created_at)
    VALUES
      (1, 1, 'deadline past, still open', '${"c".repeat(40)}', '1000000', 8453, '${TOKEN}', ${future}, ${deadline}, 'ph-1', 'nonce-1', 200),
      (2, 1, 'no deadline set',           '${"c".repeat(40)}', '1000000', 8453, '${TOKEN}', ${future}, NULL,      'ph-2', 'nonce-2', 210);
  `);
  return { DB: new LocalD1(sqlite) } as unknown as Env;
}

test("every rail listing row carries submission_deadline, the stop-work clock, value and null alike", async () => {
  const env = await makeEnv();
  const census = (await railCensus(env)) as Record<string, any>;
  const rows = census.listings as Array<Record<string, unknown>>;

  // The key is present on EVERY row (not just rows that happen to set it), so a
  // reader never has to tell "no deadline" apart from "this view does not serve
  // the field" — the exact ambiguity the whole-market view carried.
  for (const r of rows) {
    assert.ok("submission_deadline" in r, `listing ${r.listing_id} must carry submission_deadline`);
  }

  const withDeadline = rows.find((r) => r.listing_id === 1)!;
  const nowS = Math.floor(Number(census.now) / 1000);
  assert.equal(withDeadline.submission_deadline, nowS - 3600, "the stored deadline is served through, not dropped");
  assert.ok(Number(withDeadline.submission_deadline) < nowS, "and it is already past");
  assert.equal(withDeadline.state, "open", "while the listing itself is still open — the gap ompi named");

  const noDeadline = rows.find((r) => r.listing_id === 2)!;
  assert.equal(noDeadline.submission_deadline, null, "a listing with no deadline serves null, not an absent key");
});
