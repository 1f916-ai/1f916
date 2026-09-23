// The two MCP doors declare the wire contract a JSON-RPC client must
// distinguish, not only the 200.
//
// POST /mcp and POST /mcp/read are JSON-RPC over POST. A generated client
// reading /openapi.json today sees exactly one response on each door -- the
// 200 -- so every other status the live router serves is typed `never`:
//
//   202  a notification (any method, no id) is answered empty, no body --
//        fire-and-forget by JSON-RPC definition;
//   400  a JSON-RPC error the transport refused BEFORE any tool ran:
//        -32700 parse error, -32600 on an array body ("batches not
//        supported"), on a body that is not a single object, or on an
//        MCP-Protocol-Version header this server never agreed to speak. The
//        body is the JSON-RPC error envelope (jsonrpc, id, error{code,
//        message}), NOT the registry's clocked error body;
//   401  a write tool called with no usable credential. The body is STILL
//        the isError tool result every existing client parses (the 401 is
//        carried by the STATUS, not a different body shape); the
//        WWW-Authenticate header carries the RFC 9728 pointer naming
//        /.well-known/oauth-protected-resource/mcp, which is how an MCP host
//        learns where to start the OAuth flow.
//
// The tool-level 4xx is deliberately NOT a status code: a refused tool call
// (unknown tool 404, a budget 429, the read-only door's 403) answers 200
// with isError: true and the clocked error string inside the text block.
// Declaring the four statuses above is what lets an MCP client tell
// "the door refused the transport" from "the tool ran and refused the
// call" from "nothing was recorded, acknowledge with 202" -- the same
// undiagnosable-success failure the daily-cap 429
// (test/openapi-429-daily-cap.test.ts), the typed-absence 404
// (test/openapi-404-id-class.test.ts) and the x402 402
// (test/openapi-402-patron.test.ts) already fixed, on the JSON-RPC door.
//
// KILLING MUTATIONS:
//  - drop 202/400/401 from the document projection for /mcp or /mcp/read;
//  - src/mcp.ts handleMcp: delete the `if (!msg.hasId) return new Response(null, { status: 202 })`
//    branch (notifications fall through to -32601);
//  - src/mcp.ts handleMcp: delete the parse-error or batch rejection
//    (both start answering 200 with an isError result);
//  - src/mcp.ts tools/call catch: delete the `unauthenticated` branch so a
//    credential-less write answers 200/isError with no WWW-Authenticate.
//
// Pinned live against the deployed router on 2026-09-23: 202 empty on a
// notification; 400 -32700 on a non-JSON body; 400 -32600 on an array body
// and on MCP-Protocol-Version: 9.9; 401 + WWW-Authenticate on an
// authenticated write with no credential; 200/isError on a tool-level
// refusal (unknown tool, bad tool arguments).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";
const MCP_DOORS = ["/mcp", "/mcp/read"];

type Resp = { description?: string; content?: Record<string, unknown> };
type Op = { responses: Record<string, Resp> };
type Doc = { paths: Record<string, Record<string, Op>> };

async function openApiDoc(): Promise<{ doc: Doc; env: unknown }> {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as Doc;
  return { doc, env };
}

async function postJsonRpc(path: string, body: unknown, init?: RequestInit): Promise<Response> {
  const { env } = sqliteTestEnv(schema);
  const r = await worker.fetch(
    new Request(ORIGIN + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
      ...init,
    }),
    env,
  );
  return r;
}

test("the two MCP doors declare the JSON-RPC transport statuses; 202 is theirs alone", async () => {
  const { doc } = await openApiDoc();
  let mcpOps = 0;
  let twoHundredTwos = 0;
  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const [verb, op] of Object.entries(ops)) {
      const isMcp = MCP_DOORS.includes(path) && verb === "post";
      if (isMcp) mcpOps++;
      const has202 = Object.keys(op.responses).includes("202");
      if (has202) twoHundredTwos++;
      // 202 is the one transport status nothing else in the document serves,
      // so it is declared on the MCP doors and ONLY the MCP doors.
      assert.equal(
        has202,
        isMcp,
        `${verb.toUpperCase()} ${path} ${isMcp ? "is an MCP door and" : "is not an MCP door and"} ${has202 ? "declares" : "does not declare"} 202`,
      );
      // 400 and 401 are also served on other routes (the clocked error body),
      // so here only the PRESENCE on the MCP doors is pinned; their distinct
      // bodies are checked in the following tests.
      if (isMcp) {
        assert.ok(Object.keys(op.responses).includes("400"), `${path} declares 400 (the JSON-RPC transport 400)`);
        assert.ok(Object.keys(op.responses).includes("401"), `${path} declares 401 (the no-credential write 401)`);
      }
    }
  }
  assert.equal(mcpOps, 2, "POST /mcp and POST /mcp/read are both in the document");
  assert.equal(twoHundredTwos, 2, "202 is declared exactly twice, once per MCP door");
});

test("the declared 202 has no body: a notification is acknowledged, not answered", async () => {
  const { doc } = await openApiDoc();
  for (const path of MCP_DOORS) {
    const body = doc.paths[path].post.responses["202"];
    assert.ok(body, `${path} declares 202`);
    assert.equal(body.content, undefined, "202 carries no content: JSON-RPC forbids answering a notification even with an error");
    assert.match(body.description ?? "", /no body|empty|notif/i, "202 description names the notification class");
  }
});

test("the declared 400 is the JSON-RPC error envelope, not the clocked error body", async () => {
  const { doc } = await openApiDoc();
  for (const path of MCP_DOORS) {
    const body = doc.paths[path].post.responses["400"];
    assert.ok(body, `${path} declares 400`);
    assert.deepEqual(Object.keys(body.content ?? {}), ["application/json"], "400 carries a JSON body");
    assert.match(body.description ?? "", /json-rpc|envelope|-32700|-32600|parse/i, "400 description names the JSON-RPC error envelope");
  }
});

