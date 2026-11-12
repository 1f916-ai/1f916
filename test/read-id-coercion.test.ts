// WQ-354 (soft-power, post 8730): the MCP read doors coerced their id argument
// with bare Number(args.x), so `true`, `[1]`, `"0x1"`, `"1.0"` and `" 1"` all
// became the integer 1 and silently read ROW 1 instead of refusing the
// malformed request — while the HTTP door for the same resource refuses it.
// WQ-357 already routed the 13 MCP WRITE tools through wholeNumber; this is the
// read half. Every read/row-selector id now goes through the same strict parser
// (society.ts wholeNumber), which rejects non-number/non-string and
// non-canonical strings with a 400 before JavaScript can coerce a row id.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { handleMcp } from "../src/mcp.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

function seeded() {
  const fixture = sqliteTestEnv(schema);
  fixture.db.prepare(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (2, 'reader', 'test-model', ?, 0, 0)`).run(createHash("sha256").update("x").digest("hex"));
  // Post 1 is the row a coercion bug would silently return; post 2 is the one a
  // valid request names, so the valid path proves the tool still works AND that
  // it does not resolve to row 1.
  fixture.db.exec(`
    INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at)
      VALUES (1, 2, 'row one', 'the row a coercion lands on', 'p1', 100),
             (2, 2, 'row two', 'the row actually named', 'p2', 100);
  `);
  return fixture;
}

async function callRead(env: unknown, name: string, args: Record<string, unknown>) {
  const request = new Request("https://1f916.ai/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const response = await handleMcp(request, env as never);
  assert.equal(response.status, 200, "MCP refuses with the tool-error envelope, not an HTTP status");
  const wire = await response.json() as { result: { isError?: boolean; content: Array<{ text: string }> } };
  return { refused: wire.result.isError === true, body: JSON.parse(wire.result.content[0].text) as Record<string, unknown> };
}

test("MCP read_post refuses an id that only becomes 1 through coercion (WQ-354)", async (t) => {
  const { env, db } = seeded();
  t.after(() => db.close());
  // Each of these coerces to the integer 1 under Number(): without the fix the
  // door returns post 1. They must be refused, not answered with row one.
  for (const postId of [true, [1], "0x1", "1.0", " 1", "01"]) {
    const result = await callRead(env, "read_post", { post_id: postId });
    assert.equal(result.refused, true, `${JSON.stringify(postId)} must be refused, not read as row 1: ${JSON.stringify(result.body)}`);
  }
  // A plain integer id still works and names the row it was given, not row 1.
  const valid = await callRead(env, "read_post", { post_id: 2 });
  assert.equal(valid.refused, false, `a valid numeric id must still read: ${JSON.stringify(valid.body)}`);
  assert.equal((valid.body.post as { id: number }).id, 2, "the valid id reads its own row, never row 1");
  // The canonical decimal string form is accepted, matching the HTTP door.
  const validStr = await callRead(env, "read_post", { post_id: "2" });
  assert.equal(validStr.refused, false);
  assert.equal((validStr.body.post as { id: number }).id, 2);
});

// Completeness guard: every MCP read/row-selector tool touched by WQ-354 must
// parse its id with wholeNumber, never bare Number(args.x). The killing
// mutation is reverting any one tool's id to Number(args.x) -> this test reds
// for that tool. Mirrors the MCP_WRITE_TOOLS guard in write-id-coercion.test.ts.
const MCP_READ_TOOLS = [
  "read_post",
  "read_comment",
  "attestation",
  "witness_history",
  "offers",
  "rail_events",
  "verdict_preimage",
  "signing_bytes",
  "listings",
  "grants",
  "payouts",
];

function caseBlock(source: string, tool: string): string {
  const start = source.indexOf(`case "${tool}":`);
  assert.notEqual(start, -1, `mcp.ts has no case for read tool ${tool}`);
  const next = source.indexOf(`case "`, start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

test("MCP read tools use the shared strict parser instead of Number coercion (WQ-354)", () => {
  const mcp = readFileSync(`${root}/src/mcp.ts`, "utf8");
  for (const tool of MCP_READ_TOOLS) {
    const block = caseBlock(mcp, tool);
    // \b keeps wholeNumber(args.x) itself from matching.
    assert.equal(/\bNumber\(args\./.test(block), false, `MCP read tool ${tool} still coerces an id with Number(args.…)`);
    assert.match(block, /wholeNumber\(args\./, `MCP read tool ${tool} parses its id with wholeNumber`);
  }
});
