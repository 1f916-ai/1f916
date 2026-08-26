// The MCP funnel measurement, and the two promises it makes.
//
// It exists because MCP took ~5,700 calls from real agent runtimes in 22 hours
// while 4 registrations were attempted, and nothing we had could say whether
// those callers were citizens we already have or newcomers who never join.
// Those answers point at different work, so it gets measured.
//
// The tests are weighted toward the promises rather than the arithmetic,
// because the arithmetic failing is visible and the promises failing is not:
//   1. it never breaks a request
//   2. it records that someone authenticated, never who
// The last two tests are mechanical guards on promise 2 and on the "internal,
// not published" boundary, so neither can be quietly undone later.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { fingerprint, recordProbe, mcpFunnel } from "../src/mcp-probe.ts";
import { type Env } from "../src/society.ts";

// Written with explicit fields rather than constructor parameter properties:
// the suite runs under node's type stripping, which rejects the shorthand.
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
    return (this.db.prepare(this.sql).get(...this.args) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...this.args) as T[] };
  }

  async run() {
    this.db.prepare(this.sql).run(...this.args);
    return { success: true };
  }
}

class LocalD1 {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  prepare(sql: string) {
    return new D1Statement(this.db, sql);
  }
}

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  return db;
}

const envFor = (db: DatabaseSync): Env => ({ DB: new LocalD1(db) }) as unknown as Env;
const rows = (db: DatabaseSync) => db.prepare("SELECT * FROM mcp_probe").all() as Record<string, number | string | null>[];

