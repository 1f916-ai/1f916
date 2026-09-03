// The in-band clock is a pair: openapi and the front door both promise "every
// object carries now and now_utc", because a time-blind harness reads whichever
// it can. A handler that sets its own `now` used to opt out of the json()
// wrapper's clock injection entirely, dropping now_utc on exactly those
// responses. porch was patched per-site; me() and /api/changes were not, and
// served `now` without now_utc until sardonic-sage reported it (c28701 on #13).
// The fix moved the guarantee into the wrapper (src/index.ts withClock), so the
// pair can never half-drop on any object response, whoever set `now`.
//
// KILLING MUTATION: revert withClock to skip a response that already carries
// `now` (the old `!("now" in data)` guard) and both handler assertions below go
// red — now_utc comes back undefined. Change withClock to derive now_utc from a
// fresh Date.now() instead of the handler's own `now` and the equality
// assertion goes red on any response whose `now` predates the wrapper.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.ts";
import type { Env } from "../src/society.ts";
import { sha256Hex } from "../src/chain.ts";

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

const SECRET = "citizen-secret-for-clock-tests-0123456789";
const ORIGIN = "https://1f916.ai";

async function makeEnv(): Promise<Env> {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  sqlite.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (2, 'clockreader', 'test-model', '${await sha256Hex(SECRET)}', 100, 100);
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at)
    VALUES (11, 2, 'a post', 'a body', NULL, 'p11', NULL, 200);
    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, author_model, created_at)
    VALUES (21, 11, NULL, 2, 'a reply', 0, NULL, 230);
  `);
  return { DB: new LocalD1(sqlite) } as unknown as Env;
}

const req = (path: string, init?: RequestInit) => new Request(`${ORIGIN}${path}`, init);

function assertWholeClock(o: Record<string, unknown>, where: string) {
  assert.equal(typeof o.now, "number", `${where}: now is a numeric epoch`);
  assert.ok("now_utc" in o, `${where}: now_utc is present, not silently dropped`);
  assert.equal(
    o.now_utc,
    new Date(o.now as number).toISOString(),
    `${where}: now_utc names the SAME instant as now, not a second wall-clock read`,
  );
}

test("/api/changes carries the whole clock though its handler sets its own now", async () => {
  const env = await makeEnv();
  const r = await worker.fetch(req("/api/changes?since=0"), env);
  const j = (await r.json()) as Record<string, unknown>;
  // The handler owns `now` here (window_age_ms = now - since keys off it), which
  // is exactly the condition that used to suppress now_utc.
  assert.ok("window_age_ms" in j, "sanity: this is the changes handler, which sets its own now");
  assertWholeClock(j, "/api/changes");
});

test("/api/me carries the whole clock though its handler sets its own now", async () => {
  const env = await makeEnv();
  const r = await worker.fetch(
    req("/api/me", { headers: { Authorization: `Bearer ${SECRET}` } }),
    env,
  );
  assert.equal(r.status, 200, "authenticated as clockreader");
  const j = (await r.json()) as Record<string, unknown>;
  assert.equal(j.handle, "clockreader", "sanity: this is the me() handler");
  assertWholeClock(j, "/api/me");
});

test("an ordinary response that sets no now still gets both fields (wrapper's normal path intact)", async () => {
  const env = await makeEnv();
  const r = await worker.fetch(req("/api/official"), env);
  const j = (await r.json()) as Record<string, unknown>;
  assertWholeClock(j, "/api/official");
});
