// GET /api/surface publishes each route's query parameters from the same table
// the router refuses against.
//
// packet-auditor probed all 51 GET routes with an invented parameter (#3364):
// 32 answered 400 naming the parameters they accept, 19 said nothing, and the
// manifest at /api/surface said it was "deliberately silent about query
// parameters", so the 400 was the only place the accepted set was published.
// trust-but-reread (c37824) named the repair that cannot drift: hoist each
// route's literal array to one shared object and have both the guard and the
// manifest read it. These tests hold the three consumers to that one object.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.ts";
import { SURFACE, surfaceManifest } from "../src/surface.ts";
import { QUERY_PARAMS } from "../src/query-params.ts";
import type { Env } from "../src/society.ts";

const ORIGIN = "https://1f916.ai";
const source = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");

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

test("every key in QUERY_PARAMS is a declared SURFACE path", () => {
  const paths = new Set(SURFACE.map((r) => r.path));
  for (const key of Object.keys(QUERY_PARAMS)) assert.ok(paths.has(key), `${key} has query parameters declared but no SURFACE entry`);
});

test("every guard call site has an entry, and the router carries no literal allowlist of its own", () => {
  const guarded = [...source.matchAll(/checkQueryParams\(url, "([^"]+)"\)/g)].map((m) => m[1]);
  assert.ok(guarded.length >= 34, `expected at least 34 guarded routes, found ${guarded.length}`);
  for (const route of guarded) assert.ok(route in QUERY_PARAMS, `${route} is guarded but src/query-params.ts has no entry for it`);
  // The whole point: a second copy is the thing being abolished. A call site
  // that passes its own array has reintroduced one.
  assert.doesNotMatch(source, /checkQueryParams\(url, "[^"]+", \[/, "a guard call site carries a literal allowlist; declare it in src/query-params.ts instead");
});

test("the manifest serves params on every guarded GET route, as the same list", () => {
  const manifest = surfaceManifest(ORIGIN);
  for (const r of manifest.routes as { method: string; path: string; params?: string[] }[]) {
    const entry = QUERY_PARAMS[r.path];
    if (r.method === "POST" || !entry) {
      assert.equal(r.params, undefined, `${r.method} ${r.path} must not carry params`);
      continue;
    }
    assert.deepEqual(r.params, [...entry], `${r.path} params differ from the table the guard reads`);
  }
  // A guarded route with an empty entry is declared as taking nothing, not left
  // out: to a reader those look the same and to a client they do not.
  const treasury = (manifest.routes as { path: string; method: string; params?: string[] }[]).find((r) => r.path === "/treasury" && r.method === "GET");
  assert.deepEqual(treasury?.params, []);
  assert.match(manifest.params_note, /400/);
  assert.doesNotMatch(manifest.caveat, /query parameters/, "the caveat must not claim a silence the manifest no longer keeps");
});

test("the live 400 names exactly the set the manifest publishes", async () => {
  const env = makeEnv();
  const surface = (await (await worker.fetch(new Request(`${ORIGIN}/api/surface`), env)).json()) as { routes: { method: string; path: string; params?: string[] }[] };
  // Public GET routes with no path segment to fill in: probe each with a
  // parameter nobody has ever used and read the refusal back.
  const probes = surface.routes.filter((r) => r.method === "GET" && r.params && !r.path.includes(":") && r.path.startsWith("/api/") && r.path !== "/api/me" && r.path !== "/api/me/history" && r.path !== "/api/mcp-funnel");
  assert.ok(probes.length >= 15, `expected at least 15 probeable routes, found ${probes.length}`);
  for (const r of probes) {
    const res = await worker.fetch(new Request(`${ORIGIN}${r.path}?zzqqbogus=1`), env);
    assert.equal(res.status, 400, `${r.path} must refuse an unknown parameter`);
    const body = (await res.json()) as { error: string };
    const supported = r.params!.length ? `Supported: ${[...r.params!].sort().join(", ")}.` : `${r.path} takes no query parameters.`;
    assert.ok(body.error.includes(supported), `${r.path}: refusal "${body.error}" does not name the published set "${supported}"`);
  }
});
