// The two fixed-page directories must refuse a query parameter they do not
// read, the way /api/checkpoint, /api/events, /api/listings and every other
// guarded read route already do.
//
// The defect (probed live 2026-10-06): GET /api/tags?limit=0, ?limit=abc,
// ?limit=-1, ?limit=5 and ?foo=bar all returned the identical 1000-row page
// with a 200, and GET /api/witnesses?foo=bar did the same at 11 rows. Neither
// handler reads the query string at all (tagDirectory and listWitnesses take
// no arguments), and neither route called checkQueryParams, so the router's
// own rule — "a route missing from the table takes nothing, which refuses
// loudly rather than accepting silently" — did not apply: the route sat
// outside the table and outside the guard. /openapi.json publishes no
// parameters for either path, so a caller who believed ?limit= did something
// was never told otherwise; a caller counting on ?limit=5 to shrink a page
// silently got the full cap instead. The codebase's own accepted-and-ignored
// record (cursor-grok c8422 on /api/events, egress c63428 on /api/checkpoint)
// calls this worse than a refusal: a plausible page-one 200 forever.
//
// KILLING MUTATION: delete either checkQueryParams call from src/index.ts (or
// the matching QUERY_PARAMS entry — the coverage test then refuses the call
// site itself). Both 400 cases below go 200 and fail.
//
// Live facts measured 2026-10-06 21:2xZ against production:
//   GET /api/tags?limit=5          -> 200, count 1000 (not 5)
//   GET /api/tags?foo=bar          -> 200
//   GET /api/witnesses?foo=bar     -> 200, count 11

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

test("GET /api/tags refuses invented parameters, naming the route and its emptiness", async () => {
  const env = makeEnv();
  for (const q of ["limit=5", "limit=0", "limit=abc", "tag=witness", "zqxjklmn=1"]) {
    const res = await worker.fetch(new Request(`${ORIGIN}/api/tags?${q}`), env);
    assert.equal(res.status, 400, `/api/tags?${q} must be refused, not accepted-and-ignored`);
    const body = (await res.json()) as { error?: string };
    assert.match(body.error ?? "", /\/api\/tags/, "the refusal names the route");
    // The directory takes exactly one parameter since the keyset cursor
    // (test/tags-after-cursor.test.ts): the refusal names it as the whole set.
    assert.match(body.error ?? "", /Supported: after\./, "and names the one parameter the directory reads");
  }
});

test("GET /api/witnesses refuses invented parameters the same way", async () => {
  const env = makeEnv();
  for (const q of ["limit=5", "foo=bar", "zqxjklmn=1"]) {
    const res = await worker.fetch(new Request(`${ORIGIN}/api/witnesses?${q}`), env);
    assert.equal(res.status, 400, `/api/witnesses?${q} must be refused, not accepted-and-ignored`);
    const body = (await res.json()) as { error?: string };
    assert.match(body.error ?? "", /\/api\/witnesses/, "the refusal names the route");
  }
});

test("a no-parameter call to either directory is not param-refused", async () => {
  // Same boundary shape the checkpoint test pins: the guard runs before the
  // handler, so a clean call must pass the check (and may then fail deeper in
  // the handler on this empty database — anything but a parameter refusal).
  const env = makeEnv();
  for (const path of ["/api/tags", "/api/witnesses"]) {
    const res = await worker.fetch(new Request(`${ORIGIN}${path}`), env);
    assert.notEqual(res.status, 400, `${path} with no parameters must not be param-refused`);
    const body = (await res.json()) as { error?: string };
    assert.doesNotMatch(body.error ?? "", /takes no query parameters/, `${path}'s empty page is not the param refusal`);
  }
});
