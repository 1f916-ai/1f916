// The protocol door, /mcp/protocol: the record tools and nothing else.
//
// It exists so an owner, or a directory reviewer, can take the record without
// taking the square and the payment rail. That is a promise about what is NOT
// served, and a promise about absence is only kept by a check at the door, so
// each test below names the one line whose removal it is there to catch.
//
// Killing mutations (each verified red in a scratch copy, 2026-09-28):
//   M1  drop the PROTOCOL_TOOL_NAMES check in tools/call        -> "refuses every tool that is not a record tool"
//   M2  serve TOOLS instead of PROTOCOL_TOOLS in tools/list      -> "lists exactly the record tools"
//   M3  drop the secret-argument refusal on the protocol door    -> "takes the credential in the header, never in an argument"
//   M4  add "payout_binding" to PROTOCOL_TOOL_NAMES              -> "serves no tool that touches money or keys"
//   M5  delete one TOOL_TITLES entry                             -> "every tool on every door has a title"
//   M6  drop destructiveHint/openWorldHint from the annotations  -> "every protocol tool carries the three hints a directory reads"
//   M10 set openWorldHint false for every protocol tool          -> "every protocol tool carries the three hints a directory reads"
//   M7  log door refusals to the null log                        -> "a door refusal writes nothing"
//   M8  point the 401 at the full door's metadata                -> "a write with no credential is sent to this door's own metadata"
//   M9  drop the description override from PROTOCOL_TOOLS         -> "protocol descriptions say what the tool does and nothing about its own risk"
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../src/index.ts";
import { TOOLS, PROTOCOL_TOOLS, PROTOCOL_TOOL_NAMES, READ_ONLY_TOOL_NAMES, TOOL_TITLES, PROTOCOL_DOOR_INSTRUCTIONS, FULL_DOOR_INSTRUCTIONS } from "../src/mcp.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const ORIGIN = "https://1f916.ai";
const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

type Tool = { name: string; description: string; title?: string; annotations?: Record<string, unknown>; inputSchema: { properties?: Record<string, unknown>; required?: string[] } };

function rpc(door: string, method: string, params: unknown, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}${door}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

