// The MCP door is advertised as cross-origin: its preflight allows browser
// clients to POST JSON and Authorization. That promise is useful only when the
// actual response also carries Access-Control-Allow-Origin; otherwise the
// browser receives the JSON-RPC response and then hides it from the client.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";

const ENDPOINT = "https://1f916.ai/mcp";
const ORIGIN = "https://client.example";
const env = {} as never;

function mcpRequest(body: unknown): Request {
  return new Request(ENDPOINT, {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("the MCP response keeps the CORS promise made by its preflight", async () => {
  const preflight = await worker.fetch(
    new Request(ENDPOINT, {
      method: "OPTIONS",
      headers: {
        Origin: ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,authorization,mcp-protocol-version",
      },
    }),
    env,
  );
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), "*");
  assert.match(preflight.headers.get("Access-Control-Allow-Methods") ?? "", /POST/);
  assert.match(preflight.headers.get("Access-Control-Allow-Headers") ?? "", /Authorization/i);
  assert.match(
    preflight.headers.get("Access-Control-Allow-Headers") ?? "",
    /MCP-Protocol-Version/i,
    "the negotiated MCP version is required on requests after initialize and is not a CORS-safelisted header",
  );

  const response = await worker.fetch(
    mcpRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "cors-test", version: "1" },
      },
    }),
    env,
  );

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("Access-Control-Allow-Origin"),
    "*",
    "a browser discards the successful JSON-RPC body when the actual response omits this header",
  );
  const payload = (await response.json()) as { jsonrpc: string; id: number; result?: { serverInfo?: { name?: string } } };
  assert.equal(payload.jsonrpc, "2.0", "adding transport headers must not reshape the JSON-RPC envelope");
  assert.equal(payload.id, 1);
  assert.equal(payload.result?.serverInfo?.name, "1f916");

  const subsequent = await worker.fetch(
    new Request(ENDPOINT, {
      method: "POST",
      headers: {
        Origin: ORIGIN,
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    }),
    env,
  );
  assert.equal(subsequent.status, 200);
  assert.equal(subsequent.headers.get("Access-Control-Allow-Origin"), "*");
});

test("every MCP response path is CORS-readable", async () => {
  const responses = await Promise.all([
    worker.fetch(
      new Request(ENDPOINT, { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: "{" }),
      env,
    ),
    worker.fetch(new Request(ENDPOINT, { method: "GET", headers: { Origin: ORIGIN } }), env),
    worker.fetch(mcpRequest({ jsonrpc: "2.0", method: "notifications/initialized" }), env),
    worker.fetch(new Request(ENDPOINT, { method: "PUT", headers: { Origin: ORIGIN } }), env),
  ]);

  assert.deepEqual(responses.map((response) => response.status), [400, 405, 202, 405]);
  for (const response of responses) {
    assert.equal(
      response.headers.get("Access-Control-Allow-Origin"),
      "*",
      `status ${response.status} would otherwise be opaque to the browser`,
    );
  }
});
