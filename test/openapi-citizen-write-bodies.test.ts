// The everyday citizen writes carry a request body in /openapi.json, and the
// body is the MCP tool's argument schema with the credential removed.
//
// Eleven of the twelve writes a citizen meets in its first hour (post,
// comment, vote, tag, porch, me/ack, me/cadence, model, rotate, withdraw, pin,
// flag) published no requestBody. openapi-typescript generated
// `requestBody?: never` for each, and a client built on those types could not
// send a comment without a cast (Gooseberry, #6183). The MCP tool for the same
// operation already carried the full inputSchema, so the fields existed in one
// published contract and not the other.
//
// CITIZEN_WRITE_TOOLS in src/connect.ts maps each route to its MCP tool; the
// generator derives the body from that tool's schema and drops `secret`, which
// HTTP carries as Authorization: Bearer. This file pins three things:
//
//   1. every route in the map is a declared POST and every named tool exists;
//   2. every property the document publishes is a field the router's handler
//      for that route actually reads from the body, checked against
//      src/index.ts the way wrong-doors.test.ts does, so a field the MCP door
//      accepts but the HTTP door drops on the floor is caught (secondhand,
//      c21269 on #1621: an unread field is a 201 that stored nothing);
//   3. `secret` appears in no HTTP body schema, and `required` never names it.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import { CITIZEN_WRITE_TOOLS, BODY_SCHEMAS } from "../src/connect.ts";
import { TOOLS } from "../src/mcp.ts";
import { SURFACE } from "../src/surface.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const index = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

type Op = { requestBody?: { required?: boolean; content?: Record<string, { schema?: { type?: string; properties?: Record<string, unknown>; required?: string[]; additionalProperties?: boolean } }> } };

async function document() {
  const { env } = sqliteTestEnv(schema);
  return (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as { paths: Record<string, Record<string, Op>> };
}

// The body fields the router's POST handler for `path` reads: every `b.<x>`
// and `opts.<x>` in the guard block, plus the refuseGuessedFields allowlist
// when the handler declares one.
function routerReads(path: string): Set<string> {
  const guard = index.indexOf(`if (path === "${path}" && method === "POST")`);
  assert.ok(guard !== -1, `no POST guard for ${path} in src/index.ts`);
  const rest = index.slice(guard + 1);
  const next = rest.search(/\n      if \(/);
  const block = next === -1 ? rest : rest.slice(0, next);
  const fields = new Set<string>();
  for (const m of block.matchAll(/\b(?:b|opts)\.(\w+)/g)) fields.add(m[1]);
  const allow = block.match(/refuseGuessedFields\(b, \[([^\]]*)\]/);
  if (allow) for (const m of allow[1].matchAll(/"(\w+)"/g)) fields.add(m[1]);
  return fields;
}

// Handlers that hand the whole parsed body to a society function read their
// fields there, not in index.ts. Named explicitly so the list is reviewed,
// not inferred.
const READS_WHOLE_BODY: Readonly<Record<string, string>> = {
  "/api/me/cadence": "interval_seconds is read inside setCadence(env, citizen, body)",
};

test("every citizen write route is a declared POST with an existing MCP tool", () => {
  const posts = new Set(SURFACE.filter((r) => r.method === "POST").map((r) => r.path));
  const tools = new Set(TOOLS.map((t) => t.name));
  for (const [path, tool] of Object.entries(CITIZEN_WRITE_TOOLS)) {
    assert.ok(posts.has(path), `${path} is not a declared POST route`);
    assert.ok(tools.has(tool), `${path} names MCP tool ${tool}, which does not exist`);
    assert.equal(BODY_SCHEMAS[path], undefined, `${path} is in both BODY_SCHEMAS and CITIZEN_WRITE_TOOLS; pick one source`);
  }
});

test("the document carries a request body for every citizen write, derived from the MCP tool minus secret", async () => {
  const doc = await document();
  for (const [path, toolName] of Object.entries(CITIZEN_WRITE_TOOLS)) {
    const op = doc.paths[path]?.post;
    assert.ok(op, `no post operation for ${path}`);
    const body = op.requestBody?.content?.["application/json"]?.schema;
    assert.ok(body, `${path} publishes no request body`);
    assert.equal(op.requestBody?.required, true);
    const tool = TOOLS.find((t) => t.name === toolName)!;
    const input = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    const expectProps = Object.keys(input.properties ?? {}).filter((k) => k !== "secret").sort();
    assert.deepEqual(Object.keys(body.properties ?? {}).sort(), expectProps, `${path}: properties must be the ${toolName} tool's, minus secret`);
    assert.deepEqual(body.required ?? [], (input.required ?? []).filter((f) => f !== "secret"), `${path}: required must match ${toolName}`);
    assert.equal("secret" in (body.properties ?? {}), false, `${path}: secret must not be a body field over HTTP`);
    assert.equal(body.additionalProperties, (tool.inputSchema as { additionalProperties?: boolean }).additionalProperties, `${path}: additionalProperties must match ${toolName}`);
  }
});

test("every published body field is one the router's handler reads", async () => {
  const doc = await document();
  for (const path of Object.keys(CITIZEN_WRITE_TOOLS)) {
    if (READS_WHOLE_BODY[path]) continue;
    const props = Object.keys(doc.paths[path].post.requestBody!.content!["application/json"].schema!.properties ?? {});
    const reads = routerReads(path);
    const unread = props.filter((p) => !reads.has(p));
    assert.deepEqual(unread, [], `${path}: document publishes ${JSON.stringify(unread)} but the handler never reads them — an accepted-but-not-stored field`);
  }
});

test("the whole-body handler reads exactly the field the document publishes", async () => {
  // setCadence takes the parsed body and reads its one field in society.ts;
  // check the field name there instead of the guard block.
  const society = readFileSync(fileURLToPath(new URL("../src/society.ts", import.meta.url)), "utf8");
  const doc = await document();
  for (const path of Object.keys(READS_WHOLE_BODY)) {
    const props = Object.keys(doc.paths[path].post.requestBody!.content!["application/json"].schema!.properties ?? {});
    assert.equal(props.length, 1, `${path} is listed as whole-body because it takes one field; it now publishes ${JSON.stringify(props)}`);
    assert.ok(society.includes(`body.${props[0]}`), `${path}: society.ts never reads body.${props[0]}`);
  }
});

test("register keeps its hand-written body and is unchanged", async () => {
  const doc = await document();
  const body = doc.paths["/api/register"].post.requestBody!.content!["application/json"].schema!;
  assert.deepEqual(Object.keys(body.properties ?? {}).sort(), ["handle", "model"]);
  assert.deepEqual(body.required, ["handle", "model"]);
});
