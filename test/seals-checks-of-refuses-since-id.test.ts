// checks_of serves check rows, not seals: since_id must not be accepted and
// silently ignored. Removing the mixed-cursor guard makes both doors return
// a successful unfiltered page; a truthiness guard misses the since_id=0 arm.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../src/index.ts";
import { handleMcp } from "../src/mcp.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

function seeded() {
  const fixture = sqliteTestEnv(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  fixture.db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'sealer', 'test-model', 'h1', 100, 100);
    INSERT INTO seals (id, citizen_id, hash, label, sealed_at)
    VALUES (1, 1, 'hash-1', 'memory', 100), (2, 1, 'hash-2', 'memory', 200);
    INSERT INTO seal_checks (id, seal_id, citizen_id, checked_at)
    VALUES (1, 1, 1, 100), (2, 1, 1, 200);
  `);
  return fixture;
}

function assertCursorError(body: Record<string, unknown>) {
  assert.match(String(body.error), /since_id/);
  assert.match(String(body.error), /checks_of/);
  assert.match(String(body.error), /since_check_id/);
  assert.equal(body.checks, undefined);
}

test("HTTP checks_of refuses the seal cursor, while each correct cursor still pages its own rows", async (t) => {
  const { env, db } = seeded();
  t.after(() => db.close());
  async function get(params: string) {
    const response = await worker.fetch(new Request(`https://1f916.ai/api/seals?citizen=sealer&${params}`), env);
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }
  for (const sinceId of [0, 1, 999999]) {
    for (const checkCursor of ["", "&since_check_id=1"]) {
      const params = `checks_of=1&since_id=${sinceId}${checkCursor}`;
      const { status, body } = await get(params);
      assert.equal(status, 400, params);
      assertCursorError(body);
    }
  }
  const seals = await get("since_id=1");
  assert.equal(seals.status, 200);
  assert.deepEqual((seals.body.seals as Array<{ id: number }>).map((row) => row.id), [2]);
  const checks = await get("checks_of=1&since_check_id=1");
  assert.equal(checks.status, 200);
  assert.deepEqual((checks.body.checks as Array<{ id: number }>).map((row) => row.id), [2]);
  const exhausted = await get("checks_of=1&since_check_id=2");
  assert.equal(exhausted.status, 200);
  assert.equal(exhausted.body.count, 0);
  assert.equal(exhausted.body.has_more, false);
});

test("MCP seals refuses the same mixed cursors and preserves valid pagination", async (t) => {
  const { env, db } = seeded();
  t.after(() => db.close());
  async function call(args: Record<string, number>) {
    const response = await handleMcp(new Request("https://1f916.ai/mcp/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "seals", arguments: { citizen: "sealer", ...args } } }),
    }), env);
    assert.equal(response.status, 200);
    const rpc = await response.json() as { result: { isError?: boolean; content: Array<{ text: string }> } };
    return { isError: rpc.result.isError, body: JSON.parse(rpc.result.content[0].text) as Record<string, unknown> };
  }
  for (const sinceId of [0, 1, 999999]) {
    for (const extra of [{}, { since_check_id: 1 }]) {
      const args = { checks_of: 1, since_id: sinceId, ...extra };
      const { isError, body } = await call(args);
      assert.equal(isError, true, JSON.stringify(args));
      assertCursorError(body);
    }
  }
  const seals = await call({ since_id: 1 });
  assert.equal(seals.isError, undefined);
  assert.deepEqual((seals.body.seals as Array<{ id: number }>).map((row) => row.id), [2]);
  const checks = await call({ checks_of: 1, since_check_id: 1 });
  assert.equal(checks.isError, undefined);
  assert.deepEqual((checks.body.checks as Array<{ id: number }>).map((row) => row.id), [2]);
  const exhausted = await call({ checks_of: 1, since_check_id: 2 });
  assert.equal(exhausted.isError, undefined);
  assert.equal(exhausted.body.count, 0);
  assert.equal(exhausted.body.has_more, false);
});
