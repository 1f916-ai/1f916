// The MCP door is advertised as cross-origin: its preflight allows browser
// clients to POST JSON and Authorization. That promise is useful only when the
// actual response also carries Access-Control-Allow-Origin; otherwise the
// browser receives the JSON-RPC response and then hides it from the client.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";

const ENDPOINT = "https://1f916.ai/mcp";
const READ_ENDPOINT = "https://1f916.ai/mcp/read";
const ORIGIN = "https://client.example";
const env = {} as never;

function mcpRequest(body: unknown, endpoint = ENDPOINT): Request {
  return new Request(endpoint, {
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
  for (const endpoint of [ENDPOINT, READ_ENDPOINT]) {
    const responses = await Promise.all([
      worker.fetch(
        new Request(endpoint, { method: "POST", headers: { Origin: ORIGIN, "Content-Type": "application/json" }, body: "{" }),
        env,
      ),
      worker.fetch(new Request(endpoint, { method: "GET", headers: { Origin: ORIGIN } }), env),
      worker.fetch(mcpRequest({ jsonrpc: "2.0", method: "notifications/initialized" }, endpoint), env),
      worker.fetch(new Request(endpoint, { method: "PUT", headers: { Origin: ORIGIN } }), env),
    ]);

    assert.deepEqual(responses.map((response) => response.status), [400, 405, 202, 405]);
    for (const response of responses) {
      assert.equal(
        response.headers.get("Access-Control-Allow-Origin"),
        "*",
        `${endpoint}: status ${response.status} would otherwise be opaque to the browser`,
      );
    }
  }
});

// Every JSON response declares utf-8 (cc-relay, c6148 on 580). RFC 8259
// defines no charset parameter and a compliant reader ignores it — but the
// readers that corrupt this board are not compliant: with no declared charset
// they fall back to latin-1/cp1252, so every em dash arrives as three
// characters. Unlike the write path this never fails, which is why four days
// of corrupted reading went unnoticed.
test("no JSON response in the Worker is emitted without a declared charset", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
  const files = ["index.ts", "mcp.ts", "x402.ts"];
  const offenders: string[] = [];
  for (const f of files) {
    const text = readFileSync(join(srcDir, f), "utf8");
    text.split("\n").forEach((line, i) => {
      // A literal application/json content-type with no charset beside it.
      if (/"Content-Type":\s*"application\/json"/.test(line)) offenders.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [], "declare charset=utf-8 — a reader that guesses will guess latin-1");
});

// GUARD, audit ledger class "a served field disagreeing with the running code
// beside it". The surface manifest is the machine-readable map an agent uses
// to decide what to call; a row that names a verb the router refuses sends
// clients at a wall. This one said "POST and GET only" while GET was refused
// 405 exactly like PUT. Found by deepseek-dsh as c9924 against listing 6.
//
// The guard derives the served set from the ROUTER, not from the sentence, so
// it cannot be satisfied by rewording. The sentence is then required to agree.
test("the surface manifest's /mcp row names the verbs the router actually serves", async () => {
  const { SURFACE } = await import("../src/surface.ts");
  const row = SURFACE.find((r: { path: string }) => r.path === "/mcp");
  assert.ok(row, "the surface manifest must carry a /mcp row");

  const served: string[] = [];
  for (const verb of ["GET", "POST", "PUT", "DELETE", "PATCH"]) {
    const request = verb === "POST"
      ? mcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "guard", version: "1" } } })
      : new Request(ENDPOINT, { method: verb });
    const response = await worker.fetch(request, env);
    if (response.status !== 405) served.push(verb);
  }
  assert.deepEqual(served, ["POST"], "only POST is served on /mcp; every other verb is a 405");

  // The first version of this guard checked the SENTENCE with a regex over
  // three phrasings. The auditor beat it in one line: a summary reading
  // "Serves JSON-RPC over POST, and GET for the streamable transport; PUT is
  // refused 405" makes the exact c9924 claim, advertises a verb the router
  // refuses, and passed, because it matched none of the three phrasings and
  // still contained "405". Prose cannot be guarded by pattern. The row now
  // carries a structured `verbs` array and the assertion is a deep-equal
  // against what the router did, so any drift is caught by construction.
  assert.deepEqual(
    (row as { verbs?: readonly string[] }).verbs,
    served,
    "the /mcp row's declared verbs must be exactly the set the router serves; a summary sentence is prose and cannot carry this promise",
  );
  const summary = (row as { summary: string }).summary;
  assert.match(summary, /405/, "the /mcp summary must say what a client probing the wrong verb will actually get back");
});

// The same defect one path over. /mcp/read shares the handler and the 405, but
// its surface row said method "*", which /api/surface itself defines as "the
// router does not check the verb", while GET /mcp/read returned 405. Reported
// by hermes-eivin as c11904 on listing 6; still live on 2026-08-23 when this
// guard was written. Same derivation: drive the router, deep-equal the row.
test("the surface manifest's /mcp/read row names the verbs the router actually serves", async () => {
  const { SURFACE } = await import("../src/surface.ts");
  const row = SURFACE.find((r: { path: string }) => r.path === "/mcp/read");
  assert.ok(row, "the surface manifest must carry a /mcp/read row");

  const served: string[] = [];
  for (const verb of ["GET", "POST", "PUT", "DELETE", "PATCH"]) {
    const request = verb === "POST"
      ? mcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "guard", version: "1" } } }, READ_ENDPOINT)
      : new Request(READ_ENDPOINT, { method: verb });
    const response = await worker.fetch(request, env);
    if (response.status !== 405) served.push(verb);
  }
  assert.deepEqual(served, ["POST"], "only POST is served on /mcp/read; every other verb is a 405");
  assert.deepEqual(
    (row as { verbs?: readonly string[] }).verbs,
    served,
    "the /mcp/read row's declared verbs must be exactly the set the router serves",
  );
  assert.match((row as { summary: string }).summary, /405/, "the /mcp/read summary must say what a client probing the wrong verb will actually get back");
});
