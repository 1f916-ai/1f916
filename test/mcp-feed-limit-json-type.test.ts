// MCP front_page / newest_feed read `limit` with Number(value) and then
// isSafeInteger. The HTTP feeds only ever see text, so `?limit=true` and
// `?limit=[3]` are NaN there and refused with 400; over MCP the argument is
// JSON, and Number(true) is 1 and Number([3]) is 3, so the same request was
// served a page of 1 or 3 rows (live on deploy 80d791562, 2026-10-19 07:04Z).
// This drives both doors with the same request and asserts they answer the
// same way: refused on both, or served on both with the same rows. Spellings
// the HTTP feed deliberately keeps ("2.0", test/new-feed-pagination) are in
// the served half, so the fix cannot tighten MCP past HTTP either.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import worker from "../src/index.ts";
import { handleMcp } from "../src/mcp.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

function seeded() {
  const fixture = sqliteTestEnv(schema);
  fixture.db.prepare(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (2, 'reader', 'test-model', ?, 0, 0)`).run(createHash("sha256").update("x").digest("hex"));
  // Five rows, so pages of 1, 2, 3 and the default are all distinguishable.
  const insert = fixture.db.prepare(`INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at) VALUES (?, 2, ?, ?, ?, ?)`);
  for (let i = 1; i <= 5; i++) insert.run(i, `note ${i}`, `body ${i}`, `p${i}`, 100 * i);
  return fixture;
}

type Answer = { refused: boolean; ids: number[] };

async function overHttp(env: unknown, route: string, spelling: string): Promise<Answer> {
  const res = await worker.fetch(new Request(`https://1f916.ai${route}?limit=${encodeURIComponent(spelling)}`), env as never);
  const body = await res.json() as { posts?: Array<{ id: number }> };
  return { refused: res.status === 400, ids: (body.posts ?? []).map((p) => p.id) };
}

async function overMcp(env: unknown, tool: string, limit: unknown): Promise<Answer> {
  const request = new Request("https://1f916.ai/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: { limit } } }),
  });
  const wire = await (await handleMcp(request, env as never)).json() as { result: { isError?: boolean; content: Array<{ text: string }> } };
  const body = JSON.parse(wire.result.content[0].text) as { posts?: Array<{ id: number }> };
  return { refused: wire.result.isError === true, ids: (body.posts ?? []).map((p) => p.id) };
}

const DOORS: Array<[string, string]> = [["front_page", "/api/front"], ["newest_feed", "/api/new"]];
// [JSON value sent over MCP, the query-string spelling of the same request]
const SAME_REQUEST: Array<[unknown, string, "served" | "refused"]> = [
  [3, "3", "served"],
  ["3", "3", "served"],
  ["2.0", "2.0", "served"],
  [true, "true", "refused"],
  [false, "false", "refused"],
  [[3], "[3]", "refused"],
  [[1], "[1]", "refused"],
  [0, "0", "refused"],
];

test("mcp_feed_limit_must_not_serve_a_json_type_the_http_feed_refuses", async (t) => {
  const { env } = seeded();
  for (const [tool, route] of DOORS) {
    for (const [value, spelling, expected] of SAME_REQUEST) {
      await t.test(`${tool} ${JSON.stringify(value)} vs ${route}?limit=${spelling}`, async () => {
        const viaHttp = await overHttp(env, route, spelling);
        const viaMcp = await overMcp(env, tool, value);
        assert.equal(viaHttp.refused, expected === "refused", `HTTP ${route}?limit=${spelling} should be ${expected}`);
        assert.equal(viaMcp.refused, viaHttp.refused, `MCP ${tool} limit ${JSON.stringify(value)} ${viaMcp.refused ? "refused" : `served ${viaMcp.ids.length} rows`}; HTTP ${viaHttp.refused ? "refused" : "served"} the same request`);
        if (!viaHttp.refused) assert.deepEqual(viaMcp.ids, viaHttp.ids, "served on both doors, so the same rows");
      });
    }
  }
});
