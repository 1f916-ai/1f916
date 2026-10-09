// GET /api/rail, /api/surface, /api/listings/guide and /api/listings/security
// must refuse a query parameter none of them reads, the way /api/docket and
// /api/checkpoint already do.
//
// The defect (probed live 2026-10-06): for each of the four routes,
//   GET <route>
//   GET <route>?limit=5&foo=bar
// returned 200 with bodies identical but for the `now` clock. None of the four
// reads the query string, so a caller who wrote /api/rail?limit=5 expecting a
// smaller census got the full rail dump with a confident 200: the
// accepted-and-ignored / no-400 family. The guard declares the route takes no
// query parameters and the 400 names it.
//
// KILLING MUTATION: delete the four checkQueryParams lines added to the GET
// handlers in src/index.ts. Each 400 case below then returns 200 with the real
// body, so res.status === 400 fails and the test goes red.

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
  async batch(stmts: Statement[]) { const out = []; for (const s of stmts) { out.push(await s.run()); } return out; }
}
function makeEnv(): Env {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  return { DB: new LocalD1(sqlite) } as unknown as Env;
}

const ROUTES = [
  "/api/rail",
  "/api/surface",
  "/api/listings/guide",
  "/api/listings/security",
] as const;

for (const route of ROUTES) {
  test(`GET ${route} refuses an unknown query parameter, naming the route`, async () => {
    const env = makeEnv();
    for (const q of ["limit=5", "foo=bar", "zqxjklmn=1"]) {
      const res = await worker.fetch(new Request(`${ORIGIN}${route}?${q}`), env);
      assert.equal(res.status, 400, `${route}?${q} must be refused, not accepted-and-ignored`);
      const body = (await res.json()) as { error?: string };
      assert.match(body.error ?? "", new RegExp(route.replace(/\//g, "\\/")), "the refusal names the route");
      assert.match(body.error ?? "", /takes no query parameters/, "and says the route takes none");
    }
  });

  test(`GET ${route} with no parameters is not param-refused`, async () => {
    // The guard runs before the handler, so this asserts its boundary: a
    // no-parameter call must pass through the param check. Whatever the
    // handler then does on an empty in-memory DB, it must never be the
    // query-parameter refusal.
    const env = makeEnv();
    const res = await worker.fetch(new Request(`${ORIGIN}${route}`), env);
    if (res.status === 400) {
      const body = (await res.json()) as { error?: string };
      assert.doesNotMatch(body.error ?? "", /takes no query parameters/, "the no-parameter path is not the param refusal");
    }
  });
}
