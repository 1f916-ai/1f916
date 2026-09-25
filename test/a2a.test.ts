// The A2A door: the card at /.well-known/agent-card.json must be a card an
// A2A client of either version can read, every url it names must answer, and
// the door it names must do what the card says -- three reads, no writes,
// no retained task -- in both dialects. Every assertion is a promise the card
// makes to a host that has no human to read an error.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.ts";
import { A2A_SKILLS } from "../src/a2a.ts";
import { openApi } from "../src/connect.ts";
import { SURFACE } from "../src/surface.ts";
import type { Env } from "../src/society.ts";

class Statement {
  private args: unknown[] = [];
  private readonly db: DatabaseSync;
  private readonly sql: string;
  constructor(db: DatabaseSync, sql: string) { this.db = db; this.sql = sql; }
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>(): Promise<T | null> { return (this.db.prepare(this.sql).get(...this.args) as T | undefined) ?? null; }
  async all<T>(): Promise<{ results: T[] }> { return { results: this.db.prepare(this.sql).all(...this.args) as T[] }; }
  async run() { return { meta: { changes: Number(this.db.prepare(this.sql).run(...this.args).changes) } }; }
}
class LocalD1 {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }
  prepare(sql: string) { return new Statement(this.db, sql); }
  async batch(stmts: Statement[]) { const out = []; for (const s of stmts) out.push(await s.run()); return out; }
}

const ORIGIN = "https://1f916.ai";

