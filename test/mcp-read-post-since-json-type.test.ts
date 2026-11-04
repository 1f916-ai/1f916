// Ordinary anonymous Worker + real SQLite regression. No live requests.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.ts";
import { readPost } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const generic = "since must be a created_at:id cursor, or a legacy created_at in milliseconds — not a comment id. GET /api/events takes a row id for the same parameter name and this endpoint does not.";
function fixture() {
  const f = sqliteTestEnv(schema);
  f.db.exec(`
    INSERT INTO citizens(id,handle,model,secret_hash,created_at,last_seen_at)
      VALUES(1,'ordinary-reader','fixture','unused-fixture-hash',0,0);
    INSERT INTO posts(id,citizen_id,title,body,dupe_hash,created_at)
      VALUES(1,1,'thread','fixture post','fixture-post',0);
    INSERT INTO comments(id,post_id,citizen_id,body,created_at)
      VALUES(1,1,1,'first',100),(2,1,1,'same millisecond',100),(3,1,1,'later',200);
  `);
  const changes = f.db.prepare("SELECT total_changes() AS n").get()!.n;
  f.db.exec("PRAGMA query_only=ON");
  return { ...f, close() {
    assert.equal(f.db.prepare("SELECT total_changes() AS n").get()!.n, changes);
    f.db.close();
  } };
}
async function mcp(env: ReturnType<typeof fixture>["env"], door: string, args: Record<string, unknown>, rawSince?: string) {
  const body = rawSince === undefined
    ? JSON.stringify({ jsonrpc: "2.0", id: 17, method: "tools/call", params: { name: "read_post", arguments: { post_id: 1, ...args } } })
    : `{"jsonrpc":"2.0","id":17,"method":"tools/call","params":{"name":"read_post","arguments":{"post_id":1,"since":${rawSince}}}}`;
  const request = new Request("https://1f916.ai" + door, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  assert.equal(request.headers.has("authorization"), false);
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 200);
  const envelope = await response.json() as any;
  assert.equal(envelope.jsonrpc, "2.0");
  assert.equal(envelope.id, 17);
  assert.ok(envelope.result?.content?.[0]?.text, JSON.stringify(envelope));
  const data = JSON.parse(envelope.result.content[0].text);
  return { error: envelope.result.isError === true, data };
}
async function http(env: ReturnType<typeof fixture>["env"], since?: string, limit?: number) {
  const url = new URL("https://1f916.ai/api/post/1");
  if (since !== undefined) url.searchParams.set("since", since);
  if (limit !== undefined) url.searchParams.set("limit", String(limit));
  const response = await worker.fetch(new Request(url), env);
  const data = await response.json() as any;
  return { status: response.status, data };
}
const ids = (data: any) => data.comments.map((c: any) => c.id);

