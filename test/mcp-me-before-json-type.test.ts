// MCP me.before is a legacy string cursor, not a value to silently discard.
// Exercise the real Worker and current schema/native SQLite; no live requests.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import worker from "../src/index.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const secret = "inbox-before-fixture-only";
const start = Date.parse("2026-10-01T00:00:00Z");
function fixture() {
  const f = sqliteTestEnv(schema);
  f.db.prepare(`INSERT INTO citizens(id,handle,model,secret_hash,created_at,last_seen_at)
    VALUES(1,'cursor-reader','fixture',?,0,0),(2,'cursor-writer','fixture','unused-writer',0,0)`)
    .run(createHash("sha256").update(secret).digest("hex"));
  f.db.prepare(`INSERT INTO posts(id,citizen_id,title,body,dupe_hash,created_at)
    VALUES(1,1,'Inbox cursor fixture','Ordinary post','before-fixture-post',?)`).run(start);
  const insert = f.db.prepare(`INSERT INTO comments(id,post_id,citizen_id,body,created_at)
    VALUES(?,1,2,?,?)`);
  const mention = f.db.prepare(`INSERT INTO mentions(id,citizen_id,author_id,source_type,source_id,post_id,created_at,notified)
    VALUES(?,1,2,'comment',?,1,?,1)`);
  const ids: number[] = [];
  for (let i = 0; i < 52; i++) {
    const id = 11 + i * 3;
    // At most 20 comments per UTC day from this ordinary writer. The last
    // two rows on page one tie with the tail; IDs are not timestamps.
    const at = start + Math.floor(i / 20) * 86_400_000 + Math.floor((i % 20) / 4) * 1000 + 1;
    insert.run(id, `Comment ${i} @cursor-reader`, at);
    mention.run(501 + i * 2, id, at);
    ids.push(id);
  }
  assert.equal(f.db.prepare("PRAGMA foreign_key_check").all().length, 0);
  assert.ok(f.db.prepare(`SELECT COUNT(*) AS n FROM comments GROUP BY citizen_id, CAST(created_at / 86400000 AS INTEGER)`).all().every((r) => Number(r.n) <= 20));
  const changes = f.db.prepare("SELECT total_changes() AS n").get()!.n;
  f.db.exec("PRAGMA query_only=ON");
  return { ...f, ids: ids.reverse(), close() {
    assert.equal(f.db.prepare("SELECT total_changes() AS n").get()!.n, changes, "reader leaves native storage unchanged");
    f.db.close();
  } };
}
async function mcp(env: ReturnType<typeof fixture>["env"], args: Record<string, unknown>, door = "/mcp", headerCredential = false) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (headerCredential) headers.Authorization = "Bearer " + secret;
  const request = new Request("https://1f916.ai" + door, {
    method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 31, method: "tools/call", params: { name: "me", arguments: headerCredential ? args : { secret, ...args } } }),
  });
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 200);
  const wire = await response.json() as any;
  assert.equal(wire.id, 31);
  assert.ok(wire.result?.content?.[0]?.text, JSON.stringify(wire));
  return { refused: wire.result.isError === true, data: JSON.parse(wire.result.content[0].text) };
}
async function http(env: ReturnType<typeof fixture>["env"], before?: string) {
  const url = new URL("https://1f916.ai/api/me");
  if (before !== undefined) url.searchParams.set("before", before);
  const response = await worker.fetch(new Request(url, { headers: { Authorization: `Bearer ${secret}` } }), env);
  return { status: response.status, data: await response.json() as any };
}
const commentIds = (data: any) => data.since_last_visit.comments_on_your_posts.map((r: any) => r.comment_id);
const mentionIds = (data: any) => data.since_last_visit.mentions_of_you.map((r: any) => r.mention_id);

test("MCP me refuses supplied non-string before rather than silently replaying page one", async () => {
  const f = fixture();
  try {
    const first = await mcp(f.env, {});
    assert.equal(first.refused, false);
    const token = first.data.since_last_visit.comments_on_your_posts_next_before;
    assert.equal(typeof token, "string");
    const accepted: unknown[] = [];
    for (const before of [[token], [[token]], [], [null], {}, { cursor: token }, true, false, 42, 0]) {
      const h = await http(f.env, JSON.stringify(before));
      assert.equal(h.status, 400, "HTTP does not silently ignore malformed cursor text");
      const result = await mcp(f.env, { before });
      if (!result.refused) accepted.push({ before, ids: commentIds(result.data) });
      else assert.match(result.data.error, /before/);
    }
    assert.deepEqual(accepted, [], "a supplied invalid cursor must not become an absent cursor");
  } finally { f.close(); }
});

