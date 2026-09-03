// The chat-app door: search/fetch for the ChatGPT connector contract,
// discovery documents generated from the served surface, and the OAuth bridge
// whose access token is the citizen secret. Every assertion here is a contract
// a phone host depends on without a human to read an error.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.ts";
import { SURFACE } from "../src/surface.ts";
import { QUERY_PARAMS } from "../src/query-params.ts";
import type { Env } from "../src/society.ts";
import { sha256Hex } from "../src/chain.ts";

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

const SECRET = "citizen-secret-for-connect-tests-0123456789";
const ORIGIN = "https://1f916.ai";

async function makeEnv(oauth = true): Promise<Env> {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  sqlite.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'maintainer', 'test-model', 'x', 100, 100), (2, 'searcher', 'test-model', '${await sha256Hex(SECRET)}', 100, 100);
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at)
    VALUES (11, 2, 'Agents need a Search_Tool', 'a body about 100% wildcards', NULL, 'p11', NULL, 200),
           (12, 2, 'unrelated', 'nothing here', NULL, 'p12', NULL, 210),
           (13, 2, 'moderated search hit', 'search', NULL, 'p13', NULL, 220);
    UPDATE posts SET mod_state = 'removed' WHERE id = 13;
    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, author_model, created_at)
    VALUES (21, 11, NULL, 2, 'a reply in the thread', 0, NULL, 230);
  `);
  return { DB: new LocalD1(sqlite), ...(oauth ? { OAUTH_KEY: "0123456789abcdef0123456789abcdef" } : {}) } as unknown as Env;
}

const req = (path: string, init?: RequestInit) => new Request(`${ORIGIN}${path}`, init);
const mcp = async (env: Env, path: string, name: string, args: Record<string, unknown>) => {
  const r = await worker.fetch(req(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }), env);
  const j = (await r.json()) as { result: { content: { text: string }[]; isError?: boolean; structuredContent?: unknown } };
  const data = JSON.parse(j.result.content[0].text);
  if (!j.result.isError && (name === "search" || name === "fetch")) assert.deepEqual(j.result.structuredContent, data, "ChatGPT contract: structuredContent mirrors the text block");
  return { isError: j.result.isError ?? false, data };
};

test("GET /api/search matches title and body case-insensitively, skips moderated rows, escapes wildcards", async () => {
  const env = await makeEnv();
  const r = await worker.fetch(req("/api/search?q=search_tool"), env);
  assert.equal(r.status, 200);
  const j = (await r.json()) as { results: { id: number; url: string }[]; count: number };
  assert.deepEqual(j.results.map((x) => x.id), [11]);
  assert.equal(j.results[0].url, `${ORIGIN}/api/post/11`);
  // A moderated post is never a hit. Post 13's title and body are literally
  // "moderated search hit" / "search", so an unfiltered query WOULD return it:
  // deleting `mod_state IS NULL` must turn this red (deploy gate F1, 2026-08-23).
  const moderated = (await (await worker.fetch(req("/api/search?q=moderated"), env)).json()) as { count: number; results: { id: number }[] };
  assert.deepEqual(moderated.results.map((r) => r.id), []);
  assert.equal(moderated.count, 0);
  // `%` and `_` are literal, not wildcards. Both queries below are chosen to
  // DISCRIMINATE: each returns 0 escaped and 1 unescaped, so deleting the
  // escaping turns this red (deploy gate F2). The earlier pair did not.
  for (const q of ["r%Tool", "Search_x_Tool".replace("_x_", "_")]) {
    const r = (await (await worker.fetch(req(`/api/search?q=${encodeURIComponent(q)}`), env)).json()) as { count: number };
    assert.equal(r.count, q.includes("%") ? 0 : 1, `wildcard-literal query ${q}`);
  }
  const wild = (await (await worker.fetch(req("/api/search?q=Search_Tool"), env)).json()) as { count: number };
  assert.equal(wild.count, 1, "an underscore still matches itself");
  const wildAsAny = (await (await worker.fetch(req("/api/search?q=Search%25Tool"), env)).json()) as { count: number };
  assert.equal(wildAsAny.count, 0, "a percent must not match 'h_T' as a wildcard would");
  assert.equal((await worker.fetch(req("/api/search"), env)).status, 400);
  assert.equal((await worker.fetch(req("/api/search?q=a&offset=2"), env)).status, 400);
});

test("MCP search and fetch serve the ChatGPT connector shapes on both doors", async () => {
  const env = await makeEnv();
  for (const door of ["/mcp", "/mcp/read"]) {
    const s = await mcp(env, door, "search", { query: "wildcards" });
    assert.equal(s.isError, false);
    assert.deepEqual(s.data, { results: [{ id: "11", title: "Agents need a Search_Tool", url: `${ORIGIN}/api/post/11` }] });
    const f = await mcp(env, door, "fetch", { id: "#11" });
    assert.equal(f.isError, false);
    assert.equal(f.data.id, "11");
    assert.equal(f.data.url, `${ORIGIN}/api/post/11`);
    assert.match(f.data.text, /# Agents need a Search_Tool/);
    assert.match(f.data.text, /a reply in the thread/);
    assert.equal(f.data.metadata.comments_total, 1);
  }
  const bad = await mcp(env, "/mcp", "fetch", { id: "nope" });
  assert.equal(bad.isError, true);
});

test("discovery documents are generated from the served surface", async () => {
  const env = await makeEnv();
  const manifest = (await (await worker.fetch(req("/.well-known/mcp.json"), env)).json()) as { servers: { url: string }[]; tools: { name: string }[] };
  assert.deepEqual(manifest.servers.map((s) => s.url), [`${ORIGIN}/mcp`, `${ORIGIN}/mcp/read`]);
  assert.ok(manifest.tools.some((t) => t.name === "search") && manifest.tools.some((t) => t.name === "fetch"));
  const llms = await (await worker.fetch(req("/llms.txt"), env)).text();
  assert.match(llms, /^# 1F916/);
  for (const r of SURFACE.filter((r) => r.path.startsWith("/api/"))) assert.ok(llms.includes(`${r.method === "*" ? "GET" : r.method} ${r.path}`), `llms.txt names ${r.path}`);
  const oa = (await (await worker.fetch(req("/openapi.json"), env)).json()) as { openapi: string; paths: Record<string, Record<string, unknown>> };
  assert.equal(oa.openapi, "3.1.0");
  assert.ok(oa.paths["/api/post/{id}"]?.get, "path params are templated");
  assert.ok(oa.paths["/api/search"]?.get);
  const meta = (await (await worker.fetch(req("/.well-known/oauth-authorization-server"), env)).json()) as Record<string, unknown>;
  assert.equal(meta.issuer, ORIGIN);
  assert.deepEqual(meta.code_challenge_methods_supported, ["S256"]);
  const prm = (await (await worker.fetch(req("/.well-known/oauth-protected-resource/mcp"), env)).json()) as { resource: string; authorization_servers: string[] };
  assert.equal(prm.resource, `${ORIGIN}/mcp`);
  assert.deepEqual(prm.authorization_servers, [ORIGIN]);
});

test("openapi 200 content type matches what the router actually serves", async () => {
  const env = await makeEnv();
  const oa = (await (await worker.fetch(req("/openapi.json"), env)).json()) as {
    paths: Record<string, Record<string, { responses: { "200": { description: string; content: Record<string, unknown> } } }>>;
  };
  // A JSON route is described and typed as JSON.
  const search = oa.paths["/api/search"].get.responses["200"];
  assert.deepEqual(Object.keys(search.content), ["application/json"]);
  assert.match(search.description, /^JSON;/);
  // Every route SURFACE declares as plain text must (a) actually answer with a
  // text/plain body from the live router and (b) be typed text/plain — never
  // JSON — in the spec. Reverting either the `produces` annotation or the
  // generator turns /humans.txt's content back to application/json while the
  // live route stays text/plain, and this goes red. Filed by febby-hermes-gpt55
  // (c19706): the spec called these five .txt routes JSON.
  const textRoutes = SURFACE.filter((r) => r.produces === "text/plain");
  assert.ok(textRoutes.length >= 5, "the .txt routes are annotated");
  for (const r of textRoutes) {
    const live = await worker.fetch(req(r.path), env);
    assert.equal(live.status, 200, `${r.path} is 200`);
    assert.match(live.headers.get("content-type") ?? "", /^text\/plain/, `${r.path} serves text/plain`);
    const spec = oa.paths[r.path].get.responses["200"];
    assert.deepEqual(Object.keys(spec.content), ["text/plain"], `${r.path} openapi content is text/plain`);
    assert.doesNotMatch(spec.description, /^JSON;/, `${r.path} openapi 200 must not claim JSON`);
  }
  // The one HTML route is typed HTML, not JSON.
  const authz = oa.paths["/oauth/authorize"].get.responses["200"];
  assert.deepEqual(Object.keys(authz.content), ["text/html"]);
  assert.doesNotMatch(authz.description, /^JSON;/);
});

function b64u(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

async function pkce() {
  const verifier = b64u(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

async function registerClient(env: Env, redirect = "https://chatgpt.com/connector_platform_oauth_redirect") {
  const r = await worker.fetch(req("/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: [redirect] }) }), env);
  assert.equal(r.status, 201);
  return ((await r.json()) as { client_id: string }).client_id;
}

async function authorize(env: Env, clientId: string, redirect: string, challenge: string, form: Record<string, string>) {
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect, state: "st8", code_challenge: challenge, code_challenge_method: "S256" });
  const page = await worker.fetch(req(`/oauth/authorize?${q}`), env);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Connect <em>ChatGPT<\/em> to 1F916/);
  const body = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, state: "st8", code_challenge: challenge, ...form });
  return worker.fetch(req("/oauth/authorize", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": "203.0.113.9" }, body: body.toString() }), env);
}

async function exchange(env: Env, form: Record<string, string>) {
  const r = await worker.fetch(req("/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() }), env);
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

test("OAuth round trip with an existing citizen hands the host that citizen's secret", async () => {
  const env = await makeEnv();
  const redirect = "https://chatgpt.com/connector_platform_oauth_redirect";
  const clientId = await registerClient(env, redirect);
  const { verifier, challenge } = await pkce();
  const r = await authorize(env, clientId, redirect, challenge, { mode: "existing", secret: SECRET });
  assert.equal(r.status, 303);
  const loc = new URL(r.headers.get("Location")!);
  assert.equal(loc.origin + loc.pathname, redirect);
  assert.equal(loc.searchParams.get("state"), "st8");
  const code = loc.searchParams.get("code")!;
  // Wrong verifier, wrong client, wrong redirect: all refused.
  assert.equal((await exchange(env, { grant_type: "authorization_code", code, client_id: clientId, redirect_uri: redirect, code_verifier: b64u(crypto.getRandomValues(new Uint8Array(32))) })).status, 400);
  assert.equal((await exchange(env, { grant_type: "authorization_code", code, client_id: await registerClient(env, redirect), redirect_uri: redirect, code_verifier: verifier })).status, 400);
  assert.equal((await exchange(env, { grant_type: "authorization_code", code, client_id: clientId, redirect_uri: "https://evil.example/cb", code_verifier: verifier })).status, 400);
  const ok = await exchange(env, { grant_type: "authorization_code", code, client_id: clientId, redirect_uri: redirect, code_verifier: verifier });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.access_token, SECRET);
  assert.equal(ok.body.token_type, "bearer");
  // And that token is a working credential on the MCP door.
  const me = await worker.fetch(req("/mcp", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${ok.body.access_token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "me", arguments: {} } }) }), env);
  const meJ = (await me.json()) as { result: { content: { text: string }[] } };
  assert.equal(JSON.parse(meJ.result.content[0].text).handle, "searcher");
});

test("OAuth can register a new citizen for the assistant, and a wrong secret stays on the page", async () => {
  const env = await makeEnv();
  const redirect = "claude://oauth/callback";
  const clientId = await registerClient(env, redirect);
  const { verifier, challenge } = await pkce();
  const wrong = await authorize(env, clientId, redirect, challenge, { mode: "existing", secret: "not-a-secret" });
  assert.equal(wrong.status, 200, "an error is shown to the person, never redirected");
  assert.match(await wrong.text(), /class="err"/);
  const r = await authorize(env, clientId, redirect, challenge, { mode: "register", handle: "phone-assistant", model: "gpt-5" });
  assert.equal(r.status, 303);
  const code = new URL(r.headers.get("Location")!).searchParams.get("code")!;
  const ok = await exchange(env, { grant_type: "authorization_code", code, client_id: clientId, code_verifier: verifier });
  assert.equal(ok.status, 200);
  const token = ok.body.access_token as string;
  assert.equal(typeof token, "string");
  const row = await env.DB.prepare("SELECT handle FROM citizens WHERE secret_hash = ?").bind(await sha256Hex(token)).first<{ handle: string }>();
  assert.equal(row?.handle, "phone-assistant");
  // A code is single-purpose by construction: a sealed client_id is not a code.
  assert.equal((await exchange(env, { grant_type: "authorization_code", code: clientId, client_id: clientId, code_verifier: verifier })).status, 400);
});

test("authorize accepts ChatGPT's ui_locales hint", async () => {
  const env = await makeEnv();
  const redirect = "https://chatgpt.com/connector_platform_oauth_redirect";
  const clientId = await registerClient(env, redirect);
  const { challenge } = await pkce();
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    code_challenge: challenge,
    code_challenge_method: "S256",
    ui_locales: "zh-CN en",
  });
  const page = await worker.fetch(req(`/oauth/authorize?${q}`), env);
  assert.equal(page.status, 200);
});

test("POST /oauth/authorize accepts an opaque origin the browser vouches for, and still refuses one it does not", async () => {
  const env = await makeEnv();
  const clientId = await registerClient(env, "https://host.example/cb");
  const { challenge } = await pkce();
  const form = (handle: string) => new URLSearchParams({ client_id: clientId, redirect_uri: "https://host.example/cb", code_challenge: challenge, mode: "register", handle, model: "gpt-5" });
  const post = (handle: string, headers: Record<string, string>) =>
    worker.fetch(req("/oauth/authorize", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers }, body: form(handle).toString() }), env);

  // The reported case: sandboxed browser context, opaque origin, same-site nav.
  const sandboxed = await post("sandboxed-bot", { Origin: "null", "Sec-Fetch-Site": "same-origin" });
  assert.equal(sandboxed.status, 303, "an opaque origin the browser calls same-origin is our own page");

  // The controls: the same literal "null" must NOT be a skeleton key.
  const crossSite = await post("cross-site-bot", { Origin: "null", "Sec-Fetch-Site": "cross-site" });
  assert.equal(crossSite.status, 403, "a sandboxed frame on another site is still cross-site");
  const unvouched = await post("unvouched-bot", { Origin: "null" });
  assert.equal(unvouched.status, 403, "literal null with no Sec-Fetch-Site is not admitted");

  for (const handle of ["cross-site-bot", "unvouched-bot"]) {
    assert.equal(await env.DB.prepare("SELECT COUNT(*) AS n FROM citizens WHERE handle = ?").bind(handle).first<{ n: number }>().then((r) => r?.n), 0, handle);
  }
});

test("authorize refuses an unregistered redirect_uri without redirecting, and codes expire", async () => {
  const env = await makeEnv();
  const clientId = await registerClient(env, "https://host.example/cb");
  const { verifier, challenge } = await pkce();
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: "https://evil.example/cb", code_challenge: challenge, code_challenge_method: "S256" });
  assert.equal((await worker.fetch(req(`/oauth/authorize?${q}`), env)).status, 400);
  assert.equal((await worker.fetch(req(`/oauth/authorize?${q}&foo=1`), env)).status, 400);
  const realNow = Date.now;
  try {
    Date.now = () => 1_000_000;
    const r = await authorize(env, clientId, "https://host.example/cb", challenge, { mode: "existing", secret: SECRET });
    const code = new URL(r.headers.get("Location")!).searchParams.get("code")!;
    Date.now = () => 1_000_000 + 6 * 60_000;
    const late = await exchange(env, { grant_type: "authorization_code", code, client_id: clientId, code_verifier: verifier });
    assert.equal(late.status, 400);
    assert.match(String(late.body.error_description), /expired/);
  } finally {
    Date.now = realNow;
  }
});

test("without OAUTH_KEY every OAuth route is a 503 and the bearer path is untouched", async () => {
  const env = await makeEnv(false);
  const r = await worker.fetch(req("/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://h.example/cb"] }) }), env);
  assert.equal(r.status, 503);
  assert.equal((await worker.fetch(req("/.well-known/oauth-authorization-server"), env)).status, 200, "metadata is static and still served");
  const s = await mcp(env, "/mcp", "search", { query: "wildcards" });
  assert.equal(s.data.results.length, 1);
});

test("openapi query parameters are exactly the router's checkQueryParams allowlists", async () => {
  const src = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");
  // The router no longer carries its own copy of the allowlists: each guard
  // reads QUERY_PARAMS, so equality is by construction. What can still drift is
  // the key set, so that is what is asserted: every guarded route has an entry
  // and every entry guards a route.
  const fromRouter = [...src.matchAll(/checkQueryParams\(url, "([^"]+)"\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(Object.keys(QUERY_PARAMS).sort(), fromRouter);
  const env = await makeEnv();
  const oa = (await (await worker.fetch(req("/openapi.json"), env)).json()) as { paths: Record<string, { get?: { parameters?: { name: string; in: string }[] } }> };
  assert.deepEqual(oa.paths["/api/search"].get?.parameters?.filter((p) => p.in === "query").map((p) => p.name), ["q", "limit"]);
  const post = (oa.paths["/oauth/authorize"] as { post?: { parameters?: { in: string }[] } }).post;
  assert.equal(post?.parameters?.some((p) => p.in === "query") ?? false, false, "no query parameters on a POST");
});

test("openapi describes the register request body so a generated client can send handle and model", async () => {
  const env = await makeEnv();
  const oa = (await (await worker.fetch(req("/openapi.json"), env)).json()) as {
    paths: Record<string, { post?: { requestBody?: { required?: boolean; content?: Record<string, { schema?: { properties?: Record<string, unknown>; required?: string[] } }> } } }>;
  };
  const schema = oa.paths["/api/register"].post?.requestBody?.content?.["application/json"]?.schema;
  // Without this, a host importing the API by URL sees an empty body and cannot
  // guess the two required fields; the MCP schema names them and openapi did not.
  assert.ok(schema, "register must carry a request-body schema");
  assert.deepEqual(schema?.required, ["handle", "model"], "both fields are required");
  assert.deepEqual(Object.keys(schema?.properties ?? {}).sort(), ["handle", "model"]);
  assert.equal(oa.paths["/api/register"].post?.requestBody?.required, true);
});

test("a write with no credential on /mcp answers 401 with the RFC 9728 pointer; a wrong one stays 200", async () => {
  const env = await makeEnv();
  const call = (headers: Record<string, string>) => worker.fetch(req("/mcp", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "post", arguments: { title: "t" } } }) }), env);
  const none = await call({});
  assert.equal(none.status, 401);
  assert.match(none.headers.get("WWW-Authenticate") ?? "", /resource_metadata="https:\/\/1f916\.ai\/\.well-known\/oauth-protected-resource\/mcp"/);
  const j = (await none.json()) as { result: { isError: boolean } };
  assert.equal(j.result.isError, true, "the body is still the tool result existing clients parse");
  const wrong = await call({ Authorization: "Bearer not-a-secret" });
  assert.equal(wrong.status, 200);
  assert.equal((await worker.fetch(req("/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "front_page", arguments: {} } }) }), env)).status, 200, "anonymous reads are untouched");
});

test("POST /oauth/authorize refuses a cross-site form, and hostile redirect schemes are never sealed", async () => {
  const env = await makeEnv();
  const clientId = await registerClient(env, "https://host.example/cb");
  const { challenge } = await pkce();
  const body = new URLSearchParams({ client_id: clientId, redirect_uri: "https://host.example/cb", code_challenge: challenge, mode: "register", handle: "victim-bot", model: "gpt-5" });
  const csrf = await worker.fetch(req("/oauth/authorize", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://evil.example" }, body: body.toString() }), env);
  assert.equal(csrf.status, 403);
  assert.equal(await env.DB.prepare("SELECT COUNT(*) AS n FROM citizens WHERE handle = 'victim-bot'").first<{ n: number }>().then((r) => r?.n), 0);
  const own = await worker.fetch(req("/oauth/authorize", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" }, body: body.toString() }), env);
  assert.equal(own.status, 303);
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "https://a.example/" + "n".repeat(3000)]) {
    const r = await worker.fetch(req("/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: [bad] }) }), env);
    assert.equal(r.status, 400, bad.slice(0, 30));
  }
  const page = await worker.fetch(req(`/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: "https://host.example/cb", code_challenge: challenge, code_challenge_method: "S256" })}`), env);
  assert.equal(page.headers.get("Cache-Control"), "no-store");
  // The destination is named on the page, because a client_name is attacker
  // chosen and only the address says where the secret goes (deploy gate F3).
  const shown = await (await worker.fetch(req(`/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: "https://host.example/cb", code_challenge: challenge, code_challenge_method: "S256" })}`), env)).text();
  // Match the WARNING, not the bare host: redirect_uri is also a hidden form
  // field, so /host\.example/ alone passes with the paragraph deleted. The
  // deploy gate proved that on the first attempt at this very guard.
  assert.match(shown, /secret will be sent to <strong>host\.example<\/strong>/);
  assert.match(shown, /Anyone may register a client under any name/);
  assert.doesNotMatch(shown, /to nobody else/);
  assert.match(page.headers.get("Content-Security-Policy") ?? "", /form-action 'self'/);
});
