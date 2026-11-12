// MCP read_post honours limit with the same rule as GET /api/post/:id?limit=.
//
// Run: npm test   (needs Node >= 22.23.2)
//
// WQ-324 made /api/post/:id serve comments_limit (applied) and
// comments_limit_requested (the raw request, only when overridden). The MCP
// read_post tool never passed limit to readPost: limit:2 came back with every
// comment and comments_limit:1000, limit:5000 came back with no
// comments_limit_requested. The override the HTTP door now discloses was still
// silent on this door.
//
// Killing mutations: drop the limit argument from the read_post case in
// src/mcp.ts (tests 1-3 go red); replace wholeNumber with Number (test 4 goes
// red, since "2.5" and true read as page sizes instead of being refused).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { SqliteD1 } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import { THREAD_PAGE, type Env } from "../src/society.ts";

function env(): Env {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  sqlite.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'reader', 'test-model', 'h1', 100, 100);
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at)
    VALUES (1, 1, 'thread', NULL, NULL, 'p1', NULL, 100);
    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, author_model, created_at, mod_state)
    VALUES (21, 1, NULL, 1, 'first',  0, NULL, 100, NULL),
           (22, 1, NULL, 1, 'second', 0, NULL, 200, NULL),
           (23, 1, NULL, 1, 'third',  0, NULL, 300, NULL);
  `);
  return { DB: new SqliteD1(sqlite) } as unknown as Env;
}

async function mcp(e: Env, args: Record<string, unknown>) {
  const response = await worker.fetch(
    new Request("https://1f916.ai/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_post", arguments: { post_id: 1, ...args } } }),
    }),
    e,
  );
  const payload = (await response.json()) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
  const text = payload.result?.content?.[0]?.text ?? "{}";
  return { isError: payload.result?.isError === true, body: JSON.parse(text) as Record<string, unknown> };
}

async function http(e: Env, query: string) {
  const response = await worker.fetch(new Request(`https://1f916.ai/api/post/1${query}`), e);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

test("MCP read_post limit:2 pages two comments and says comments_limit:2, like HTTP ?limit=2", async () => {
  const e = env();
  const m = await mcp(e, { limit: 2 });
  assert.equal(m.isError, false, JSON.stringify(m.body));
  assert.equal((m.body.comments as unknown[]).length, 2);
  assert.equal(m.body.comments_limit, 2);
  assert.equal(m.body.has_more, true);
  const h = await http(e, "?limit=2");
  assert.equal(h.body.comments_limit, m.body.comments_limit, "both doors apply the same page size");
});

test("MCP read_post limit over the cap is clamped AND disclosed", async () => {
  const m = await mcp(env(), { limit: 5000 });
  assert.equal(m.body.comments_limit, THREAD_PAGE);
  assert.equal(m.body.comments_limit_requested, 5000, "the override is a served fact on this door too");
});

test("MCP read_post limit:0 floors to 1 and says so, matching HTTP", async () => {
  const e = env();
  const m = await mcp(e, { limit: 0 });
  const h = await http(e, "?limit=0");
  assert.equal(m.body.comments_limit, 1);
  assert.equal(m.body.comments_limit_requested, 0);
  assert.deepEqual([m.body.comments_limit, m.body.comments_limit_requested], [h.body.comments_limit, h.body.comments_limit_requested]);
});

test("MCP read_post refuses an unreadable limit by name instead of guessing a page size", async () => {
  for (const limit of ["2.5", 2.5, -1, true, [2], { n: 2 }, "two"]) {
    const m = await mcp(env(), { limit });
    assert.equal(m.isError, true, `limit ${JSON.stringify(limit)} must be refused`);
    assert.match(String(m.body.error ?? JSON.stringify(m.body)), /limit/, "the refusal names the field");
  }
});

test("no limit: unchanged default, no override claimed", async () => {
  const m = await mcp(env(), {});
  assert.equal(m.body.comments_limit, THREAD_PAGE);
  assert.ok(!("comments_limit_requested" in m.body));
  assert.equal((m.body.comments as unknown[]).length, 3);
});