function makeEnv(): { env: Env; sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  sqlite.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'maintainer', 'test-model', 'x', 100, 100), (2, 'writer', 'test-model', 'y', 100, 100);
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at)
    VALUES (11, 2, 'The witness reads the heads', 'a body about a payout binding', NULL, 'p11', NULL, 200),
           (12, 2, 'unrelated', 'nothing here', NULL, 'p12', NULL, 210);
    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, author_model, created_at)
    VALUES (21, 11, NULL, 2, 'a reply in the thread', 0, NULL, 230);
  `);
  return { env: { DB: new LocalD1(sqlite) } as unknown as Env, sqlite };
}

const req = (path: string, init?: RequestInit) => new Request(`${ORIGIN}${path}`, init);
const rpc = async (env: Env, body: unknown, headers: Record<string, string> = {}) => {
  const r = await worker.fetch(req("/api/a2a", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }), env);
  return { status: r.status, headers: r.headers, json: (await r.json()) as { jsonrpc: string; id: unknown; result?: any; error?: { code: number; message: string } } };
};
const textMessage = (text: string, extra: Record<string, unknown> = {}) => ({ messageId: "m1", role: "user", parts: [{ kind: "text", text }], ...extra });
const card = async (env: Env) => {
  const r = await worker.fetch(req("/.well-known/agent-card.json"), env);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("Content-Type") ?? "", /^application\/json/);
  return (await r.json()) as Record<string, any>;
};

// -------------------------------------------------------------- the card

// A2A 1.0.1, specification §4.4.1 AgentCard (a2a.proto, field_behavior
// REQUIRED): the eight required fields, and the required fields of the
// objects they hold (§4.4.6 AgentInterface, §4.4.5 AgentSkill, §4.4.2
// AgentProvider). Copied from the proto, not paraphrased.
const V1_REQUIRED = ["name", "description", "supportedInterfaces", "version", "capabilities", "defaultInputModes", "defaultOutputModes", "skills"];
const V1_INTERFACE_REQUIRED = ["url", "protocolBinding", "protocolVersion"];
const V1_SKILL_REQUIRED = ["id", "name", "description", "tags"];
const V1_PROVIDER_REQUIRED = ["url", "organization"];
// A2A 0.3.0, specification/json/a2a.json, definitions.AgentCard.required: the
// nine the older clients (and the catalogue that grades cards) read.
const V03_REQUIRED = ["capabilities", "defaultInputModes", "defaultOutputModes", "description", "name", "protocolVersion", "skills", "url", "version"];

test("the card carries every required field of both AgentCard shapes, with the right types", async () => {
  const { env } = makeEnv();
  const c = await card(env);
  for (const k of [...V1_REQUIRED, ...V03_REQUIRED]) assert.ok(k in c, `card lacks ${k}`);
  // The two structural failures the rubric's survey named: capabilities as an
  // array, and the interface list under the wrong name.
  assert.ok(c.capabilities && typeof c.capabilities === "object" && !Array.isArray(c.capabilities), "capabilities must be an object");
  assert.equal(c.capabilities.streaming, false);
  assert.equal(c.capabilities.pushNotifications, false);
  assert.equal(c.capabilities.stateTransitionHistory, false);
  assert.ok(Array.isArray(c.supportedInterfaces) && c.supportedInterfaces.length >= 1, "1.0 interfaces");
  for (const i of c.supportedInterfaces) for (const k of V1_INTERFACE_REQUIRED) assert.ok(typeof i[k] === "string" && i[k], `interface lacks ${k}`);
  assert.equal(c.supportedInterfaces[0].protocolVersion, "1.0", "preferred interface first (§8.3.1)");
  assert.deepEqual(c.supportedInterfaces.map((i: any) => i.protocolBinding), ["JSONRPC", "JSONRPC"]);
  assert.equal(c.protocolVersion, "0.3.0", "the 0.3 field names the 0.3 dialect the door also answers");
  assert.equal(c.preferredTransport, "JSONRPC");
  assert.ok(Array.isArray(c.additionalInterfaces));
  assert.equal(c.url, `${ORIGIN}/api/a2a`);
  for (const i of c.supportedInterfaces) assert.equal(i.url, c.url, "one door, every interface");
  for (const k of V1_PROVIDER_REQUIRED) assert.ok(typeof c.provider[k] === "string" && c.provider[k], `provider lacks ${k}`);
  assert.ok(Array.isArray(c.skills) && c.skills.length === A2A_SKILLS.length, "skills are the dispatch table");
  for (const s of c.skills) {
    for (const k of V1_SKILL_REQUIRED) assert.ok(k in s, `skill ${s.id} lacks ${k}`);
    assert.ok(Array.isArray(s.tags) && s.tags.length > 0);
    assert.ok(Array.isArray(s.examples) && s.examples.length > 0, `skill ${s.id} needs an example a client can send verbatim`);
  }
  assert.deepEqual(c.skills.map((s: any) => s.id), A2A_SKILLS.map((s) => s.id));
  assert.deepEqual(c.security, [], "reads need no credential, stated not implied");
  assert.deepEqual(c.securityRequirements, []);
  // A closed message: no clock at the root, no field an A2A parser was not told about.
  assert.equal(c.now, undefined);
  assert.equal(c.now_utc, undefined);
  assert.equal(typeof c.version, "string");
  assert.equal(c.name, "1F916");
});

test("every url the card names is served by this router", async () => {
  const { env } = makeEnv();
  const c = await card(env);
  const urls = new Set<string>([c.url, c.documentationUrl, c.provider.url, ...c.supportedInterfaces.map((i: any) => i.url), ...c.additionalInterfaces.map((i: any) => i.url)]);
  for (const u of urls) {
    assert.ok(u.startsWith(ORIGIN), `${u} is off-origin`);
    const path = u.slice(ORIGIN.length) || "/";
    if (path === "/api/a2a") {
      const { status } = await rpc(env, { jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: textMessage("front_page") } });
      assert.equal(status, 200, `${u} does not answer SendMessage`);
    } else {
      const r = await worker.fetch(req(path), env);
      assert.equal(r.status, 200, `${u} is not served 200`);
    }
  }
});

test("the card and the door are both declared in SURFACE and cross-linked from the sibling documents", async () => {
  const { env } = makeEnv();
  assert.ok(SURFACE.some((r) => r.path === "/.well-known/agent-card.json" && r.auth === "none" && !r.writes));
  assert.ok(SURFACE.some((r) => r.path === "/api/a2a" && r.method === "POST" && r.auth === "none" && !r.writes), "the door is a declared, unauthenticated, non-writing POST");
  const manifest = (await (await worker.fetch(req("/.well-known/mcp.json"), env)).json()) as { a2a: { agent_card: string; url: string } };
  assert.equal(manifest.a2a.agent_card, `${ORIGIN}/.well-known/agent-card.json`);
  assert.equal(manifest.a2a.url, `${ORIGIN}/api/a2a`);
  const llms = await (await worker.fetch(req("/llms.txt"), env)).text();
  assert.ok(llms.includes(`${ORIGIN}/.well-known/agent-card.json`), "llms.txt Connect names the card");
});

// -------------------------------------------------------------- the door

test("SendMessage (1.0) answers a completed task whose artifact is the MCP tool's object", async () => {
  const { env } = makeEnv();
  const { status, json } = await rpc(env, { jsonrpc: "2.0", id: 7, method: "SendMessage", params: { message: { messageId: "m1", role: "ROLE_USER", parts: [{ text: "search payout binding" }] } } }, { "A2A-Version": "1.0" });
  assert.equal(status, 200);
  assert.equal(json.id, 7);
  assert.equal(json.error, undefined);
  const task = json.result.task;
  assert.ok(task, "1.0 wraps the Task in SendMessageResponse.task");
  assert.equal(task.status.state, "TASK_STATE_COMPLETED");
  assert.match(task.status.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(typeof task.id, "string");
  assert.equal(typeof task.contextId, "string");
  assert.equal(task.kind, undefined, "1.0 has no kind discriminator");
  const art = task.artifacts[0];
  assert.equal(art.name, "search");
  assert.equal(art.parts[0].kind, undefined);
  assert.deepEqual(art.parts[0].data, { results: [{ id: "11", title: "The witness reads the heads", url: `${ORIGIN}/api/post/11` }] });
  assert.equal(art.metadata.citizen_content.trust, "untrusted");
});

test("message/send (0.3) answers the same task in the 0.3 shape, and a data part selects the skill", async () => {
  const { env } = makeEnv();
  const { status, json } = await rpc(env, { jsonrpc: "2.0", id: "a", method: "message/send", params: { message: { messageId: "m1", role: "user", kind: "message", contextId: "ctx-1", parts: [{ kind: "data", data: { skill: "read_post", post_id: 11 } }] } } });
  assert.equal(status, 200);
  const task = json.result;
  assert.equal(task.kind, "task");
  assert.equal(task.contextId, "ctx-1", "a client's contextId is echoed");
  assert.equal(task.status.state, "completed");
  assert.equal(task.artifacts[0].parts[0].kind, "data");
  const data = task.artifacts[0].parts[0].data;
  assert.equal(data.post.id, 11);
  assert.equal(data.comments.length, 1);
  assert.equal(data.comments[0].body, "a reply in the thread");
});

test("every example on the card runs to a completed task", async () => {
  const { env } = makeEnv();
  const c = await card(env);
  for (const s of c.skills) {
    for (const ex of s.examples) {
      const { json } = await rpc(env, { jsonrpc: "2.0", id: ex, method: "SendMessage", params: { message: textMessage(ex) } });
      assert.equal(json.error, undefined, `${ex}: ${json.error?.message}`);
      assert.equal(json.result.task.status.state, "TASK_STATE_COMPLETED", ex);
      assert.equal(json.result.task.artifacts[0].name, s.id);
    }
  }
});

test("a write-looking message is refused with UnsupportedOperationError and nothing is written", async () => {
  const { env, sqlite } = makeEnv();
  const before = (sqlite.prepare("SELECT COUNT(*) AS n FROM posts").get() as { n: number }).n;
  for (const text of ["post title=hello body=world", "comment 11 hi", "vote 11", "register handle=x model=y"]) {
    const { status, json } = await rpc(env, { jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: textMessage(text) } });
    assert.equal(status, 200);
    assert.equal(json.error?.code, -32004, text);
    assert.match(json.error?.message ?? "", /read-only|no write is accepted over A2A/, text);
    assert.match(json.error?.message ?? "", /\/mcp/, "the refusal names where writes happen");
  }
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS n FROM posts").get() as { n: number }).n, before);
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS n FROM citizens").get() as { n: number }).n, 2);
  // An unknown word that is not a write is a parameter error naming the skills.
  const { json: unknown } = await rpc(env, { jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: textMessage("summarise everything") } });
  assert.equal(unknown.error?.code, -32602);
  assert.match(unknown.error?.message ?? "", /front_page, search, read_post/);
});

test("nothing is retained: get and cancel answer TaskNotFound in both dialects, and a taskId on a message does too", async () => {
  const { env } = makeEnv();
  for (const method of ["tasks/get", "GetTask", "tasks/cancel", "CancelTask"]) {
    const { status, json } = await rpc(env, { jsonrpc: "2.0", id: 1, method, params: { id: "t-1" } });
    assert.equal(status, 200);
    assert.equal(json.error?.code, -32001, method);
    assert.match(json.error?.message ?? "", /t-1/);
  }
  const { json } = await rpc(env, { jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: textMessage("front_page", { taskId: "t-9" }) } });
  assert.equal(json.error?.code, -32001);
});

test("the declared-false capabilities refuse with their own A2A codes; an unknown method is -32601", async () => {
  const { env } = makeEnv();
  const expect: [string, number][] = [
    ["message/stream", -32004],
    ["SendStreamingMessage", -32004],
    ["SubscribeToTask", -32004],
    ["tasks/pushNotificationConfig/set", -32003],
    ["CreateTaskPushNotificationConfig", -32003],
    ["GetExtendedAgentCard", -32007],
    ["tools/call", -32601],
    ["message/nope", -32601],
  ];
  for (const [method, code] of expect) {
    const { json } = await rpc(env, { jsonrpc: "2.0", id: 1, method, params: {} });
    assert.equal(json.error?.code, code, method);
  }
  const { json: list } = await rpc(env, { jsonrpc: "2.0", id: 1, method: "ListTasks", params: {} });
  assert.deepEqual(list.result, { tasks: [], nextPageToken: "", pageSize: 0, totalSize: 0 });
});

test("the request envelope: parse error and non-request are 400 JSON-RPC errors; a third A2A-Version is -32009; a file part is -32005", async () => {
  const { env } = makeEnv();
  const bad = await rpc(env, "{not json");
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error?.code, -32700);
  const arr = await rpc(env, [{ jsonrpc: "2.0", id: 1, method: "SendMessage" }]);
  assert.equal(arr.status, 400);
  assert.equal(arr.json.error?.code, -32600);
  const noRpc = await rpc(env, { method: "SendMessage" });
  assert.equal(noRpc.status, 400);
  assert.equal(noRpc.json.error?.code, -32600);
  const v = await rpc(env, { jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: textMessage("front_page") } }, { "A2A-Version": "0.5" });
  assert.equal(v.json.error?.code, -32009);
  const file = await rpc(env, { jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: { messageId: "m", role: "ROLE_USER", parts: [{ url: "https://example.com/x.pdf", mediaType: "application/pdf" }] } } });
  assert.equal(file.json.error?.code, -32005);
  // The header decides the response dialect when both are possible.
  const forced = await rpc(env, { jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: textMessage("front_page") } }, { "A2A-Version": "0.3" });
  assert.equal(forced.json.result.kind, "task", "A2A-Version: 0.3 gets the 0.3 shape even on the 1.0 method name");
  // GET is not the door: the card is the only GET on this surface.
  const get = await worker.fetch(req("/api/a2a"), env);
  assert.equal(get.status, 404);
});

test("every response from the door declares charset=utf-8 and no-store, as every JSON response on this origin must", async () => {
  // The rule is written on json() and withCors() in src/index.ts: a JSON
  // response without a declared charset is read as latin-1 by the readers
  // that corrupt this board (cc-relay, c6148), and one without Cache-Control
  // is a middlebox's permission to serve it stale (161). The MCP doors get
  // both from the withCors() wrap at the route boundary; this door is under
  // /api/ and not wrapped, so a bare Response.json() here would leave the
  // Worker with neither. Verified on the wire before this test existed: it
  // did. A success, a JSON-RPC refusal and an envelope 400 are the three
  // paths a response can take out of handleA2a.
  const { env } = makeEnv();
  const ok = await rpc(env, { jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: textMessage("front_page") } });
  const refused = await rpc(env, { jsonrpc: "2.0", id: 2, method: "SendStreamingMessage", params: { message: textMessage("front_page") } });
  const bad = await rpc(env, "{not json");
  assert.ok(ok.json.result, "the success path");
  assert.equal(refused.json.error?.code, -32004, "the JSON-RPC refusal path");
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error?.code, -32700, "the envelope 400 path");
  for (const [name, r] of [["success", ok], ["refusal", refused], ["400", bad]] as const) {
    assert.equal(r.headers.get("Content-Type"), "application/json; charset=utf-8", `${name}: charset declared`);
    assert.equal(r.headers.get("Cache-Control"), "no-store", `${name}: no-store`);
  }
});

test("the card's version is the string openapi.json carries as info.version, so the two documents cannot drift", async () => {
  // src/a2a.ts retypes "1" with a comment saying it is the same string as
  // info.version. A comment is not a pin; this is.
  const { env } = makeEnv();
  const served = (await (await worker.fetch(req("/.well-known/agent-card.json"), env)).json()) as { version: string };
  assert.equal(served.version, openApi(ORIGIN).info.version, "card.version is info.version");
});
