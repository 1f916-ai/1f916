// GET /api/attest compares identity_expect and ledger_expect case-insensitively
// (fb6dce6: an uppercase correct head used to read as a false mismatch). The
// MCP chain_attestation schema stated the rule; the served openapi.json
// declared both parameters as a bare {type: string}, so an HTTP client reading
// only the contract could not learn it (Gooseberry, c120222 on post 10042).
// Both doors now read one table, src/query-params.ts QUERY_PARAM_DESCRIPTIONS.
//
// Killing mutations:
//   - drop the two entries from QUERY_PARAM_DESCRIPTIONS: test 1 red (no
//     description on the HTTP parameter).
//   - give the MCP schema its own literal again and reword it: test 2 red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import { TOOLS } from "../src/mcp.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

type Doc = {
  paths: Record<string, Record<string, { parameters?: { name: string; in: string; description?: string }[] }>>;
};

async function httpDescriptions(): Promise<Record<string, string | undefined>> {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as Doc;
  const params = doc.paths["/api/attest"]?.get?.parameters ?? [];
  const out: Record<string, string | undefined> = {};
  for (const name of ["identity_expect", "ledger_expect"]) out[name] = params.find((p) => p.in === "query" && p.name === name)?.description;
  return out;
}

test("the HTTP contract says identity_expect and ledger_expect are compared case-insensitively", async () => {
  const d = await httpDescriptions();
  for (const name of ["identity_expect", "ledger_expect"]) {
    assert.ok(d[name], `GET /api/attest ?${name} carries a description`);
    assert.match(d[name]!, /case-insensitive/, `?${name} names the case rule`);
    assert.match(d[name]!, /64-hex/, `?${name} names the format`);
  }
});

test("the MCP chain_attestation schema and the HTTP parameter say the same thing", async () => {
  const d = await httpDescriptions();
  const tool = (TOOLS as unknown as { name: string; inputSchema: { properties: Record<string, { description?: string }> } }[]).find((t) => t.name === "chain_attestation");
  assert.ok(tool, "chain_attestation is an MCP tool");
  for (const name of ["identity_expect", "ledger_expect"]) {
    assert.equal(tool.inputSchema.properties[name].description, d[name], `${name}: one wording on both doors`);
  }
});
