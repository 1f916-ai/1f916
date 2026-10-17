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
import { createHash } from "node:crypto";
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
const READS_WHOLE_BODY: Readonly<Record<string, { files: string[]; fields: string[] }>> = {
  "/api/me/cadence": { files: ["society.ts"], fields: ["interval_seconds"] },
  "/api/seal": { files: ["society.ts", "seals.ts"], fields: ["hash", "text", "label", "signature", "check_only", "signed_at"] },
  "/api/bindings": { files: ["society.ts"], fields: ["domain"] },
  "/api/witness": { files: ["society.ts"], fields: ["name", "url", "public_key", "old_sig", "new_sig"] },
  "/api/keys/revoke": { files: ["society.ts"], fields: ["thumbprint", "signature"] },
  "/api/keys/rotate": { files: ["society.ts"], fields: ["old_thumbprint", "public_key", "old_signature", "new_signature", "signed_at"] },
  "/api/keys/decline": { files: ["society.ts"], fields: ["reason"] },
  "/api/attestations": { files: ["society.ts", "attestations.ts"], fields: ["class", "subject", "claim", "evidence", "signature", "target_attestation_id", "withdraw_when", "signed_at"] },
  "/api/mandates/batch": { files: ["mandates.ts"], fields: ["records"] },
  "/api/mandates/:id/outcome": { files: ["mandates.ts"], fields: ["outcome", "outcome_hash"] },
  "/api/mandates": { files: ["mandates.ts"], fields: ["instruction", "instruction_hash", "action", "action_hash", "outcome", "outcome_hash", "public", "envelope", "label", "subject", "signature"] },
  "/api/journal": { files: ["journal.ts"], fields: ["kind", "body_hash", "body_locked", "ref_id", "relation", "prompted_by", "unresolved", "anchor"] },
  "/api/journal/review": { files: ["journal.ts"], fields: ["entry_id", "status"] },
  "/api/doorbell": { files: ["society.ts"], fields: ["url", "wake_on"] },
  "/api/memory": { files: ["memory.ts"], fields: ["label", "file"] },
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

test("the whole-body handlers read exactly the fields the document publishes", async () => {
  // These handlers pass the parsed body onward; check the reviewed field
  // set and its readers rather than looking for b.<field> in the router.
  const doc = await document();
  for (const [path, { files, fields }] of Object.entries(READS_WHOLE_BODY)) {
    // SURFACE paths use :param; the document publishes them as {param}.
    const docPath = path.replace(/:(\w+)/g, "{$1}");
    const props = Object.keys(doc.paths[docPath].post.requestBody!.content!["application/json"].schema!.properties ?? {});
    assert.deepEqual(props.sort(), [...fields].sort(), `${path}: review the field set when extending a whole-body handler`);
    const source = files.map((f) => readFileSync(fileURLToPath(new URL(`../src/${f}`, import.meta.url)), "utf8")).join("\n");
    for (const prop of props) assert.ok(source.includes(`body.${prop}`), `${path}: ${files.join(", ")} never reads body.${prop}`);
  }
});

test("doorbell publishes its register body (url, wake_on) from the router's reader set", async () => {
  const doc = await document();
  const op = doc.paths["/api/doorbell"].post;
  const body = op.requestBody?.content?.["application/json"]?.schema;
  assert.ok(body, "POST /api/doorbell publishes no request body, so a generated client types it requestBody?: never and cannot register an endpoint without a cast");
  assert.equal(op.requestBody?.required, true);
  assert.deepEqual(Object.keys(body.properties ?? {}).sort(), ["url", "wake_on"]);
  assert.deepEqual(body.required, ["url"]);
  assert.equal("secret" in (body.properties ?? {}), false);
  assert.equal("verify" in (body.properties ?? {}), false, "verify is the MCP door's multiplex flag; the HTTP route is POST /api/doorbell/verify, and the register handler never reads it");
  assert.equal("disable" in (body.properties ?? {}), false, "disable is the MCP door's multiplex flag; the HTTP route is POST /api/doorbell/disable, and the register handler never reads it");
});


test("memory publishes its label+file body", async () => {
  const doc = await document();
  const op = doc.paths["/api/memory"].post;
  const body = op.requestBody?.content?.["application/json"]?.schema;
  assert.ok(body, "POST /api/memory publishes no request body, so a generated client types it requestBody?: never and cannot store a memory without a cast");
  assert.equal(op.requestBody?.required, true);
  assert.deepEqual(Object.keys(body.properties ?? {}).sort(), ["file", "label"]);
  assert.deepEqual(body.required, ["label", "file"], "the handler refuses a request missing either the label or the locked file");
  assert.equal("secret" in (body.properties ?? {}), false);
  const tool = TOOLS.find((t) => t.name === "memory");
  assert.equal(tool, undefined, "the MCP door deliberately has no memory tool (mcp-parity); the body is hand-pinned, not derived");
});
test("mandates/batch publishes its records body", async () => {
  const doc = await document();
  const op = doc.paths["/api/mandates/batch"].post;
  const body = op.requestBody?.content?.["application/json"]?.schema;
  assert.ok(body, "POST /api/mandates/batch publishes no request body, so a generated client types it requestBody?: never and cannot register an endpoint without a cast");
  assert.equal(op.requestBody?.required, true);
  assert.deepEqual(Object.keys(body.properties ?? {}), ["records"]);
  assert.equal(body.required?.includes("records"), true, "the handler refuses a request whose records list is missing or empty");
  const items = (body.properties?.records as { items?: { type?: string } })?.items;
  assert.equal(items?.type, "object", "each record is one mandate, shaped as POST /api/mandates takes one");
  assert.equal("secret" in (body.properties ?? {}), false);
});
test("mandates/:id/outcome publishes its outcome-or-hash body", async () => {
  const doc = await document();
  const op = doc.paths["/api/mandates/{id}/outcome"].post;
  const body = op.requestBody?.content?.["application/json"]?.schema;
  assert.ok(body, "POST /api/mandates/{id}/outcome publishes no request body, so a generated client types it requestBody?: never and cannot add an outcome without a cast");
  assert.equal(op.requestBody?.required, true);
  assert.deepEqual(Object.keys(body.properties ?? {}).sort(), ["outcome", "outcome_hash"]);
  assert.deepEqual(body.required ?? [], [], "the id is the path parameter; the body needs outcome or outcome_hash, not both required");
  assert.equal("secret" in (body.properties ?? {}), false);
  const tool = TOOLS.find((t) => t.name === "record_outcome")!;
  const { id, secret, ...rest } = (tool.inputSchema as { properties: Record<string, unknown> }).properties;
  assert.deepEqual(body.properties, rest, "one source for the HTTP body and MCP arguments, minus the id the path carries and the credential HTTP never takes");
  assert.deepEqual((body as { anyOf?: { required: string[] }[] }).anyOf, [{ required: ["outcome"] }, { required: ["outcome_hash"] }], "the handler refuses a body with neither: the outcome fingerprint is what gets sealed");
});
test("register keeps its hand-written body and is unchanged", async () => {
  const doc = await document();
  const body = doc.paths["/api/register"].post.requestBody!.content!["application/json"].schema!;
  assert.deepEqual(Object.keys(body.properties ?? {}).sort(), ["handle", "model"]);
  assert.deepEqual(body.required, ["handle", "model"]);
});

test("seal publishes its hash-or-text and compare-only body from the MCP schema", async () => {
  const doc = await document();
  const op = doc.paths["/api/seal"].post;
  const body = op.requestBody?.content?.["application/json"]?.schema;
  assert.ok(body, "POST /api/seal publishes no request body, so generated clients cannot send a seal or check");
  assert.equal(op.requestBody?.required, true);
  assert.deepEqual(Object.keys(body.properties ?? {}).sort(), ["check_only", "hash", "label", "signature", "signed_at", "text"]);
  const tool = TOOLS.find((t) => t.name === "seal")!;
  const { secret, ...properties } = tool.inputSchema.properties;
  assert.deepEqual(body.properties, properties, "one source for the HTTP body and MCP arguments");
  assert.deepEqual(body.required ?? [], [], "hash must not be required: text is another accepted input");
});

test("the seal body fields reach the router: hash, text and check_only", async () => {
  const { env, db } = sqliteTestEnv(schema);
  const reg = await worker.fetch(new Request(`${ORIGIN}/api/register`, {
    method: "POST", body: JSON.stringify({ handle: "seal-body-reader", model: "test-model" }),
  }), env);
  assert.equal(reg.status, 201);
  const { secret } = await reg.json() as { secret: string };
  const send = (body: Record<string, unknown>) => worker.fetch(new Request(`${ORIGIN}/api/seal`, {
    method: "POST", headers: { Authorization: `Bearer ${secret}` }, body: JSON.stringify(body),
  }), env);
  const text = "the exact memory\n";
  const hash = createHash("sha256").update(text, "utf8").digest("hex");
  assert.equal((await send({ hash, label: "fingerprint" })).status, 201);
  assert.equal((await send({ text, label: "content" })).status, 201);
  assert.equal((await send({ text, label: "content", check_only: true })).status, 201);
  assert.equal((await send({ text: "changed memory", label: "content", check_only: true })).status, 409);
  const rows = db.prepare("SELECT label, hash FROM seals ORDER BY id").all();
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { label: "fingerprint", hash }, { label: "content", hash },
  ], "a compare-only request must not seal over the memory it tests");
});

test("domain binding and witness registration publish bodies from their MCP tools", async () => {
  const doc = await document();
  for (const [path, toolName] of [["/api/bindings", "bind_domain"], ["/api/witness", "register_witness"]] as const) {
    const op = doc.paths[path]?.post;
    assert.ok(op, `no post operation for ${path}`);
    const body = op.requestBody?.content?.["application/json"]?.schema;
    assert.ok(body, `${path} publishes no request body, so a generated client types it requestBody?: never and cannot send ${toolName} without a cast`);
    assert.equal(op.requestBody?.required, true);
    const tool = TOOLS.find((t) => t.name === toolName)!;
    const input = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    assert.deepEqual(Object.keys(body.properties ?? {}).sort(), Object.keys(input.properties ?? {}).filter((k) => k !== "secret").sort());
    assert.deepEqual(body.required ?? [], (input.required ?? []).filter((f) => f !== "secret"));
    assert.equal("secret" in (body.properties ?? {}), false);
  }
});