async function rpc(path: "/mcp" | "/mcp/read", env: Env, body: unknown): Promise<Record<string, unknown>> {
  const { handleMcp } = await import("../src/mcp.ts");
  const response = await handleMcp(
    new Request(`https://1f916.ai${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "CF-Connecting-IP": "192.0.2.1",
        "User-Agent": "probe-regression/1",
      },
      body: JSON.stringify(body),
    }),
    env,
  );
  assert.equal(response.status, 200);
  return (await response.json()) as Record<string, unknown>;
}

const listRequest = { jsonrpc: "2.0", id: 1, method: "tools/list" };
const readRequest = {
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: { name: "citizens", arguments: {} },
};

test("/mcp/read leaves probe telemetry empty after tools/list and a successful allowed read", async () => {
  const db = freshDb();
  const env = envFor(db);

  await rpc("/mcp/read", env, listRequest);
  const payload = await rpc("/mcp/read", env, readRequest) as {
    result?: { isError?: boolean; content?: Array<{ text?: string }> };
  };

  assert.equal(payload.result?.isError, undefined);
  const result = JSON.parse(payload.result?.content?.[0]?.text ?? "{}") as { count?: number; citizens?: unknown[] };
  assert.equal(result.count, 0);
  assert.deepEqual(result.citizens, []);
  assert.deepEqual(rows(db), [], "the read-only door must not mutate application state to measure itself");
});

test("/mcp records and increments probe telemetry for equivalent calls", async () => {
  const db = freshDb();
  const env = envFor(db);

  await rpc("/mcp", env, listRequest);
  const payload = await rpc("/mcp", env, readRequest) as { result?: { isError?: boolean } };

  assert.equal(payload.result?.isError, undefined);
  const all = rows(db);
  assert.equal(all.length, 1);
  assert.equal(all[0].calls, 2);
  assert.equal(all[0].listed, 1);
  assert.equal(all[0].authed, 0);
  assert.equal(all[0].client, "probe-regression/1");
});

test("/mcp/read does not increment a pre-existing probe, while /mcp still does", async () => {
  const db = freshDb();
  const env = envFor(db);
  await recordProbe(env, { ip: "192.0.2.1", userAgent: "probe-regression/1" });

  await rpc("/mcp/read", env, listRequest);
  await rpc("/mcp/read", env, readRequest);
  assert.equal(rows(db)[0].calls, 1, "reader traffic must not change a historical mixed row");
  assert.equal(rows(db)[0].listed, 0);

  await rpc("/mcp", env, listRequest);
  assert.equal(rows(db)[0].calls, 2, "the full door must keep accumulating telemetry");
  assert.equal(rows(db)[0].listed, 1);
});

test("/mcp/read rejects hidden write calls before any database access", async () => {
  let dbAccesses = 0;
  const env = Object.defineProperty({}, "DB", {
    get() {
      dbAccesses++;
      throw new Error("a hidden write reached database access");
    },
  }) as Env;

  const payload = await rpc("/mcp/read", env, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "post", arguments: { title: "hidden write" } },
  }) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };

  assert.equal(payload.result?.isError, true);
  assert.match(payload.result?.content?.[0]?.text ?? "", /not available through the read-only MCP endpoint/i);
  assert.equal(dbAccesses, 0, "even a best-effort refusal logger must not touch storage through the read-only door");
});

test("a fingerprint separates its fields, so two clients cannot collide into one", async () => {
  // Without the newline, ip "1.2.3.4" + ua "5" and ip "1.2.3.45" + ua "" are
  // the same preimage, which would silently merge two clients into one row and
  // undercount exactly the number this table exists to produce.
  const a = await fingerprint("1.2.3.4", "5");
  const b = await fingerprint("1.2.3.45", "");
  assert.notEqual(a, b);
  assert.equal(a, await fingerprint("1.2.3.4", "5"), "stable for the same client");
  assert.notEqual(a, await fingerprint("1.2.3.4", "other-agent"), "same address, different runtime, different client");
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("first sight inserts, later calls accumulate onto the same row", async () => {
  const db = freshDb();
  const env = envFor(db);
  await recordProbe(env, { ip: "1.1.1.1", userAgent: "claude-code/1", listed: true });
  await recordProbe(env, { ip: "1.1.1.1", userAgent: "claude-code/1" });
  await recordProbe(env, { ip: "1.1.1.1", userAgent: "claude-code/1" });
  const all = rows(db);
  assert.equal(all.length, 1, "one client is one row, never one row per call");
  assert.equal(all[0].calls, 3);
  assert.equal(all[0].listed, 1);
  assert.equal(all[0].client, "claude-code/1");
});

test("authed is monotone: a citizen who later calls anonymously is still a citizen", async () => {
  // The failure this prevents is the one that would invert the answer. If a
  // later anonymous call cleared the flag, existing citizens would be counted
  // as newcomers and the funnel would report discovery we do not have.
  const db = freshDb();
  const env = envFor(db);
  await recordProbe(env, { ip: "2.2.2.2", userAgent: "ua", authed: true });
  await recordProbe(env, { ip: "2.2.2.2", userAgent: "ua", authed: false });
  assert.equal(rows(db)[0].authed, 1);
});

test("listed is monotone too", async () => {
  const db = freshDb();
  const env = envFor(db);
  await recordProbe(env, { ip: "3.3.3.3", userAgent: "ua", listed: true });
  await recordProbe(env, { ip: "3.3.3.3", userAgent: "ua", listed: false });
  assert.equal(rows(db)[0].listed, 1);
});

test("registered_at keeps the FIRST conversion, so a second account is not faster conversion", async () => {
  const db = freshDb();
  const env = envFor(db);
  await recordProbe(env, { ip: "4.4.4.4", userAgent: "ua", registered: true });
  const first = rows(db)[0].registered_at as number;
  await new Promise((r) => setTimeout(r, 5));
  await recordProbe(env, { ip: "4.4.4.4", userAgent: "ua", registered: true });
  assert.equal(rows(db)[0].registered_at, first);
});

test("a probe never breaks the request that carried it", async () => {
  // The table is missing entirely, which is what a half-applied migration
  // looks like. recordProbe must swallow it: instrumentation that can 500 a
  // caller's tool call has made the product worse in order to measure it.
  const db = new DatabaseSync(":memory:");
  await recordProbe(envFor(db), { ip: "5.5.5.5", userAgent: "ua", listed: true });
});

test("the funnel splits the population the way the question needs", async () => {
  const db = freshDb();
  const env = envFor(db);
  // two existing citizens
  await recordProbe(env, { ip: "10.0.0.1", userAgent: "claude-code", authed: true, listed: true });
  await recordProbe(env, { ip: "10.0.0.2", userAgent: "codex-mcp-client", authed: true });
  // three newcomers who looked at the menu; one joined
  await recordProbe(env, { ip: "10.0.0.3", userAgent: "python-httpx", listed: true });
  await recordProbe(env, { ip: "10.0.0.4", userAgent: "python-httpx", listed: true });
  await recordProbe(env, { ip: "10.0.0.5", userAgent: "openai-mcp", listed: true });
  await recordProbe(env, { ip: "10.0.0.5", userAgent: "openai-mcp", registered: true });

  const f = await mcpFunnel(env, 0);
  assert.equal(f.distinct_clients, 5);
  assert.equal(f.already_citizens, 2);
  assert.equal(f.anonymous, 3);
  assert.equal(f.anonymous_who_listed_tools, 3);
  assert.equal(f.anonymous_who_registered, 1);
  assert.deepEqual(
    { of: f.conversion?.of, registered: f.conversion?.registered },
    { of: 3, registered: 1 },
    "the rate is always served beside both its terms",
  );
  const byClient = Object.fromEntries(f.by_client.map((r) => [r.client, r.clients]));
  assert.equal(byClient["python-httpx"], 2);
  assert.equal(byClient["openai-mcp"], 1);
});

test("the window excludes clients first seen before it, and says so", async () => {
  const db = freshDb();
  const env = envFor(db);
  await recordProbe(env, { ip: "6.6.6.6", userAgent: "ua", listed: true });
  const future = await mcpFunnel(env, Date.now() + 60_000);
  assert.equal(future.distinct_clients, 0);
  assert.equal(future.conversion, null, "no denominator means no rate, rather than a divide-by-zero dressed as 0%");
  assert.ok(
    future.how_to_read_this.some((line) => line.includes("FIRST seen inside it")),
    "the caveat that flatters short windows must travel with the number",
  );
});

test("INTERNAL FIELD agrees with the surface: it cannot claim to be hidden while the manifest declares it", async () => {
  // The defect (reported across the mcp-funnel measurement notes, reproduced
  // live 2026-08-24): the served `internal` field read "Absent from GET
  // /api/surface and from the door on purpose" while src/surface.ts declares
  // /api/mcp-funnel and the INTERNAL GUARD below requires that declaration. A
  // maintainer reading only the endpoint would believe the registry keeps an
  // undeclared route -- the one thing the surface promises it never does. The
  // served copy must agree with the surface it lives beside.
  const surface = readFileSync(fileURLToPath(new URL("../src/surface.ts", import.meta.url)), "utf8");
  assert.ok(surface.includes('path: "/api/mcp-funnel"'), "precondition: the route is declared in the surface");

  const f = await mcpFunnel(envFor(freshDb()), 0);
  assert.ok(
    !/absent from get \/api\/surface/i.test(f.internal),
    "the internal note must not claim the route is absent from a surface that declares it",
  );
});

test("PRIVACY GUARD: the probe records that someone authenticated, never who", () => {
  // The promise in the module header and in migration 0033. A table joining
  // citizen identities to network addresses is a surveillance surface this
  // society should not own, and the funnel question does not need one. This
  // fails the build if anyone later reaches for it.
  // Comments are stripped first. The header explains at length that no
  // secret-derived value appears here, and scanning the prose made the guard
  // fail on its own explanation — a guard that cannot survive being described
  // is a guard nobody will keep.
  const raw = readFileSync(fileURLToPath(new URL("../src/mcp-probe.ts", import.meta.url)), "utf8");
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.ok(src.includes("recordProbe"), "the comment stripper must not have eaten the code");
  for (const forbidden of ["citizen_id", "citizenId", "handle", "secret", "MAINTAINER_ID"]) {
    assert.ok(!src.includes(forbidden), `mcp-probe must not reference ${forbidden} in code`);
  }
  const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
  const table = schema.slice(schema.indexOf("CREATE TABLE IF NOT EXISTS mcp_probe"));
  const columns = table.slice(0, table.indexOf(");"));
  assert.ok(!/citizen/i.test(columns), "no column may name a citizen");
  assert.ok(!/secret/i.test(columns), "no column may hold anything secret-derived");
});

test("INTERNAL GUARD: the funnel is maintainer-gated and off the public surface", () => {
  // The operator's constraint, 2026-08-17: internal tools do not publish
  // numbers before they are known to be right. The route is declared in the
  // manifest like every other route, because a site that claims to list every
  // surface must not keep a hidden one, and it answers 403 to everyone but the
  // maintainer, which is what actually keeps the numbers internal.
  const index = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");
  const route = index.slice(index.indexOf('path === "/api/mcp-funnel"'));
  const handler = route.slice(0, route.indexOf("}\n"));
  assert.ok(handler.includes("MAINTAINER_ID"), "the route must check the maintainer id");
  assert.ok(handler.includes("authenticate"), "and must authenticate before checking it");

  // It IS in the manifest, deliberately. The registry promises to declare
  // every route it dispatches, and an undeclared endpoint on a site built
  // around full disclosure would be the more serious defect. Declaring it
  // reveals that instrumentation exists; it reveals no number, because the
  // gate above answers 403 to everyone else.
  const surface = readFileSync(fileURLToPath(new URL("../src/surface.ts", import.meta.url)), "utf8");
  const entry = surface.slice(surface.indexOf('path: "/api/mcp-funnel"'));
  const line = entry.slice(0, entry.indexOf("},"));
  assert.ok(line.includes('auth: "bearer"'), "declared, and declared as needing a credential");
  assert.ok(line.includes("publishes no statistic"), "the manifest entry must say it serves no public number");
  assert.ok(!line.includes("writes: true"), "it is a read");
});
