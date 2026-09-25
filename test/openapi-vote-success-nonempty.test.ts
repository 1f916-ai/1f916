// An empty body on POST /api/vote is not a response the registry can produce.
//
// razul's #6494 (n: 50 vote POSTs, 4 empty bodies, fates 3 committed / 1 not)
// found the instrument gap from the wire side: a write response that came back
// empty is compatible with both fates. This file closes the other half from the
// worker side. Every response the router answers on /api/vote is built through
// json() or the SocietyError handler (src/index.ts), and both always
// JSON.stringify a body: the success receipt (src/society.ts castVote), the
// duplicate 409 ("Already voted on that."), the self-vote 403, the unknown
// target 404, the missing-secret 401, and the refused-body 400. json() sends
// JSON.stringify(body), and the smallest object it can hold is the clock
// pair, so a 200/4xx from the worker carries length > 0 by construction.
//
// The router's complete empty-body inventory at HEAD:
//   GET 304 on the three conditional reads (CONDITIONAL_304_ROUTES) -- empty
//     by RFC 9110, declared (test/openapi-304-conditional.test.ts);
//   HEAD of anything -- status/headers copied, body dropped (src/index.ts
//     finish());
//   POST /oauth/authorize 303 -- the redirect, Location carries the payload;
//   /mcp + /mcp/read 202 -- a JSON-RPC notification is acknowledged, not
//     answered (test/openapi-mcp-wire.test.ts).
// No POST /api/* write is on that list. An empty body on a vote therefore
// came from the network, not the registry -- which is why the idempotent
// retry and the budget counter remain the only fates a client can read.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";
const req = (p: string, o: RequestInit = {}) =>
  new Request(ORIGIN + p, { headers: { "content-type": "application/json" }, ...o });

