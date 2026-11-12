// Issue #334: Expose troubleshooting and feedback guidance through MCP itself.
// Pins that the `troubleshooting` tool is available on the full and read-only MCP doors
// and returns the expected structured guidance contract.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";
const MCP_DOORS = ["/mcp", "/mcp/read"];

async function callMcpTool(path: string, toolName: string): Promise<Record<string, unknown>> {
  const { env } = sqliteTestEnv(schema);
  const response = await worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: toolName, arguments: {} },
      }),
    }),
    env,
  );
  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    result?: { isError?: boolean; content?: Array<{ type: string; text: string }> };
  };
  assert.equal(payload.result?.isError, undefined);
  const text = payload.result?.content?.[0]?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

test("troubleshooting tool is listed in tools/list on MCP doors", async () => {
  const { env } = sqliteTestEnv(schema);
  for (const path of MCP_DOORS) {
    const res = await worker.fetch(
      new Request(`${ORIGIN}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      env,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { result?: { tools?: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }> } };
    const tools = body.result?.tools ?? [];
    const t = tools.find((tool) => tool.name === "troubleshooting");
    assert.ok(t, `troubleshooting tool must be listed on ${path}`);
    assert.equal(t.annotations?.readOnlyHint, true, "troubleshooting must advertise readOnlyHint");
  }
});

test("troubleshooting tool is NOT on the protocol door, matching its description (wake-10 audit)", async () => {
  // The tool description says "the full and read-only MCP doors (not the
  // protocol door)". /mcp/protocol serves PROTOCOL_TOOLS only, and troubleshooting
  // is not a protocol tool, so tools/list must omit it and tools/call must 403.
  // Pins the accurate surface so the "all MCP doors" overclaim cannot return.
  const { env } = sqliteTestEnv(schema);
  const list = await worker.fetch(
    new Request(`${ORIGIN}/mcp/protocol`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
    env,
  );
  assert.equal(list.status, 200);
  const listed = ((await list.json()) as { result?: { tools?: Array<{ name: string }> } }).result?.tools ?? [];
  assert.equal(listed.find((t) => t.name === "troubleshooting"), undefined, "protocol door must NOT list troubleshooting");
  const call = await worker.fetch(
    new Request(`${ORIGIN}/mcp/protocol`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "troubleshooting", arguments: {} } }),
    }),
    env,
  );
  const callBody = (await call.json()) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
  assert.equal(callBody.result?.isError, true, "protocol door must refuse a tools/call for troubleshooting");
  assert.match(callBody.result?.content?.[0]?.text ?? "", /not available through the protocol/i, "the refusal names the protocol-door restriction");
});

test("troubleshooting tool returns the structured guidance contract on MCP doors", async () => {
  for (const path of MCP_DOORS) {
    const data = await callMcpTool(path, "troubleshooting");
    assert.equal(data.contract, "1f916.support.v1");
    assert.equal(data.service, "1F916");
    assert.ok(data.surfaces && typeof data.surfaces === "object");
    assert.ok(Array.isArray(data.checks) && data.checks.length > 0);
    assert.ok(data.reporting && typeof data.reporting === "object");
    assert.ok(data.links && typeof data.links === "object");
  }
});
