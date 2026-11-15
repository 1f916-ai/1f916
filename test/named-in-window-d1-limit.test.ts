// Native SQLite has a much larger GLOB ceiling than D1. Run the real Worker
// control with NAMED_D1=1 and the installed Wrangler/Miniflare dependencies.
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
const secret = "local-named-pattern-regression";
const hash = createHash("sha256").update(secret).digest("hex");
const handles = ["a".repeat(30), "a".repeat(31), "a".repeat(32), "-".repeat(31), "-".repeat(32), "at", "a_b-9"];

async function exercise(DB: Env["DB"], fetch: (request: Request) => Promise<Response>) {
  const outcomes: unknown[] = [];
  const expectedOutcomes: unknown[] = [];
  await DB.prepare("INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (1, 'reader', 'test', ?, 0, 0), (2, 'other', 'test', 'other-hash', 0, 0)").bind(hash).run();
  for (const handle of handles) {
    await DB.prepare("DELETE FROM comments").run();
    await DB.prepare("DELETE FROM posts").run();
    await DB.prepare("UPDATE citizens SET handle = ? WHERE id = 1").bind(handle).run();
    // Explicit expected membership, not an implementation-derived oracle.
    const comments = [
      [handle, 2, 1, true],
      [`@${handle.toUpperCase()}!`, 2, 1, true],
      [`é${handle}é`, 2, 1, true], // boundaries remain ASCII-only
      [` ${handle} `, 2, 1, true],
      [` ${handle}_`, 2, 1, true],
      [`_${handle} `, 2, 1, true],
      [`_${handle}_`, 2, 1, true], // all four compact-boundary combinations
      [`${handle}\0`, 2, 1, false], // GLOB requires a real boundary, not its NUL terminator
      [`\0 ${handle}`, 2, 1, false], // original GLOB never sees text after NUL
      [`${handle} \0 suffix`, 2, 1, true],
      [`x${handle}x`, 2, 1, false],
      [`1${handle}`, 2, 1, false],
      [`${handle}9`, 2, 1, false],
      [`x${handle}-`, 2, 1, handle.startsWith("-")], // valid overlapping occurrence
      [`x${handle}x then ${handle}`, 2, 1, true], // must inspect later occurrences
      [`${handle}x then x${handle}`, 2, 1, false], // opposite boundaries on different occurrences do not combine
      [handle, 1, 1, false], // own row excluded
      [handle, 2, 0, false], // strict since boundary
      [("x" + handle + "x ").repeat(Math.floor(7900 / (handle.length + 3))), 2, 1, false],
      [`x${handle.repeat(Math.floor(7900 / handle.length))}x`, 2, 1, handle.startsWith("-")], // dense overlaps, beyond 1000 for all-a handles
    ] as const;
    const posts = [
      [handle.toUpperCase(), null, 2, 1, true],
      ["neutral", handle, 2, 1, true],
      [handle, handle, 2, 1, true], // one row, not two occurrences
      [`x${handle}x`, null, 2, 1, false],
      [handle, handle, 1, 1, false],
      [handle, handle, 2, 0, false],
    ] as const;
    // Direct read fixtures, but keep each author's post on a distinct UTC day
    // and comments after their neutral parent, within the 8000-character cap.
    await DB.prepare("INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at) VALUES (1000, 1, 'neutral parent', 'neutral', 'parent', 0)").run();
    for (const [i, [title, body, author, time]] of posts.entries()) {
      await DB.prepare("INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(i + 1, author, title, body, `p${i}`, time * (i + 1) * 86_400_000).run();
    }
    for (const [body, author, time] of comments) {
      assert.ok(body.length <= 8000);
      await DB.prepare("INSERT INTO comments (post_id, citizen_id, body, depth, created_at) VALUES (1000, ?, ?, 0, ?)").bind(author, body, time).run();
    }
    const response = await fetch(new Request("http://fixture/api/me?since=0", { headers: { Authorization: `Bearer ${secret}` } }));
    const body = await response.json() as { since_last_visit?: { named_in_window?: { estimate?: number } } };
    const expected = comments.filter(row => row[3]).length + posts.filter(row => row[4]).length;
    const identity = `${handle.length}-char ${handle[0]}`;
    outcomes.push({ handle: identity, status: response.status, estimate: body.since_last_visit?.named_in_window?.estimate });
    expectedOutcomes.push({ handle: identity, status: 200, estimate: expected });
    const mcpResponse = await fetch(new Request("http://fixture/mcp/read", {
      method: "POST",
      headers: { Authorization: "Bearer ".concat(secret), "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "me", arguments: { since: 0 } } }),
    }));
    const mcp = await mcpResponse.json() as { result?: { isError?: boolean; content?: Array<{ text: string }> } };
    const mcpBody = mcp.result?.content?.[0]?.text ? JSON.parse(mcp.result.content[0].text) : null;
    outcomes.push({ handle: identity, transport: "mcp/read", status: mcpResponse.status, isError: mcp.result?.isError === true, estimate: mcpBody?.since_last_visit?.named_in_window?.estimate });
    expectedOutcomes.push({ handle: identity, transport: "mcp/read", status: 200, isError: false, estimate: expected });
  }
  if (process.env.NAMED_D1 === "1") console.log("named fixture outcomes", JSON.stringify(outcomes));
  assert.deepEqual(outcomes, expectedOutcomes);
}

test("named estimate preserves whole-token semantics for all legal handle lengths (native SQLite)", async t => {
  let externalAttempts = 0;
  t.mock.method(globalThis, "fetch", () => { externalAttempts++; throw new Error("external fetch forbidden in named estimate fixture"); });
  const { env, db } = sqliteTestEnv(schema);
  try {
    await exercise(env.DB, request => worker.fetch(request, env));
    assert.equal(externalAttempts, 0);
  } finally {
    db.close();
  }
});

test("named estimate works through the bundled Worker and actual local D1", { skip: process.env.NAMED_D1 !== "1" }, async () => {
  const require = createRequire(import.meta.url);
  const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
  const { Miniflare } = wranglerRequire("miniflare");
  const { build } = wranglerRequire("esbuild");
  const bundle = await build({ stdin: { contents: `export { default } from ${JSON.stringify(new URL("../src/index.ts", import.meta.url).pathname)};`, resolveDir: new URL("..", import.meta.url).pathname }, bundle: true, write: false, format: "esm", platform: "browser", target: "es2022", external: ["node:*", "cloudflare:*"] });
  let externalAttempts = 0;
  const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-08-04", compatibilityFlags: ["nodejs_compat"], d1Databases: ["DB"], outboundService() { externalAttempts++; throw new Error("external fetch forbidden in named estimate fixture"); } });
  const native = new DatabaseSync(":memory:");
  try {
    native.exec(schema);
    const DB = await mf.getD1Database("DB");
    // Preserve complete trigger definitions; splitting schema.sql on ';' is invalid.
    const definitions = native.prepare("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END").all();
    await DB.batch(definitions.map(row => DB.prepare(row.sql)));
    for (const { name } of native.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
      for (const row of native.prepare(`SELECT * FROM ${name}`).all()) {
        const keys = Object.keys(row);
        await DB.prepare(`INSERT INTO ${name} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).bind(...Object.values(row)).run();
      }
    }
    await exercise(DB, async request => mf.dispatchFetch(request.url, { method: request.method, headers: Object.fromEntries(request.headers), body: request.method === "GET" ? undefined : await request.text() }));
    assert.equal(externalAttempts, 0);
  } finally {
    native.close();
    await mf.dispose();
  }
});
