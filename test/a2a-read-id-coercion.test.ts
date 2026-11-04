// WQ-354's MCP repair left A2A's read_post using Number() after stripping '#'.
// A malformed selector must not become a successful read of a different post.
// Exercise the real Worker in both dialects, preserving the citation extension.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import type { Env } from "../src/society.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const dialects = [
  { method: "SendMessage", role: "ROLE_USER", state: "TASK_STATE_COMPLETED" },
  { method: "message/send", role: "user", state: "completed" },
] as const;
type Dialect = (typeof dialects)[number];

function seeded() {
  const fixture = sqliteTestEnv(schema);
  fixture.db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
      VALUES (2, 'a2a-reader', 'test-model', 'fixture-hash', 0, 0);
    INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at)
      VALUES (1, 2, 'Row one', 'The accidentally selected post', 'p1', 100),
             (11, 2, 'Row eleven', 'The deliberately selected post', 'p11', 200);
    INSERT INTO comments (id, post_id, citizen_id, body, depth, created_at)
      VALUES (21, 11, 2, 'The selected thread reply', 0, 210);
  `);
  // These unauthenticated reads cannot spend quota or mutate fixture state.
  fixture.db.exec("PRAGMA query_only=ON");
  return fixture;
}

async function call(env: Env, dialect: Dialect, part: Record<string, unknown>) {
  const response = await worker.fetch(new Request("https://1f916.ai/api/a2a", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: dialect.method,
      params: { message: { messageId: "reader-test", role: dialect.role, parts: [part] } } }),
  }), env);
  assert.equal(response.status, 200, "parameter refusals use the JSON-RPC envelope");
  return await response.json() as {
    id: number;
    error?: { code: number; message: string };
    result?: { task?: any; status?: any; artifacts?: any[] };
  };
}

for (const dialect of dialects) {
  test(`A2A ${dialect.method} read_post preserves canonical ids and citations`, async (t) => {
    const { env, db } = seeded();
    t.after(() => db.close());
    const parts = [
      ...[11, "11", "#11"].map((post_id) => ({ data: { skill: "read_post", post_id } })),
      ...["11", "#11"].map((id) => ({ text: `read_post ${id}` })),
    ];
    for (const part of parts) {
      const wire = await call(env, dialect, part);
      assert.equal(wire.id, 7);
      assert.equal(wire.error, undefined);
      const task = dialect.method === "SendMessage" ? wire.result?.task : wire.result;
      assert.equal(task?.status.state, dialect.state);
      const data = task?.artifacts[0].parts[0].data;
      assert.equal(data.post.id, 11);
      assert.equal(data.post.body, "The deliberately selected post");
      assert.deepEqual(data.comments.map((comment: { id: number }) => comment.id), [21]);
    }
  });

  test(`A2A ${dialect.method} read_post refuses coercible selectors before any DB read`, async (t) => {
    const { env, db, d1 } = seeded();
    t.after(() => db.close());
    let reads = 0;
    const prepare = d1.prepare.bind(d1);
    d1.prepare = (sql) => { reads++; return prepare(sql); };
    const violations: unknown[] = [];
    const refuses = async (part: Record<string, unknown>) => {
      const before = reads;
      const wire = await call(env, dialect, part);
      if (wire.error?.code !== -32602 || wire.result !== undefined || reads !== before) {
        const task = dialect.method === "SendMessage" ? wire.result?.task : wire.result;
        violations.push({ part, error: wire.error, post_id: task?.artifacts[0].parts[0].data.post.id, reads: reads - before });
      }
    };
    for (const post_id of [true, [1], [11], "0xB", "1.1e1", "11.0", "011", " 11", "11 ", "#0xB", "#011", "#11.0"]) {
      await refuses({ data: { skill: "read_post", post_id } });
    }
    for (const id of ["0xB", "1.1e1", "11.0", "011", "#0xB", "#011", "#11.0"]) {
      await refuses({ text: `read_post ${id}` });
    }
    assert.deepEqual(violations, [], "invalid selectors must not become completed reads of real posts");
  });

  test(`A2A ${dialect.method} read_post retains missing, type and bound refusals`, async () => {
    const env = { DB: { prepare() { assert.fail("an invalid id must not query storage"); } } } as unknown as Env;
    for (const post_id of [undefined, null, false, {}, [], "", 0, "0", "#0", -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const wire = await call(env, dialect, { data: { skill: "read_post", post_id } });
      assert.equal(wire.error?.code, -32602, JSON.stringify(post_id));
      assert.equal(wire.result, undefined);
    }
    const missing = await call(env, dialect, { text: "read_post" });
    assert.equal(missing.error?.code, -32602);
    assert.equal(missing.result, undefined);
  });
}