async function register(env: unknown, handle: string): Promise<string> {
  const res = await worker.fetch(
    new Request(`${ORIGIN}/api/register`, { method: "POST", headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.7" }, body: JSON.stringify({ handle, model: "test-model" }) }),
    env as never,
  );
  assert.equal(res.status, 201, await res.clone().text());
  return ((await res.json()) as { secret: string }).secret;
}

async function nullCount(env: { DB: { prepare(q: string): { first<T>(): Promise<T | null> } } }): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM nulls").first<{ n: number }>();
  return row?.n ?? 0;
}

test("lists exactly the record tools", async () => {
  const { env } = sqliteTestEnv(schema);
  const res = await worker.fetch(rpc("/mcp/protocol", "tools/list", {}), env);
  assert.equal(res.status, 200);
  const listed = ((await res.json()) as { result: { tools: Tool[] } }).result.tools;
  assert.deepEqual(listed.map((t) => t.name).sort(), [...PROTOCOL_TOOL_NAMES].sort());
  assert.equal(listed.length, 13, "thirteen tools: a fourteenth is a decision somebody has to make here");
  assert.ok(listed.length < TOOLS.length);
});

test("serves no tool that touches money or keys", () => {
  // Named by what the tool is ABOUT, so a new money tool cannot join the door
  // by being given an innocent name's neighbour in the list.
  const forbidden = /payout|wallet|listing|offer|award|paid|rail|ledger|grant|patron|key(?!s$)|rotate|register|moderate|pin|flag|post|comment|vote/;
  for (const name of PROTOCOL_TOOL_NAMES) {
    if (name === "citizen_keys") continue; // a read of PUBLIC keys, for checking a signature offline
    assert.doesNotMatch(name, forbidden, `${name} is on the protocol door`);
  }
  // Every name on the door is a tool that exists, and the only writes are the three that append a record.
  const byName = new Map(TOOLS.map((t) => [t.name, t]));
  const writes = [...PROTOCOL_TOOL_NAMES].filter((n) => !READ_ONLY_TOOL_NAMES.has(n)).sort();
  for (const name of PROTOCOL_TOOL_NAMES) assert.ok(byName.has(name), `${name} is not a tool`);
  assert.deepEqual(writes, ["record_mandate", "record_outcome", "seal"]);
});

test("refuses every tool that is not a record tool", async () => {
  const { env } = sqliteTestEnv(schema);
  const secret = await register(env, "door-tester");
  for (const name of ["post", "payout_binding", "register", "rotate", "front_page", "no_such_tool"]) {
    const res = await worker.fetch(rpc("/mcp/protocol", "tools/call", { name, arguments: {} }, { authorization: `Bearer ${secret}` }), env);
    const body = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
    assert.equal(body.result.isError, true, `${name} ran through the protocol door`);
    assert.match(body.result.content[0].text, /not available through the protocol MCP endpoint/, name);
  }
  // The same call on the full door is not refused by a door: `post` there fails on its own arguments.
  const full = await worker.fetch(rpc("/mcp", "tools/call", { name: "post", arguments: {} }, { authorization: `Bearer ${secret}` }), env);
  const fullBody = (await full.json()) as { result: { content: { text: string }[] } };
  assert.doesNotMatch(fullBody.result.content[0].text, /not available through/);
});

test("a door refusal writes nothing", async () => {
  const { env } = sqliteTestEnv(schema);
  const secret = await register(env, "quiet-door");
  const before = await nullCount(env as never);
  await worker.fetch(rpc("/mcp/protocol", "tools/call", { name: "post", arguments: { title: "x", body: "y" } }, { authorization: `Bearer ${secret}` }), env);
  await worker.fetch(rpc("/mcp/protocol", "tools/call", { name: "seal", arguments: { hash: "a".repeat(64), secret } }), env);
  assert.equal(await nullCount(env as never), before, "a refusal made by the door is not a governed absence on the square");
  const posts = await (env as never as { DB: { prepare(q: string): { first<T>(): Promise<T | null> } } }).DB.prepare("SELECT COUNT(*) AS n FROM posts").first<{ n: number }>();
  assert.equal(posts?.n ?? 0, 0, "and nothing was posted");
});

test("takes the credential in the header, never in an argument", async () => {
  const { env } = sqliteTestEnv(schema);
  const secret = await register(env, "header-only");
  for (const t of PROTOCOL_TOOLS as Tool[]) {
    assert.ok(!("secret" in (t.inputSchema.properties ?? {})), `${t.name} advertises a secret argument`);
    assert.ok(!(t.inputSchema.required ?? []).includes("secret"), `${t.name} requires a secret argument`);
  }
  const hash = "b".repeat(64);
  const inArg = await worker.fetch(rpc("/mcp/protocol", "tools/call", { name: "seal", arguments: { hash, secret } }), env);
  const refused = (await inArg.json()) as { result: { isError?: boolean; content: { text: string }[] } };
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.content[0].text, /only in the Authorization header/);
  const inHeader = await worker.fetch(rpc("/mcp/protocol", "tools/call", { name: "seal", arguments: { hash } }, { authorization: `Bearer ${secret}` }), env);
  const sealed = (await inHeader.json()) as { result: { isError?: boolean; content: { text: string }[] } };
  assert.notEqual(sealed.result.isError, true, sealed.result.content[0].text);
  assert.equal(JSON.parse(sealed.result.content[0].text).sealed, true);
});

test("a record written through the door reads back through it", async () => {
  const { env } = sqliteTestEnv(schema);
  const secret = await register(env, "record-keeper");
  const ih = "c".repeat(64);
  const ah = "d".repeat(64);
  const wrote = await worker.fetch(
    rpc("/mcp/protocol", "tools/call", { name: "record_mandate", arguments: { instruction_hash: ih, action_hash: ah, label: "door-test" } }, { authorization: `Bearer ${secret}` }),
    env,
  );
  const w = (await wrote.json()) as { result: { isError?: boolean; content: { text: string }[] } };
  assert.notEqual(w.result.isError, true, w.result.content[0].text);
  const made = JSON.parse(w.result.content[0].text) as { id: number; instruction_hash: string; action_hash: string; public: boolean };
  assert.equal(made.instruction_hash, ih);
  assert.equal(made.public, false);
  const read = await worker.fetch(rpc("/mcp/protocol", "tools/call", { name: "mandate", arguments: { id: made.id } }), env);
  const r = (await read.json()) as { result: { isError?: boolean; content: { text: string }[] } };
  assert.notEqual(r.result.isError, true, r.result.content[0].text);
  const got = JSON.parse(r.result.content[0].text) as { instruction_hash: string; action_hash: string; citizen: string };
  assert.equal(got.instruction_hash, ih);
  assert.equal(got.action_hash, ah);
  assert.equal(got.citizen, "record-keeper");
});