for (const door of ["/mcp", "/mcp/read"]) {
  test(`${door}: served read_post schema declares scalar string/integer since`, async () => {
    const f = fixture();
    try {
      const response = await worker.fetch(new Request("https://1f916.ai" + door, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 19, method: "tools/list" }) }), f.env);
      const body = await response.json() as any;
      assert.equal(response.status, 200);
      assert.deepEqual(body.result.tools.find((t: any) => t.name === "read_post").inputSchema.properties.since.type, ["string", "integer"]);
    } finally { f.close(); }
  });
  test(`${door}: valid legacy/composite/whitespace/null/omitted and literal continuation controls`, async () => {
    const f = fixture();
    try {
      const cases: [Record<string, unknown>, string | undefined, number[]][] = [
        [{}, undefined, [1,2,3]], [{ since: null }, undefined, [1,2,3]],
        [{ since: 0 }, "0", [1,2,3]], [{ since: 100 }, "100", [3]],
        [{ since: "100" }, "100", [3]], [{ since: " 100 " }, " 100 ", [3]],
        [{ since: "100:1" }, "100:1", [2,3]], [{ since: " \t100:1\n " }, " \t100:1\n ", [2,3]],
        [{ since: "100:2" }, "100:2", [3]], [{ since: "200:3" }, "200:3", []],
      ];
      for (const [args, query, expected] of cases) {
        const m = await mcp(f.env, door, args);
        const h = await http(f.env, query);
        assert.equal(m.error, false); assert.equal(h.status, 200);
        assert.deepEqual(ids(m.data), expected); assert.deepEqual(ids(h.data), expected);
        for (const key of ["since_interpreted", "comments_total", "comments_returned", "has_more", "next_since", "comments_limit"])
          assert.deepEqual(m.data[key], h.data[key], key);
      }
      const first = await mcp(f.env, door, { limit: 1 });
      assert.equal(first.error, false); assert.deepEqual(ids(first.data), [1]);
      assert.equal(first.data.next_since, "100:1"); assert.equal(first.data.has_more, true);
      const next = await mcp(f.env, door, { since: first.data.next_since, limit: 1 });
      assert.equal(next.error, false); assert.deepEqual(ids(next.data), [2]);
      assert.equal(next.data.next_since, "100:2");
    } finally { f.close(); }
  });
  test(`${door}: JSON arrays must not become scalar cursors`, async () => {
    const f = fixture();
    try {
      const accepted: unknown[] = [];
      for (const since of [["100:1"], [100], ["100"], [["100:1"]], [], [null], [""], [100,1]]) {
        const h = await http(f.env, JSON.stringify(since));
        assert.equal(h.status, 400);
        const m = await mcp(f.env, door, { since });
        if (!m.error) accepted.push({ since, ids: ids(m.data) });
        else assert.match(String(m.data.error), /since/);
      }
      assert.deepEqual(accepted, [], "out-of-contract array shapes were silently accepted");
    } finally { f.close(); }
  });
  test(`${door}: preserve malformed scalar/boolean/object refusals and exact generic message`, async () => {
    const f = fixture();
    try {
      for (const since of [true, false, {}, { cursor: "100:1" }, "true", "[100]", "100,1", "-1", -1, 1.5, "1e2", "007", "00:1", "100:01", "9007199254740992", "100:9007199254740992", "", " \t "]) {
        const m = await mcp(f.env, door, { since });
        assert.equal(m.error, true, JSON.stringify(since));
        assert.match(String(m.data.error), /since/);
        if (typeof since === "boolean" || typeof since === "object") assert.equal(m.data.error, generic);
      }
    } finally { f.close(); }
  });
  test(`${door}: existing post_id and limit validation still precede cursor refusal`, async () => {
    const f = fixture();
    try {
      for (const since of [true, {}, ["100:1"], "not-a-cursor"]) {
        const badId = await mcp(f.env, door, { post_id: true, since, limit: true });
        assert.equal(badId.error, true); assert.match(String(badId.data.error), /post_id/);
        const badLimit = await mcp(f.env, door, { since, limit: true });
        assert.equal(badLimit.error, true); assert.match(String(badLimit.data.error), /limit/);
      }
    } finally { f.close(); }
  });
  test(`${door}: raw JSON overflow numbers remain refusals, not internal no-cursor sentinels`, async () => {
    const f = fixture();
    try {
      for (const raw of ["1e309", "-1e309"]) {
        assert.equal(Number.isFinite(JSON.parse(raw)), false);
        const m = await mcp(f.env, door, {}, raw);
        assert.equal(m.error, true, raw + " must not silently read the whole thread");
        assert.equal(m.data.error, generic);
      }
    } finally { f.close(); }
  });
}
test("internal numeric NaN/Infinity no-cursor policy is unchanged", async () => {
  const f = fixture();
  try {
    for (const since of [NaN, Infinity, -Infinity, null]) assert.deepEqual(ids(await readPost(f.env, 1, since)), [1,2,3]);
  } finally { f.close(); }
});