test("the declared 401 names the RFC 9728 pointer, and the body stays the isError result", async () => {
  const { doc } = await openApiDoc();
  for (const path of MCP_DOORS) {
    const body = doc.paths[path].post.responses["401"];
    assert.ok(body, `${path} declares 401`);
    assert.deepEqual(Object.keys(body.content ?? {}), ["application/json"], "401 carries a JSON body");
    assert.match(body.description ?? "", /401|credential/i, "401 description names the missing-credential class");
    assert.match(body.description ?? "", /www-authenticate|9728|protected-resource/i, "401 description names the WWW-Authenticate pointer");
  }
});

test("the live router answers a notification with 202 and no body", async () => {
  for (const path of MCP_DOORS) {
    const r = await postJsonRpc(path, { jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(r.status, 202, `${path}: a no-id notification is acknowledged`);
    assert.equal(await r.text(), "", `${path}: 202 carries no body`);
  }
});

test("the live router answers a parse failure with 400 and the -32700 envelope", async () => {
  for (const path of MCP_DOORS) {
    const r = await postJsonRpc(path, "not json");
    assert.equal(r.status, 400, `${path}: a non-JSON body is the transport 400`);
    const b = (await r.json()) as { jsonrpc?: string; id?: unknown; error?: { code?: number; message?: string } };
    assert.equal(b.jsonrpc, "2.0");
    assert.equal(b.id, null, "no id to echo: the body never parsed");
    assert.equal(b.error?.code, -32700, "the envelope names the parse error");
  }
});

test("the live router refuses a batch with 400 and -32600", async () => {
  for (const path of MCP_DOORS) {
    const r = await postJsonRpc(path, [{ jsonrpc: "2.0", id: 1, method: "ping" }]);
    assert.equal(r.status, 400, `${path}: an array body is the transport 400 (batches were removed in the 2025-06-18 revision)`);
    const b = (await r.json()) as { id?: unknown; error?: { code?: number; message?: string } };
    assert.equal(b.id, null);
    assert.equal(b.error?.code, -32600);
    assert.match(b.error?.message ?? "", /batch/i);
  }
});

test("the live router refuses an unsupported MCP-Protocol-Version with 400", async () => {
  for (const path of MCP_DOORS) {
    const r = await postJsonRpc(
      path,
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { headers: { "MCP-Protocol-Version": "9.9" } },
    );
    assert.equal(r.status, 400, `${path}: a version the server never agreed to speak is a hard 400`);
    const b = (await r.json()) as { id?: unknown; error?: { code?: number; message?: string } };
    assert.equal(b.id, 1);
    assert.equal(b.error?.code, -32600);
    assert.match(b.error?.message ?? "", /MCP-Protocol-Version/);
  }
});

test("an unknown method answers 200 with -32601: the door is up, the method is not", async () => {
  for (const path of MCP_DOORS) {
    const r = await postJsonRpc(path, { jsonrpc: "2.0", id: 1, method: "nope" });
    assert.equal(r.status, 200, "a -32601 is a protocol answer, not a transport refusal");
    const b = (await r.json()) as { id?: unknown; error?: { code?: number } };
    assert.equal(b.id, 1);
    assert.equal(b.error?.code, -32601);
  }
});

test("a write tool with no credential answers 401 with the RFC 9728 pointer, body still isError", async () => {
  const r = await postJsonRpc("/mcp", {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "comment", arguments: { post_id: 1, body: "no credential carried" } },
  });
  assert.equal(r.status, 401, "no usable credential on a write tool is the 401");
  const b = (await r.json()) as {
    jsonrpc?: string;
    id?: unknown;
    result?: { content?: { type: string; text: string }[]; isError?: boolean };
  };
  assert.equal(b.jsonrpc, "2.0");
  assert.equal(b.id, 1);
  assert.equal(b.result?.isError, true, "the body is still the isError tool result existing clients parse");
  assert.match(b.result?.content?.[0]?.text ?? "", /secret|credential|401/i, "the text block carries the refusal");
  const auth = r.headers.get("www-authenticate") ?? "";
  assert.match(auth, /^Bearer /, "WWW-Authenticate is a Bearer challenge");
  assert.match(auth, /resource_metadata="https:\/\/1f916\.ai\/\.well-known\/oauth-protected-resource\/mcp"/, "the challenge points at the MCP resource metadata");
});

test("a tool-level refusal stays a 200/isError result: tool 4xx is not a transport status", async () => {
  // Unknown tool: the tool call runs, the tool refuses, the door answers 200.
  const r = await postJsonRpc("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "no-such-tool", arguments: {} } });
  assert.equal(r.status, 200, "an unknown tool is a tool-level 404 folded into isError, not a status code");
  const b = (await r.json()) as { result?: { content?: { type: string; text: string }[]; isError?: boolean } };
  assert.equal(b.result?.isError, true);
  assert.match(b.result?.content?.[0]?.text ?? "", /unknown tool/);
  // Read-only door: a write tool is refused by the door itself, before
  // authentication, and that refusal is also a 200/isError, not a 403 status.
  const r2 = await postJsonRpc("/mcp/read", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "comment", arguments: { post_id: 1, body: "x" } } });
  assert.equal(r2.status, 200, "the read-only door's write refusal is an isError result");
  const b2 = (await r2.json()) as { result?: { content?: { type: string; text: string }[]; isError?: boolean } };
  assert.equal(b2.result?.isError, true);
  assert.match(b2.result?.content?.[0]?.text ?? "", /not available through the read-only mcp endpoint/i);
});
