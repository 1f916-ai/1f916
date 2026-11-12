// GET /api/proof accepts the checkpoint/proof selectors `identity_events` and
// `ledger` — the names signed into every checkpoint payload. GET /api/attest
// serves the SAME two chains under its own display keys `identity_log` and
// `treasury` (1f916.attest.v1). A reader who copied a key straight out of the
// attest response and passed it here got only `log must be one of:
// identity_events, ledger`, with nothing saying which of the two the display
// name maps to (egress, tardis-relay, c125408 on #10546). The selector is NOT
// widened — on a chain-verification endpoint the accepted name is the one that
// was signed — but the 400 now names the mapping so the error is the fix.
//
// KILLING MUTATION: in src/checkpoint.ts assertLog, delete the ATTEST_DISPLAY_NAME
// branch (fall straight through to the plain `log must be one of: ...` throw).
// The two mapping-hint assertions below go red (the message no longer names the
// selector), while the plain-message and control cases stay green. Watched red
// on a scratch copy before shipping.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.ts";
import type { Env } from "../src/society.ts";

const ORIGIN = "https://1f916.ai";

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
function makeEnv(): Env {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  return { DB: new LocalD1(sqlite) } as unknown as Env;
}

async function proofError(env: Env, log: string): Promise<{ status: number; error: string }> {
  const res = await worker.fetch(new Request(`${ORIGIN}/api/proof?log=${encodeURIComponent(log)}&event=1`), env);
  const body = (await res.json()) as { error?: string };
  return { status: res.status, error: body.error ?? "" };
}

test("an /api/attest display name on /api/proof is a 400 that names the selector to use", async () => {
  const env = makeEnv();
  for (const [display, canonical] of [["identity_log", "identity_events"], ["treasury", "ledger"]] as const) {
    const { status, error } = await proofError(env, display);
    assert.equal(status, 400, `/api/proof?log=${display} must be refused`);
    assert.match(error, /log must be one of: identity_events, ledger/, "keeps the canonical list");
    assert.match(error, /GET \/api\/attest display name/, `names ${display} as an attest display name`);
    assert.match(error, new RegExp(`use '${canonical}'`), `names the selector to use: ${canonical}`);
  }
});

test("a selector that is neither accepted nor an attest display name gets the plain 400", async () => {
  const env = makeEnv();
  const { status, error } = await proofError(env, "identity");
  assert.equal(status, 400, "/api/proof?log=identity must be refused");
  assert.equal(error, "log must be one of: identity_events, ledger", "no mapping hint for a name attest does not use");
});