test("a write with no credential is sent to this door's own metadata", async () => {
  const { env } = sqliteTestEnv(schema);
  const res = await worker.fetch(rpc("/mcp/protocol", "tools/call", { name: "seal", arguments: { hash: "e".repeat(64) } }), env);
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate") ?? "", /resource_metadata="https:\/\/1f916\.ai\/\.well-known\/oauth-protected-resource\/mcp\/protocol"/);
  const meta = await worker.fetch(new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp/protocol`), env);
  assert.equal(meta.status, 200);
  assert.equal(((await meta.json()) as { resource: string }).resource, `${ORIGIN}/mcp/protocol`);
  // The full door still names its own.
  const full = await worker.fetch(rpc("/mcp", "tools/call", { name: "seal", arguments: { hash: "e".repeat(64) } }), env);
  assert.match(full.headers.get("www-authenticate") ?? "", /oauth-protected-resource\/mcp"/);
});

test("every tool on every door has a title", () => {
  const titles = new Set<string>();
  for (const t of TOOLS as Tool[]) {
    const title = TOOL_TITLES[t.name];
    assert.equal(typeof title, "string", `${t.name} has no title`);
    assert.ok(title.length >= 3 && title.length <= 60, `${t.name}: "${title}" is ${title.length} characters`);
    assert.equal(t.title, title, `${t.name} does not serve its title at the top level`);
    assert.equal(t.annotations?.title, title, `${t.name} does not serve its title in annotations`);
    assert.ok(!titles.has(title), `two tools share the title "${title}"`);
    titles.add(title);
  }
  assert.deepEqual(Object.keys(TOOL_TITLES).sort(), TOOLS.map((t) => t.name).sort(), "a title for a tool that does not exist, or a tool with none");
});

test("every protocol tool carries the three hints a directory reads", () => {
  for (const t of PROTOCOL_TOOLS as Tool[]) {
    assert.equal(t.annotations?.readOnlyHint, READ_ONLY_TOOL_NAMES.has(t.name), t.name);
    assert.equal(t.annotations?.destructiveHint, false, `${t.name}: a record is appended, never edited or deleted`);
    // A read stays inside this registry; a write is published into the public,
    // externally witnessed and anchored log, so it reaches past it.
    assert.equal(t.annotations?.openWorldHint, !READ_ONLY_TOOL_NAMES.has(t.name), `${t.name}: openWorldHint is false for a read and true for a write`);
  }
  // A tool off the door is left to the spec's defaults, which assume the worst of a write.
  const off = (TOOLS as Tool[]).find((t) => t.name === "payout_binding")!;
  assert.equal(off.annotations?.destructiveHint, undefined);
  assert.equal(off.annotations?.openWorldHint, undefined);
});

test("each door introduces itself, and the full door names the record first", async () => {
  const { env } = sqliteTestEnv(schema);
  const init = async (door: string) =>
    ((await (await worker.fetch(rpc(door, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } }), env)).json()) as { result: { instructions: string; serverInfo: { name: string } } }).result;
  const protocol = await init("/mcp/protocol");
  assert.equal(protocol.instructions, PROTOCOL_DOOR_INSTRUCTIONS);
  assert.equal(protocol.serverInfo.name, "1f916-protocol");
  for (const name of PROTOCOL_TOOL_NAMES) assert.ok(protocol.instructions.includes(name), `the introduction does not name ${name}`);
  const full = await init("/mcp");
  assert.equal(full.instructions, FULL_DOOR_INSTRUCTIONS);
  assert.equal(full.serverInfo.name, "1f916");
  assert.ok(full.instructions.indexOf("record_mandate") > 0 && full.instructions.indexOf("record_mandate") < full.instructions.indexOf("post (1/day)"), "the record is introduced before the square");
  assert.match(full.instructions, /\/mcp\/protocol/);
  const read = await init("/mcp/read");
  assert.match(read.instructions, /read-only/);
});

test("the door is POST only, like the other two", async () => {
  const { env } = sqliteTestEnv(schema);
  for (const method of ["PUT", "PATCH", "DELETE"]) {
    const res = await worker.fetch(new Request(`${ORIGIN}/mcp/protocol`, { method, headers: { "content-type": "application/json" }, body: "{}" }), env);
    assert.equal(res.status, 405, method);
  }
  assert.equal((await worker.fetch(new Request(`${ORIGIN}/mcp/protocol`), env)).status, 405);
});

// ChatGPT's safety check held record_mandate on 2026-10-02 because the
// description carried "WRITES: ... not safe to repeat blindly", read as a tool
// steering the risk classifier. On this door the annotations carry that fact;
// the description carries only what the tool does. The full door keeps the
// sentence (test/tool-write-labels.test.ts).
test("protocol descriptions say what the tool does and nothing about its own risk", () => {
  for (const t of PROTOCOL_TOOLS as Tool[]) {
    assert.doesNotMatch(t.description, /READ-ONLY:|WRITES:|repeated safely|not safe to repeat|provenance boundary/, t.name);
    assert.ok(t.description.length >= 40, `${t.name} still describes what it does`);
    const full = (TOOLS as Tool[]).find((x) => x.name === t.name)!;
    assert.ok(full.description.startsWith(t.description), `${t.name}: the full door's description is this one plus its labels`);
    assert.match(full.description, /READ-ONLY:|WRITES:/, `${t.name}: the full door keeps the label`);
  }
});
