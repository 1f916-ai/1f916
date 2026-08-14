// Issue #44: the MCP door accepted anything shaped vaguely like JSON-RPC.
// No jsonrpc version check, no string-method check, no params typing;
// notifications received response bodies because an absent id and a null id
// collapsed to the same value; and initialize echoed whatever protocolVersion
// the client sent while nothing read MCP-Protocol-Version. These tests pin the
// envelope parser that replaced the spot checks. Confirmed in source before
// fixing (issue comment, 2026-08-10); each case below failed against that code.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";

const ENDPOINT = "https://1f916.ai/mcp";
const env = {} as never;

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("a message without jsonrpc '2.0' is rejected as -32600, not dispatched", async () => {
  for (const jsonrpc of [undefined, "1.0", "2.1", 2, null]) {
    const res = await worker.fetch(post({ jsonrpc, id: 1, method: "ping" }), env);
    assert.equal(res.status, 400, `jsonrpc=${String(jsonrpc)} must not dispatch`);
    const body = (await res.json()) as { error?: { code: number } };
    assert.equal(body.error?.code, -32600);
  }
});

test("method must be a non-empty string", async () => {
  for (const method of [undefined, null, 7, "", { name: "ping" }]) {
    const res = await worker.fetch(post({ jsonrpc: "2.0", id: 1, method }), env);
    assert.equal(res.status, 400, `method=${JSON.stringify(method)} must not dispatch`);
    const body = (await res.json()) as { error?: { code: number } };
    assert.equal(body.error?.code, -32600);
  }
});

test("params, when present, must be an object", async () => {
  for (const params of [null, "x", 4, ["a"]]) {
    const res = await worker.fetch(post({ jsonrpc: "2.0", id: 1, method: "ping", params }), env);
    assert.equal(res.status, 400, `params=${JSON.stringify(params)} must not dispatch`);
    const body = (await res.json()) as { error?: { code: number } };
    assert.equal(body.error?.code, -32600);
  }
});

test("id, when present, must be a string, a number, or null", async () => {
  for (const id of [true, { n: 1 }, [1]]) {
    const res = await worker.fetch(post({ jsonrpc: "2.0", id, method: "ping" }), env);
    assert.equal(res.status, 400, `id=${JSON.stringify(id)} must not dispatch`);
    const body = (await res.json()) as { error?: { code: number } };
    assert.equal(body.error?.code, -32600);
  }
});

test("a notification gets 202 and no body, for any method, including unknown ones", async () => {
  for (const method of ["notifications/initialized", "notifications/cancelled", "no/such/method"]) {
    const res = await worker.fetch(post({ jsonrpc: "2.0", method }), env);
    assert.equal(res.status, 202, `${method} notification must be fire-and-forget`);
    assert.equal(await res.text(), "", "JSON-RPC forbids answering a notification, even with an error");
  }
});

test("id null is a request, not a notification: it receives a response addressed to null", async () => {
  const res = await worker.fetch(post({ jsonrpc: "2.0", id: null, method: "ping" }), env);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { id: unknown; result: unknown };
  assert.equal(body.id, null);
  assert.deepEqual(body.result, {});
});

test("a notification wearing a request's id is answered as an unknown method", async () => {
  const res = await worker.fetch(post({ jsonrpc: "2.0", id: 3, method: "notifications/initialized" }), env);
  const body = (await res.json()) as { error?: { code: number } };
  assert.equal(body.error?.code, -32601);
});

test("initialize negotiates protocolVersion instead of echoing it", async () => {
  // A supported request is granted verbatim.
  const supported = await worker.fetch(
    post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }),
    env,
  );
  const grantedBody = (await supported.json()) as { result: { protocolVersion: string } };
  assert.equal(grantedBody.result.protocolVersion, "2025-03-26");

  // A fictional revision is answered with the newest one this server speaks,
  // never agreed to. The old dispatcher echoed it back.
  const fictional = await worker.fetch(
    post({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2099-01-01" } }),
    env,
  );
  const counterBody = (await fictional.json()) as { result: { protocolVersion: string } };
  assert.equal(counterBody.result.protocolVersion, "2025-06-18");
});

test("an unsupported MCP-Protocol-Version header is a hard 400", async () => {
  const res = await worker.fetch(
    post({ jsonrpc: "2.0", id: 1, method: "ping" }, { "MCP-Protocol-Version": "2099-01-01" }),
    env,
  );
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error?: { code: number; message: string } };
  assert.equal(body.error?.code, -32600);
  assert.match(body.error?.message ?? "", /2025-06-18/, "the rejection names what the server does speak");
});

test("a supported MCP-Protocol-Version header passes", async () => {
  const res = await worker.fetch(
    post({ jsonrpc: "2.0", id: 1, method: "ping" }, { "MCP-Protocol-Version": "2025-06-18" }),
    env,
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { result: unknown };
  assert.deepEqual(body.result, {});
});

test("a top-level array is still refused as an unsupported batch", async () => {
  const res = await worker.fetch(post([{ jsonrpc: "2.0", id: 1, method: "ping" }]), env);
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error?: { code: number; message: string } };
  assert.equal(body.error?.code, -32600);
  assert.match(body.error?.message ?? "", /batch/);
});

test("a top-level primitive is refused before any dispatch", async () => {
  for (const raw of ['"ping"', "7", "null", "true"]) {
    const res = await worker.fetch(post(raw), env);
    assert.equal(res.status, 400, `top-level ${raw} must not dispatch`);
    const body = (await res.json()) as { error?: { code: number } };
    assert.equal(body.error?.code, -32600);
  }
});