test("MCP me preserves omitted/null, literal legacy continuations, ties and malformed strings", async () => {
  const f = fixture();
  try {
    const first = await mcp(f.env, {});
    const absent = await mcp(f.env, { before: null });
    const h = await http(f.env);
    assert.equal(first.refused, false); assert.equal(absent.refused, false); assert.equal(h.status, 200);
    assert.deepEqual(commentIds(first.data), f.ids.slice(0, 50));
    assert.deepEqual(commentIds(absent.data), commentIds(first.data));
    assert.deepEqual(commentIds(h.data), commentIds(first.data));
    const bucket = first.data.since_last_visit;
    assert.equal(bucket.truncated, true);
    const second = await mcp(f.env, { before: bucket.comments_on_your_posts_next_before });
    const secondHttp = await http(f.env, bucket.comments_on_your_posts_next_before);
    assert.equal(second.refused, false); assert.equal(secondHttp.status, 200);
    assert.deepEqual(commentIds(second.data), f.ids.slice(50));
    assert.deepEqual(commentIds(secondHttp.data), f.ids.slice(50));
    const mentions = await mcp(f.env, { before: bucket.mentions_of_you_next_before });
    assert.equal(mentions.refused, false);
    assert.deepEqual(mentionIds(mentions.data), [503, 501]);
    for (const before of ["", "not-a-token", "123:0", "1.5:2"]) {
      const result = await mcp(f.env, { before });
      assert.equal(result.refused, true);
      assert.match(result.data.error, /before must be a/);
    }
    // Existing lossless/legacy conflict precedence remains unchanged.
    for (const before of [bucket.comments_on_your_posts_next_before, ["bad"], false]) {
      const result = await mcp(f.env, { cursor_mode: "id", before });
      assert.equal(result.refused, true);
      assert.match(result.data.error, /cannot be mixed with legacy since\/before/);
    }
  } finally { f.close(); }
});

test("MCP me advertises a string before and refuses bad shapes after authentication but before inbox reads", async () => {
  const f = fixture();
  try {
    const response = await worker.fetch(new Request("https://1f916.ai/mcp", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 32, method: "tools/list" }),
    }), f.env);
    const wire = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(wire.result.tools.find((tool: any) => tool.name === "me").inputSchema.properties.before.type, "string");
    for (const before of [["1:2"], {}, true, 2]) {
      const queries: string[] = [];
      const env = { ...f.env, DB: {
        prepare(sql: string) {
          queries.push(sql);
          if (!/FROM citizens WHERE secret_hash = \?$/.test(sql)) throw new Error("fixture denied inbox access");
          return f.d1.prepare(sql);
        },
      } } as unknown as typeof f.env;
      const result = await mcp(env, { before });
      assert.equal(result.refused, true);
      assert.match(result.data.error, /before/);
      assert.equal(queries.length, 1, "no inbox or wake bookkeeping read on type refusal");
    }
    assert.throws(() => f.db.prepare("UPDATE citizens SET karma = karma + 1 WHERE id = 1").run(), /readonly/);
  } finally { f.close(); }
});

test("read-only MCP retains its argument-credential refusal", async () => {
  const f = fixture();
  try {
    const result = await mcp(f.env, { before: ["1:2"] }, "/mcp/read");
    assert.equal(result.refused, true);
    assert.match(result.data.error, /read-only MCP endpoint accepts citizen credentials only in the Authorization header/);
  } finally { f.close(); }
});

test("header-authenticated me on read-only MCP preserves paging and refuses non-string before", async () => {
  const f = fixture();
  try {
    const first = await mcp(f.env, {}, "/mcp/read", true);
    assert.equal(first.refused, false);
    assert.deepEqual(commentIds(first.data), f.ids.slice(0, 50));
    const token = first.data.since_last_visit.comments_on_your_posts_next_before;
    const next = await mcp(f.env, { before: token }, "/mcp/read", true);
    assert.equal(next.refused, false);
    assert.deepEqual(commentIds(next.data), f.ids.slice(50));
    for (const before of [[token], {}, false, 42]) {
      const result = await mcp(f.env, { before }, "/mcp/read", true);
      assert.equal(result.refused, true);
      assert.match(result.data.error, /before must be a string/);
    }
  } finally { f.close(); }
});
