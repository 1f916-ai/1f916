// GET /api/provenance, /api/official and /api/stats must refuse a query
// parameter they do not read, the way /api/checkpoint and /api/docket already
// do.
//
// The defect (measured live 2026-10-06): three adjacent one-line handlers in
// src/index.ts sit between guarded routes and take no parameters, but no
// checkQueryParams call runs in front of them and no QUERY_PARAMS entry
// declares them. A call with ?limit=5&foo=bar served byte-identical 200s
// (2514 / 19363 / 27283 bytes) to the bare call on all three. That is the
// accepted-and-ignored family: a client that reads ?limit= off the URL it
// sent cannot tell a served page from a full unfiltered one, and /openapi.json
// publishes no parameters for these paths while serving no 400 either, so the
// manifest and the router agree on the wrong thing together.
//
// KILLING MUTATION: delete the three checkQueryParams lines from src/index.ts.
// The 400 cases below then return 200 with the ordinary page, so
// res.status === 400 fails and the test goes red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.ts";
import type { Env } from "../src/society.ts";
import { QUERY_PARAMS } from "../src/query-params.ts";

const ORIGIN = "https://1f916.ai";
const ROUTES = ["/api/provenance", "/api/official", "/api/stats"] as const;

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

for (const route of ROUTES) {
  test(`GET ${route} refuses a parameter it does not read`, async () => {
    const env = makeEnv();
    for (const q of ["limit=5", "limit=abc", "since=1", "foo=bar"]) {
      const res = await worker.fetch(new Request(`${ORIGIN}${route}?${q}`), env);
      assert.equal(res.status, 400, `${route}?${q} must be refused, not accepted-and-ignored`);
      const body = (await res.json()) as { error?: string };
      assert.match(body.error ?? "", new RegExp(route.replace(/\//g, "\\/")), "the refusal names the route");
      assert.match(body.error ?? "", /takes no query parameters/, "and says the route takes none");
    }
  });

  test(`GET ${route} with no parameters is not param-refused`, async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request(`${ORIGIN}${route}`), env);
    assert.notEqual(res.status, 400, "a call with no parameters must not be refused for a parameter");
    const text = await res.text();
    assert.doesNotMatch(text, /takes no query parameters/, "the no-parameter path is not the param refusal");
  });
}

test("the three doors are declared empty in QUERY_PARAMS", () => {
  for (const route of ROUTES) {
    assert.deepEqual([...QUERY_PARAMS[route]], [], `${route} is guarded and takes nothing`);
  }
});
