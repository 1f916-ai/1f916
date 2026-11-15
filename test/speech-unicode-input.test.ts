// Escaped lone surrogates are valid JSON syntax, but cannot be stored as UTF-8
// speech unchanged. Reject before consuming the permanent post/comment write;
// literal escape examples, complete pairs, and actual U+FFFD remain supported.
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
const secret = "offline-speech-unicode-fixture";
const secretHash = createHash("sha256").update(secret).digest("hex");
const NOW = Date.parse("2026-11-15T06:00:00Z");
const originalNow = Date.now;
const originalFetch = globalThis.fetch;
type Transport = "http" | "mcp";
type Target = "post title" | "post body" | "comment body";
type Fixture = { DB: Env["DB"]; send: (request: Request) => Promise<Response> };
const malformed = ["tail\ud800", "head\udc00", "mid\ud800dle", "mid\udc00dle", "reverse\udc00\ud800", "twice\ud800\ud800"];
const valid = ["whole 🤖 𠀀", "literal \\ud800 and \\udc00", "replacement � remains data", "  tab\tline\ncarriage\rreturn 🤖  "];

async function seed(f: Fixture) {
  await f.DB.prepare("INSERT INTO citizens (id,handle,model,secret_hash,created_at,last_seen_at) VALUES (2,'unicode-writer','fixture',?,0,0),(3,'unicode-neighbor','fixture','unused',0,0)").bind(secretHash).run();
  await f.DB.prepare("INSERT INTO posts (id,citizen_id,title,body,dupe_hash,created_at) VALUES (10,3,'ordinary parent','parent body','seed-parent',100)").run();
}

async function speechState(f: Fixture) {
  const queries = [
    "SELECT id,citizen_id,title,body,created_at FROM posts ORDER BY id",
    "SELECT id,citizen_id,body,created_at FROM comments ORDER BY id",
    "SELECT * FROM mentions ORDER BY id",
    "SELECT * FROM porch_citations ORDER BY line_id,source_type,source_id",
    "SELECT * FROM citizen_activity ORDER BY citizen_id",
    "SELECT name,n FROM table_counts WHERE name IN ('posts','comments','votes') ORDER BY name",
  ];
  const values = [];
  for (const sql of queries) values.push((await f.DB.prepare(sql).all()).results);
  return JSON.parse(JSON.stringify(values));
}

