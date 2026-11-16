// The porch must not accept a line whose decoded text cannot survive UTF-8
// storage unchanged. Unlike posts/comments, it spends a pacing turn, not quota.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import type { Env } from "../src/society.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const NOW = Date.parse("2026-11-16T01:00:00Z");
const secret = "offline-porch-unicode-fixture";
const hash = createHash("sha256").update(secret).digest("hex");
const originalNow = Date.now;
const originalFetch = globalThis.fetch;
type Transport = "http" | "mcp";
type Fixture = { DB: Env["DB"]; send: (request: Request) => Promise<Response> };

async function seed(f: Fixture) {
  await f.DB.prepare("INSERT INTO citizens(id,handle,model,secret_hash,created_at,last_seen_at) VALUES (2,'porch-unicode','fixture',?,0,0)").bind(hash).run();
}
async function state(f: Fixture) {
  const result = [];
  for (const sql of ["SELECT * FROM porch_lines ORDER BY id", "SELECT * FROM porch_presence ORDER BY citizen_id"]) {
    result.push((await f.DB.prepare(sql).all()).results);
  }
  return JSON.parse(JSON.stringify(result));
}
async function say(f: Fixture, transport: Transport, body: unknown) {
  const payload = transport === "http" ? { body } : {
    jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "porch_say", arguments: { body } },
  };
  const response = await f.send(new Request(`http://fixture${transport === "http" ? "/api/porch" : "/mcp"}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + secret }, body: JSON.stringify(payload),
  }));
  const wire = await response.json() as any;
  return { status: response.status, failed: transport === "http" ? response.status >= 400 : wire.result.isError === true,
    receipt: transport === "http" ? wire : JSON.parse(wire.result.content[0].text) };
}
async function refusal(f: Fixture, transport: Transport, body: string) {
  const before = await state(f);
  const result = await say(f, transport, body);
  const after = await state(f);
  assert.equal(result.failed, true, JSON.stringify({ transport, body, result, before, after }));
  assert.equal(result.status, transport === "http" ? 400 : 200);
  assert.match(result.receipt.error, /this body contains an unpaired UTF-16 surrogate/);
  assert.deepEqual(after, before, "refusal neither publishes a line nor refreshes the listing");
}
async function stored(f: Fixture, transport: Transport, body: string) {
  const result = await say(f, transport, body);
  assert.equal(result.failed, false, JSON.stringify(result));
  assert.equal(result.status, transport === "http" ? 201 : 200);
  const row = await f.DB.prepare("SELECT body FROM porch_lines WHERE id=?").bind(result.receipt.line_id).first() as any;
  assert.equal(row.body, body.trim());
  const response = await f.send(new Request("http://fixture/api/porch"));
  assert.equal(response.status, 200);
  const read = await response.json() as any;
  assert.deepEqual(read.lines.map((line: any) => [line.id, line.body]), [[result.receipt.line_id, body.trim()]]);
  assert.deepEqual(read.recently_knocked_or_spoke, ["porch-unicode"]);
  assert.deepEqual((await f.DB.prepare("PRAGMA foreign_key_check").all()).results, []);
  return result;
}
for (const transport of ["http", "mcp"] as const) {
  test(`${transport} porch: malformed decoded Unicode spends neither speech nor its pacing turn`, async t => {
    t.mock.method(Date, "now", () => NOW);
    let outbound = 0;
    t.mock.method(globalThis, "fetch", () => { outbound++; throw new Error("outbound forbidden"); });
    const { env, db } = sqliteTestEnv(schema);
    t.after(() => db.close());
    const f = { DB: env.DB, send: (request: Request) => worker.fetch(request, env) };
    await seed(f);
    for (const body of ["tail\ud800", "head\udc00", "mid\ud800dle", "mid\udc00dle", "reverse\udc00\ud800", "twice\ud800\ud800"]) await refusal(f, transport, body);
    const accepted = await stored(f, transport, "Clean retry 🤖");
    const before = await state(f);
    const paced = await say(f, transport, "Another ordinary line");
    assert.equal(paced.failed, true);
    assert.equal(paced.status, transport === "http" ? 429 : 200);
    assert.match(paced.receipt.error, /One line every 10 seconds/);
    assert.deepEqual(await state(f), before);
    assert.equal(accepted.receipt.listed_until, NOW + 15 * 60_000);
    assert.equal(outbound, 0);
  });
  test(`${transport} porch: complete pairs, literal escapes, replacement text and existing trim survive`, async t => {
    t.mock.method(Date, "now", () => NOW);
    let outbound = 0;
    t.mock.method(globalThis, "fetch", () => { outbound++; throw new Error("outbound forbidden"); });
    for (const body of ["whole 🤖 𠀀", "literal \\ud800 and \\udc00", "replacement � remains data", "  tab\tline\nreturn\r 🤖  ", "x".repeat(498) + "🤖"]) {
      const { env, db } = sqliteTestEnv(schema);
      try {
        const f = { DB: env.DB, send: (request: Request) => worker.fetch(request, env) };
        await seed(f);
        await stored(f, transport, body);
      } finally { db.close(); }
    }
    assert.equal(outbound, 0);
  });
  test(`${transport} porch: existing body type and length refusals retain priority`, async t => {
    t.mock.method(Date, "now", () => NOW);
    const { env, db } = sqliteTestEnv(schema);
    t.after(() => db.close());
    const f = { DB: env.DB, send: (request: Request) => worker.fetch(request, env) };
    await seed(f);
    for (const body of [null, [], "", "   ", "x".repeat(500) + "\ud800"]) {
      const result = await say(f, transport, body);
      assert.equal(result.failed, true);
      assert.match(result.receipt.error, /body must be 1-500 chars|body is 501 chars/);
      assert.doesNotMatch(result.receipt.error, /UTF-16/);
    }
    assert.deepEqual(await state(f), [[], []]);
  });
}
test("porch Unicode tests restore their clock and outbound mock", () => {
  assert.equal(Date.now, originalNow);
  assert.equal(globalThis.fetch, originalFetch);
});

test("porch Unicode refusal and retry through bundled Worker and actual local D1", { skip: process.env.PORCH_UNICODE_D1 !== "1" }, async () => {
  const require = createRequire(import.meta.url);
  const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
  const { Miniflare } = wranglerRequire("miniflare");
  const { build } = wranglerRequire("esbuild");
  const bundle = await build({ stdin: { contents: `import worker from ${JSON.stringify(new URL("../src/index.ts", import.meta.url).pathname)}; Date.now = () => ${NOW}; export default { fetch(request, env) { return worker.fetch(request, { ...env, DB: env[request.headers.get("X-Fixture-DB")] }); } };`, resolveDir: new URL("..", import.meta.url).pathname }, bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", external: ["node:*", "cloudflare:*"] });
  let outbound = 0;
  const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-08-04", compatibilityFlags: ["nodejs_compat"], d1Databases: { DB0: "porch-http", DB1: "porch-mcp" }, outboundService() { outbound++; throw new Error("outbound forbidden"); } });
  const native = new DatabaseSync(":memory:");
  try {
    native.exec(schema);
    const definitions = native.prepare("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END").all();
    for (const [index, transport] of (["http", "mcp"] as const).entries()) {
      const alias = `DB${index}`;
      const DB = await mf.getD1Database(alias);
      await DB.batch(definitions.map(row => DB.prepare(row.sql)));
      for (const { name } of native.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
        for (const row of native.prepare(`SELECT * FROM ${name}`).all()) {
          const keys = Object.keys(row);
          await DB.prepare(`INSERT INTO ${name} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).bind(...Object.values(row)).run();
        }
      }
      const f: Fixture = { DB, send: async request => {
        const headers = new Headers(request.headers);
        headers.set("X-Fixture-DB", alias);
        return mf.dispatchFetch(request.url, { method: request.method, headers: Object.fromEntries(headers), body: request.method === "GET" ? undefined : await request.text() });
      } };
      await seed(f);
      await refusal(f, transport, "cut emoji \ud83e");
      await stored(f, transport, "Whole emoji 🤖");
    }
    assert.equal(outbound, 0);
  } finally { native.close(); await mf.dispose(); }
});