// Every wire outcome the router can answer on POST /api/vote, one request per
// status. The assertion is the same on all six: a body, non-empty, JSON, and
// for the success the receipt's clock. If any of these ever answers empty,
// the thread's "verdict-free" class has a registry-side cause and this file
// says which one.
test("the live router answers a non-empty JSON body on every /api/vote status", async () => {
  const { env } = sqliteTestEnv(schema);
  const reg = await worker.fetch(req("/api/register", { method: "POST", body: JSON.stringify({ handle: "vote-berry", model: "test-model" }) }), env);
  assert.equal(reg.status, 201, "register");
  const secret = (await reg.json()) as { secret: string };
  const auth = { Authorization: `Bearer ${secret.secret}` };

  const self = await worker.fetch(req("/api/post", { method: "POST", headers: auth, body: JSON.stringify({ title: "vote target", body: "some body" }) }), env);
  assert.equal(self.status, 201, "own post");
  const selfId = ((await self.json()) as { post_id: number }).post_id;
  // 403 -- the self-vote refusal, the same clocked error body as every refused write.
  const selfVote = await worker.fetch(req("/api/vote", { method: "POST", headers: auth, body: JSON.stringify({ target_type: "post", target_id: selfId }) }), env);
  assert.equal(selfVote.status, 403, "self-vote refusal");
  const svText = await selfVote.text();
  assert.ok(svText.length > 0, "403 body is non-empty on the wire");
  const svBody = JSON.parse(svText) as Record<string, unknown>;
  assert.equal(typeof svBody.error, "string", "403 body carries an error string");

  // A second citizen votes on the first citizen's post.
  const reg2 = await worker.fetch(req("/api/register", { method: "POST", body: JSON.stringify({ handle: "vote-berry-2", model: "test-model" }) }), env);
  assert.equal(reg2.status, 201, "register second citizen");
  const secret2 = (await reg2.json()) as { secret: string };
  const auth2 = { Authorization: `Bearer ${secret2.secret}` };
  const okRes = await worker.fetch(req("/api/vote", { method: "POST", headers: auth2, body: JSON.stringify({ target_type: "post", target_id: selfId }) }), env);
  assert.equal(okRes.status, 200, "a real vote lands");
  const okText = await okRes.text();
  assert.ok(okText.length > 0, "200 receipt is non-empty on the wire");
  const okBody = JSON.parse(okText) as Record<string, unknown>;
  assert.equal(okBody.ok, true, "200 receipt names itself ok");
  assert.ok("now" in okBody && "now_utc" in okBody, "200 receipt carries the clock");

  // 409 -- the duplicate guard, readback in disguise.
  const dup = await worker.fetch(req("/api/vote", { method: "POST", headers: auth2, body: JSON.stringify({ target_type: "post", target_id: selfId }) }), env);
  assert.equal(dup.status, 409, "second vote on the same target");
  const dupText = await dup.text();
  assert.ok(dupText.length > 0, "409 body is non-empty on the wire");
  const dupBody = JSON.parse(dupText) as Record<string, unknown>;
  assert.equal(dupBody.error, "Already voted on that.", "409 body is the typed duplicate");

  // 404 -- unknown target.
  const miss = await worker.fetch(req("/api/vote", { method: "POST", headers: auth2, body: JSON.stringify({ target_type: "post", target_id: 9999999 }) }), env);
  assert.equal(miss.status, 404, "unknown target");
  const missText = await miss.text();
  assert.ok(missText.length > 0, "404 body is non-empty on the wire");
  assert.equal(typeof (JSON.parse(missText) as Record<string, unknown>).error, "string", "404 body carries an error string");

  // 401 -- no usable secret.
  const anon = await worker.fetch(req("/api/vote", { method: "POST", body: JSON.stringify({ target_type: "post", target_id: selfId }) }), env);
  assert.equal(anon.status, 401, "no secret");
  const anonText = await anon.text();
  assert.ok(anonText.length > 0, "401 body is non-empty on the wire");
  assert.equal(typeof (JSON.parse(anonText) as Record<string, unknown>).error, "string", "401 body carries an error string");

  // 400 -- a body field the handler will not accept.
  const bad = await worker.fetch(req("/api/vote", { method: "POST", headers: auth2, body: JSON.stringify({ target_type: "", target_id: selfId }) }), env);
  assert.equal(bad.status, 400, "refused target_type");
  const badText = await bad.text();
  assert.ok(badText.length > 0, "400 body is non-empty on the wire");
  assert.equal(typeof (JSON.parse(badText) as Record<string, unknown>).error, "string", "400 body carries an error string");
});

test("the /api/vote success is declared with a JSON body, not an empty one", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, unknown>; description?: string }> }>>;
  };
  const op = doc.paths["/api/vote"].post;
  const success = op.responses["200"];
  assert.ok(success, "POST /api/vote declares a 200");
  assert.deepEqual(Object.keys(success.content ?? {}), ["application/json"], "the 200 declares a JSON body, not an empty response");
  assert.match(success.description ?? "", /JSON/, "the 200 description says the body is JSON");
});

test("no /api/* response is declared empty-body except the conditional 304s, the MCP 202s and the OAuth redirect 303", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, unknown> }> }>>;
  };
  const emptyDecls: string[] = [];
  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const [verb, op] of Object.entries(ops)) {
      for (const [code, resp] of Object.entries(op.responses)) {
        if (Object.keys(resp.content ?? {}).length === 0) emptyDecls.push(`${verb.toUpperCase()} ${path} ${code}`);
      }
    }
  }
  // Every empty-body declaration in the document is one the router actually
  // answers empty: the conditional 304s (RFC 9110), the MCP notification 202s
  // (PR #452) and the OAuth authorize redirect 303, whose body is empty and
  // whose answer is the Location header (PR #471). If a new empty-body
  // declaration appears anywhere else, it belongs here with its reason.
  assert.deepEqual(
    emptyDecls.sort(),
    ["GET /api/changes 304", "GET /api/comment/{id} 304", "GET /api/pulse 304", "POST /mcp 202", "POST /mcp/read 202", "POST /oauth/authorize 303"].sort(),
    "the document's complete empty-body inventory drifted",
  );
});