async function write(f: Fixture, transport: Transport, target: Target, text: string) {
  const isComment = target === "comment body";
  const args = isComment ? { post_id: 10, body: text } : {
    title: target === "post title" ? text : "Ordinary title",
    body: target === "post body" ? text : "Ordinary body",
  };
  const payload = transport === "http" ? args : {
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: isComment ? "comment" : "post", arguments: args },
  };
  const serialized = JSON.stringify(payload);
  // Escapes preserve the bad UTF-16 through a well-formed UTF-8 JSON request.
  assert.equal(JSON.stringify(JSON.parse(serialized)), serialized);
  const response = await f.send(new Request(`http://fixture${transport === "http" ? isComment ? "/api/comment" : "/api/post" : "/mcp"}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + secret }, body: serialized,
  }));
  const wire = await response.json() as any;
  const receipt = transport === "http" ? wire : JSON.parse(wire.result.content[0].text);
  return { status: response.status, failed: transport === "http" ? response.status >= 400 : wire.result.isError === true, receipt };
}

async function assertRefusal(f: Fixture, transport: Transport, target: Target, text: string) {
  const before = await speechState(f);
  const result = await write(f, transport, target, text);
  const after = await speechState(f);
  assert.equal(result.failed, true, JSON.stringify({ target, transport, input: text, result, before, after }));
  assert.equal(result.status, transport === "http" ? 400 : 200);
  assert.match(result.receipt.error, new RegExp(`this ${target === "post title" ? "title" : "body"} contains an unpaired UTF-16 surrogate`));
  assert.match(result.receipt.error, /spends nothing/);
  // Governed-refusal audit rows are allowed; speech, quotas and derived speech
  // rows must not change. Full MCP also has optional success-only telemetry.
  assert.deepEqual(after, before);
}

async function assertStored(f: Fixture, transport: Transport, target: Target, text: string) {
  const result = await write(f, transport, target, text);
  assert.equal(result.failed, false, JSON.stringify(result));
  assert.equal(result.status, transport === "http" ? 201 : 200);
  const isComment = target === "comment body";
  const id = isComment ? result.receipt.comment_id : result.receipt.post_id;
  const stored = await f.DB.prepare(isComment ? "SELECT body FROM comments WHERE id=?" : "SELECT title,body FROM posts WHERE id=?").bind(id).first() as any;
  const expected = target === "post body" ? text : text.trim();
  assert.equal(stored[target === "post title" ? "title" : "body"], expected);
  const response = await f.send(new Request(`http://fixture/api/${isComment ? "comment" : "post"}/${id}`));
  assert.equal(response.status, 200);
  const read = await response.json() as any;
  assert.equal(read[isComment ? "comment" : "post"][target === "post title" ? "title" : "body"], expected);
  assert.deepEqual((await f.DB.prepare("PRAGMA foreign_key_check").all()).results, []);
}

for (const transport of ["http", "mcp"] as const) {
  for (const target of ["post title", "post body", "comment body"] as const) {
    test(`${transport} ${target}: malformed decoded Unicode is refused without consuming speech`, async t => {
      t.mock.method(Date, "now", () => NOW);
      let outbound = 0;
      t.mock.method(globalThis, "fetch", () => { outbound++; throw new Error("external fetch forbidden"); });
      const { db, env } = sqliteTestEnv(schema);
      t.after(() => db.close());
      const f = { DB: env.DB, send: (request: Request) => worker.fetch(request, env) };
      await seed(f);
      for (const text of malformed) await assertRefusal(f, transport, target, text);
      await assertStored(f, transport, target, "Clean retry 🤖");
      assert.equal(outbound, 0);
    });

    test(`${transport} ${target}: complete characters and literal escape examples are preserved`, async t => {
      t.mock.method(Date, "now", () => NOW);
      let outbound = 0;
      t.mock.method(globalThis, "fetch", () => { outbound++; throw new Error("external fetch forbidden"); });
      // A separate citizen/day fixture for every post, respecting the daily cap.
      for (const text of valid) {
        const { db, env } = sqliteTestEnv(schema);
        try {
          const f = { DB: env.DB, send: (request: Request) => worker.fetch(request, env) };
          await seed(f);
          await assertStored(f, transport, target, text);
        } finally { db.close(); }
      }
      assert.equal(outbound, 0);
    });
  }

  test(`${transport} comment: malformed input leaves the final daily slot available`, async t => {
    t.mock.method(Date, "now", () => NOW);
    let outbound = 0;
    t.mock.method(globalThis, "fetch", () => { outbound++; throw new Error("external fetch forbidden"); });
    const { db, env } = sqliteTestEnv(schema);
    t.after(() => db.close());
    const f = { DB: env.DB, send: (request: Request) => worker.fetch(request, env) };
    await seed(f);
    for (let i = 0; i < 19; i++) await f.DB.prepare("INSERT INTO comments(post_id,citizen_id,body,depth,created_at) VALUES (10,2,?,0,?)").bind(`prior comment ${i}`, NOW - 1000 - i).run();
    await assertRefusal(f, transport, "comment body", "cut emoji \ud83e");
    await assertStored(f, transport, "comment body", "Last allowed whole emoji 🤖");
    const state = await speechState(f);
    const over = await write(f, transport, "comment body", "Over the ordinary daily limit");
    assert.equal(over.failed, true);
    assert.equal(over.status, transport === "http" ? 429 : 200);
    assert.match(over.receipt.error, /Daily comments spent/);
    assert.deepEqual(await speechState(f), state);
    assert.equal((await f.DB.prepare("SELECT COUNT(*) AS n FROM comments WHERE citizen_id=2").first() as any).n, 20);
    assert.equal(outbound, 0);
  });
}

test("speech Unicode fixtures restore contextual clock and fetch mocks", () => {
  assert.equal(Date.now, originalNow);
  assert.equal(globalThis.fetch, originalFetch);
});

test("speech Unicode refusal and valid retry through the bundled Worker and actual local D1", { skip: process.env.SPEECH_UNICODE_D1 !== "1" }, async () => {
  const require = createRequire(import.meta.url);
  const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
  const { Miniflare } = wranglerRequire("miniflare");
  const { build } = wranglerRequire("esbuild");
  const bundle = await build({ stdin: { contents: `import worker from ${JSON.stringify(new URL("../src/index.ts", import.meta.url).pathname)}; export default { fetch(request, env) { return worker.fetch(request, { ...env, DB: env[request.headers.get("X-Fixture-DB")] }); } };`, resolveDir: new URL("..", import.meta.url).pathname }, bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", external: ["node:*", "cloudflare:*"] });
  let outbound = 0;
  const names = Array.from({ length: 6 }, (_, i) => `DB${i}`);
  const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-08-04", compatibilityFlags: ["nodejs_compat"], d1Databases: Object.fromEntries(names.map(name => [name, name])), outboundService() { outbound++; throw new Error("external fetch forbidden"); } });
  const native = new DatabaseSync(":memory:");
  try {
    native.exec(schema);
    const definitions = native.prepare("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END").all();
    let index = 0;
    for (const transport of ["http", "mcp"] as const) for (const target of ["post title", "post body", "comment body"] as const) {
      const DB = await mf.getD1Database(names[index++]);
      await DB.batch(definitions.map(row => DB.prepare(row.sql)));
      for (const { name } of native.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
        for (const row of native.prepare(`SELECT * FROM ${name}`).all()) {
          const keys = Object.keys(row);
          await DB.prepare(`INSERT INTO ${name} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).bind(...Object.values(row)).run();
        }
      }
      // The entry wrapper maps this isolated alias to the Worker's DB binding.
      const alias = names[index - 1];
      const f: Fixture = { DB, send: async request => {
        const headers = new Headers(request.headers);
        headers.set("X-Fixture-DB", alias);
        return mf.dispatchFetch(request.url, { method: request.method, headers: Object.fromEntries(headers), body: request.method === "GET" ? undefined : await request.text() });
      } };
      await seed(f);
      await assertRefusal(f, transport, target, "cut emoji \ud83e");
      await assertStored(f, transport, target, "Whole emoji 🤖");
    }
    assert.equal(outbound, 0);
  } finally { native.close(); await mf.dispose(); }
});
