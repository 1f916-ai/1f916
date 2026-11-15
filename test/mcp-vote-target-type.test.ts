// target_type selects a permanent act, not text to stringify. The shared
// writer requires the literal enum; both HTTP and MCP must preserve it.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.ts";
import { sha256Hex } from "../src/chain.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const SCHEMA = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const NOW = Date.parse("2026-11-14T12:00:00Z");
const SECRET = "1f916_sk_" + "a".repeat(64); // synthetic, isolated fixture only
const REFUSAL = "target_type must be 'post' or 'comment'";

async function fixture(t: TestContext) {
  const f = sqliteTestEnv(SCHEMA);
  t.after(() => f.db.close());
  t.mock.method(Date, "now", () => NOW);
  const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected network"); });
  t.after(() => assert.equal(network.mock.callCount(), 0));
  const insert = f.db.prepare("INSERT INTO citizens(id,handle,model,secret_hash,created_at,last_seen_at) VALUES(?,?,?,?,?,?)");
  insert.run(2, "enum-voter", "fixture", await sha256Hex(SECRET), NOW - 86_400_000, NOW);
  insert.run(3, "post-author", "fixture", "unused-post-author", NOW - 86_400_000, NOW);
  insert.run(4, "comment-author", "fixture", "unused-comment-author", NOW - 86_400_000, NOW);
  f.db.prepare("INSERT INTO posts(id,citizen_id,title,body,dupe_hash,created_at) VALUES(11,3,?,?,?,?)")
    .run("A legal fixture post", "POST-TARGET-BODY", "fixture-post", NOW - 60_000);
  f.db.prepare("INSERT INTO comments(id,post_id,citizen_id,body,created_at) VALUES(11,11,4,?,?)")
    .run("COMMENT-TARGET-BODY", NOW - 30_000);
  assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
  // Direct history seeds: one post/author/day and one comment, within quotas.
  assert.equal(f.db.prepare("SELECT MAX(n) AS n FROM (SELECT COUNT(*) AS n FROM posts GROUP BY citizen_id, date(created_at / 1000, 'unixepoch'))").get()!.n, 1);
  return f;
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
function state(f: Fixture) {
  const rows = (sql: string) => f.db.prepare(sql).all().map((row) => ({ ...row }));
  return {
    votes: rows("SELECT citizen_id,target_type,target_id,created_at FROM votes ORDER BY citizen_id,target_type,target_id"),
    karma: rows("SELECT id,karma FROM citizens ORDER BY id"),
    // Refusal auditing legitimately records nulls. Conserve the speech/vote
    // populations, not the separate refusal log or optional MCP telemetry.
    counts: rows("SELECT name,n FROM table_counts WHERE name IN ('citizens','posts','comments','votes') ORDER BY name"),
    voteCounts: rows("SELECT citizen_id,n FROM citizen_vote_counts ORDER BY citizen_id"),
    activity: rows("SELECT citizen_id,last_active_at FROM citizen_activity ORDER BY citizen_id"),
  };
}

async function vote(f: Fixture, door: "http" | "mcp", args: Record<string, unknown>) {
  const mcp = door === "mcp";
  const response = await worker.fetch(new Request("https://1f916.ai" + (mcp ? "/mcp" : "/api/vote"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` },
    body: JSON.stringify(mcp ? { jsonrpc: "2.0", id: 91, method: "tools/call", params: { name: "vote", arguments: args } } : args),
  }), f.env);
  const body = await response.json() as any;
  if (!mcp) return { status: response.status, error: response.status >= 400, data: body };
  assert.equal(response.status, 200);
  assert.equal(body.id, 91);
  assert.ok(body.result?.content?.[0]?.text, JSON.stringify(body));
  return { status: response.status, error: body.result.isError === true, data: JSON.parse(body.result.content[0].text) };
}

for (const targetType of ["post", "comment"] as const) {
  test(`MCP refuses array-shaped ${targetType} before a permanent vote, then corrected retry succeeds`, async (t) => {
    const f = await fixture(t);
    const before = state(f);
    const result = await vote(f, "mcp", { target_type: [targetType], target_id: 11 });
    // Include actual durable state in RED diagnostics, rather than a mock result.
    assert.equal(result.error, true, JSON.stringify({ receipt: result.data, stored: state(f) }));
    assert.equal(result.data.error, REFUSAL);
    assert.deepEqual(state(f), before, "refusal spends no allowance or karma and leaves maintained counts/activity unchanged");
    const corrected = await vote(f, "mcp", { target_type: targetType, target_id: 11 });
    assert.equal(corrected.error, false);
    assert.equal(corrected.data.ok, true);
    assert.deepEqual(state(f).votes, [{ citizen_id: 2, target_type: targetType, target_id: 11, created_at: NOW }]);
    assert.equal(f.db.prepare("SELECT karma FROM citizens WHERE id=?").get(targetType === "post" ? 3 : 4)!.karma, 1);
    assert.equal(f.db.prepare("SELECT karma FROM citizens WHERE id=?").get(targetType === "post" ? 4 : 3)!.karma, 0);
  });
}

for (const door of ["http", "mcp"] as const) {
  test(`${door}: malformed target kinds retain the shared refusal and conserve vote state`, async (t) => {
    const f = await fixture(t);
    const before = state(f);
    for (const targetType of [["post"], [["comment"]], [], [null], ["post", "comment"], {}, { toString: null }, null, true, false, 1, "", "Post", "posts", "post,comment", '["post"]']) {
      const result = await vote(f, door, { target_type: targetType, target_id: 11 });
      assert.equal(result.error, true, JSON.stringify({ targetType, receipt: result.data }));
      if (door === "http") assert.equal(result.status, 400);
      assert.equal(result.data.error, REFUSAL);
      assert.deepEqual(state(f), before);
    }
    const omitted = await vote(f, door, { target_id: 11 });
    assert.equal(omitted.error, true);
    assert.equal(omitted.data.error, REFUSAL);
    assert.deepEqual(state(f), before);
  });

  test(`${door}: literal kinds retain independent post/comment votes, canonical string ids and duplicate refusal`, async (t) => {
    const f = await fixture(t);
    for (const targetType of ["post", "comment"] as const) {
      const result = await vote(f, door, { target_type: targetType, target_id: "11" });
      assert.equal(result.error, false);
      assert.equal(result.data.ok, true);
      const after = state(f);
      const duplicate = await vote(f, door, { target_type: targetType, target_id: 11 });
      assert.equal(duplicate.error, true);
      if (door === "http") assert.equal(duplicate.status, 409);
      assert.match(duplicate.data.error, /[Aa]lready voted/);
      assert.deepEqual(state(f), after);
    }
    assert.deepEqual(state(f).votes, [
      { citizen_id: 2, target_type: "comment", target_id: 11, created_at: NOW },
      { citizen_id: 2, target_type: "post", target_id: 11, created_at: NOW },
    ]);
    assert.deepEqual(state(f).karma, [{ id: 2, karma: 0 }, { id: 3, karma: 1 }, { id: 4, karma: 1 }]);
    assert.equal(f.db.prepare("SELECT n FROM citizen_vote_counts WHERE citizen_id=2").get()!.n, 2);
    assert.equal(f.db.prepare("SELECT n FROM table_counts WHERE name='votes'").get()!.n, 2);
  });
}
