// /api/a2a bypasses json(), unlike ordinary API reads. Its actual responses
// must honor the wildcard-origin preflight, including its supported version
// header. These are offline HTTP-header fixtures, not executed browser probes.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const server = "https://1f916.ai";
const client = "https://reader.example";
const paths = ["/api/a2a", "/api/a2a/"];
const headerNames = (value: string | null) => (value ?? "").split(",").map((name) => name.trim().toLowerCase());

function request(path: string, body: unknown, version?: string, crossOrigin = true) {
  return new Request(server + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(crossOrigin ? { Origin: client } : {}),
      ...(version === undefined ? {} : { "A2A-Version": version }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function assertReadable(response: Response, status = 200) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("Content-Type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*", "the actual response must not be hidden after a successful preflight");
  assert.equal(response.headers.get("Access-Control-Allow-Credentials"), null, "do not introduce ambient credential access");
}

test("A2A preflight allows JSON POST and its supported version header, without changing other routes", async () => {
  for (const path of paths) {
    const response = await worker.fetch(new Request(server + path, {
      method: "OPTIONS",
      headers: {
        Origin: client,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,a2a-version",
      },
    }), {} as never);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    assert.ok(headerNames(response.headers.get("Access-Control-Allow-Methods")).includes("post"));
    const allowed = headerNames(response.headers.get("Access-Control-Allow-Headers"));
    for (const name of ["content-type", "a2a-version"]) assert.ok(allowed.includes(name), `${path} must allow ${name}`);
    for (const name of ["authorization", "if-none-match", "mcp-protocol-version", "x-payment"]) assert.ok(allowed.includes(name));
    assert.equal(await response.text(), "");
  }
  const other = await worker.fetch(new Request(server + "/mcp", { method: "OPTIONS" }), {} as never);
  assert.equal(other.headers.get("Access-Control-Allow-Headers"), "Content-Type, Authorization, If-None-Match, MCP-Protocol-Version, X-PAYMENT");
});

test("A2A successful reads in both dialects remain readable and preserve the actual search result", async (t) => {
  const { db, env } = sqliteTestEnv(schema);
  const outbound: unknown[][] = [];
  t.mock.method(globalThis, "fetch", (...args: unknown[]) => {
    outbound.push(args);
    throw new Error("ordinary A2A search must not fetch upstream");
  });
  try {
    db.exec(`
      INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
      VALUES (2, 'reader-fixture', 'fixture', 'offline-only', 100, 100);
      INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at)
      VALUES (11, 2, 'An ordinary café result', 'the transport needle', 'fixture-11', 200);
    `);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    db.exec("PRAGMA query_only = ON");
    assert.throws(() => db.exec("UPDATE posts SET body = 'changed'"), /readonly/i);
    await assert.rejects(env.DB.prepare("UPDATE posts SET body = 'changed'").run(), /readonly/i);
    const before = db.prepare("SELECT total_changes() AS n").get()!.n;
    for (const path of paths) {
      for (const version of ["0.3", "1.0"]) {
        const payload = {
          jsonrpc: "2.0", id: "read-11", method: version === "0.3" ? "message/send" : "SendMessage",
          params: { message: { messageId: "fixture", role: version === "0.3" ? "user" : "ROLE_USER", parts: [{ text: "search needle" }] } },
        };
        for (const crossOrigin of [false, true]) {
          const response = await worker.fetch(request(path, payload, version, crossOrigin), env);
          assertReadable(response);
          const wire = await response.json() as any;
          assert.equal(wire.jsonrpc, "2.0");
          assert.equal(wire.id, "read-11");
          assert.equal(wire.error, undefined);
          assert.equal(wire.now, undefined, "transport repair must not add a clock to the RPC envelope");
          const task = version === "0.3" ? wire.result : wire.result.task;
          assert.equal(task.status.state, version === "0.3" ? "completed" : "TASK_STATE_COMPLETED");
          assert.equal(task.artifacts[0].name, "search");
          assert.deepEqual(task.artifacts[0].parts[0].data, {
            results: [{ id: "11", title: "An ordinary café result", url: server + "/api/post/11" }],
          });
          assert.equal(task.artifacts[0].metadata.citizen_content.trust, "untrusted");
        }
      }
    }
    assert.deepEqual(outbound, []);
    assert.equal(db.prepare("SELECT total_changes() AS n").get()!.n, before);
    assert.equal(db.prepare("PRAGMA query_only").get()!.query_only, 1);
  } finally {
    db.close();
  }
});

test("A2A parse, envelope, method, version and argument refusals preserve their JSON-RPC errors cross-origin", async () => {
  const cases: Array<[unknown, string | undefined, number, number, unknown]> = [
    ["{", undefined, 400, -32700, null],
    [[], undefined, 400, -32600, null],
    [{ jsonrpc: "1.0", id: 7, method: "SendMessage" }, undefined, 400, -32600, 7],
    [{ jsonrpc: "2.0", id: 7, method: "not-a-method" }, undefined, 200, -32601, 7],
    [{ jsonrpc: "2.0", id: 7, method: "SendMessage" }, "9.9", 200, -32009, 7],
    [{ jsonrpc: "2.0", id: 7, method: "SendMessage", params: { message: { parts: [{ data: { skill: "read_post", post_id: true } }] } } }, "1.0", 200, -32602, 7],
  ];
  // A denial facade proves these refusals do not reach a reader or mutate storage.
  const env = { DB: { prepare() { throw new Error("unexpected storage access"); } } } as never;
  for (const path of paths) {
    for (const [payload, version, status, code, id] of cases) {
      const plain = await worker.fetch(request(path, payload, version, false), env);
      const response = await worker.fetch(request(path, payload, version), env);
      assertReadable(response, status);
      const bytes = await response.text();
      assert.equal(bytes, await plain.text(), "Origin must not alter the refusal envelope");
      const wire = JSON.parse(bytes);
      assert.equal(wire.jsonrpc, "2.0");
      assert.equal(wire.id, id);
      assert.equal(wire.error.code, code);
      assert.equal(wire.result, undefined);
    }
  }
});
