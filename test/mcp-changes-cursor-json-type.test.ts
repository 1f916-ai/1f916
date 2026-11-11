// Ordinary anonymous change-feed selectors, exercised through the real Worker.
// #700 refused structured read_post.since before String() could turn an array
// into a cursor. changes still stringified its three per-stream arguments: even
// ["done"] silenced a stream and ["id:1"] selected a normal page. These are
// malformed JSON argument shapes, not a new cursor dialect or a live loss claim.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const fields = ["posts_since", "comments_since", "nulls_since"] as const;
const base = { since: 0, posts_since: "id:0", comments_since: "id:0", nulls_since: "id:0" };

function fixture(t: TestContext) {
  const f = sqliteTestEnv(schema);
  f.db.exec(`
    INSERT INTO citizens(id,handle,model,secret_hash,created_at,last_seen_at)
      VALUES(1,'ordinary-reader','fixture','unused-fixture-hash',0,0);
    INSERT INTO posts(id,citizen_id,title,body,dupe_hash,created_at)
      VALUES(1,1,'first post','body one','p1',100),
            (3,1,'second post','body two','p3',86400100);
    INSERT INTO comments(id,post_id,citizen_id,body,created_at)
      VALUES(11,1,1,'first comment',1000),(17,3,1,'second comment',86401100);
    INSERT INTO nulls(id,kind,reason,status,route,created_at)
      VALUES(31,'refusal','fixture refusal',400,'POST /api/comment',2000),
            (37,'refusal','later fixture refusal',400,'POST /api/comment',86402100);
  `);
  const changes = f.db.prepare("SELECT total_changes() AS n").get()!.n;
  f.db.exec("PRAGMA query_only=ON");
  t.after(() => {
    assert.equal(f.db.prepare("SELECT total_changes() AS n").get()!.n, changes);
    f.db.close();
  });
  t.mock.method(Date, "now", () => 200_000_000);
  const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected network"); });
  t.after(() => assert.equal(network.mock.callCount(), 0, "no external dependency was called"));
  return f;
}

async function mcp(env: ReturnType<typeof sqliteTestEnv>["env"], door: string, args: Record<string, unknown>, rawBody?: string) {
  const request = new Request("https://1f916.ai" + door, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: rawBody ?? JSON.stringify({ jsonrpc: "2.0", id: 19, method: "tools/call", params: { name: "changes", arguments: args } }),
  });
  assert.equal(request.headers.has("authorization"), false);
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 200);
  const envelope = await response.json() as any;
  assert.equal(envelope.id, 19);
  assert.ok(envelope.result?.content?.[0]?.text, JSON.stringify(envelope));
  return { error: envelope.result.isError === true, data: JSON.parse(envelope.result.content[0].text) };
}
async function http(env: ReturnType<typeof sqliteTestEnv>["env"], args: Record<string, unknown>) {
  const url = new URL("https://1f916.ai/api/changes");
  for (const [key, value] of Object.entries(args)) if (value != null) url.searchParams.set(key, String(value));
  const response = await worker.fetch(new Request(url), env);
  return { status: response.status, data: await response.json() as any };
}

for (const door of ["/mcp", "/mcp/read"]) {
  for (const field of fields) {
    test(`${door}: changes refuses structured ${field} instead of applying a coerced token`, async (t) => {
      const f = fixture(t);
      const tokens = field === "nulls_since" ? ["done", "id:31", "31"] : ["done", "init", "id:1", "snapi:1:0", "snap:0:1:0", "0:1", "1"];
      const accepted: unknown[] = [];
      for (const token of tokens) {
        for (const bad of [[token], [[token]]]) {
          const r = await mcp(f.env, door, { ...base, [field]: bad });
          if (!r.error) accepted.push({ argument: bad, posts: r.data.posts?.map((p: any) => p.id), comments: r.data.comments?.map((c: any) => c.id), next: r.data[`next_${field}`] });
          else assert.match(String(r.data.error), new RegExp(field));
        }
      }
      assert.deepEqual(accepted, [], "structured JSON cursors were silently applied to the feed");
    });
  }

  test(`${door}: changes retains complete scalar shared-reader parity and continuations`, async (t) => {
    const f = fixture(t);
    const cases: Record<string, unknown>[] = [
      { since: 0 }, { since: 0, posts_since: null, comments_since: null, nulls_since: null },
      base,
      { ...base, posts_since: "init", comments_since: "init" },
      { ...base, posts_since: "snapi:3:1", comments_since: "snapi:17:11" },
      { ...base, posts_since: "snap:0:3:1", comments_since: "snap:0:17:11" },
      { ...base, posts_since: "id:1", comments_since: "id:11", nulls_since: "id:31" },
      { ...base, posts_since: "0:1", comments_since: "0:11", nulls_since: "31" },
      { ...base, nulls_since: "031" },
      { ...base, posts_since: 1, comments_since: 11, nulls_since: 31 },
      { ...base, posts_since: "done" }, { ...base, comments_since: "done" }, { ...base, nulls_since: "done" },
    ];
    for (const args of cases) {
      const h = await http(f.env, args);
      const m = await mcp(f.env, door, args);
      assert.equal(h.status, 200); assert.equal(m.error, false);
      // HTTP adds clock/content-boundary companions outside the shared reader;
      // MCP carries its boundary in the tool envelope, not in the reader data.
      const { now_utc, untrusted_content, ...sharedHttp } = h.data;
      assert.equal(now_utc, new Date(h.data.now).toISOString());
      assert.equal(untrusted_content.version, "1f916.untrusted-content.v1");
      assert.deepEqual(m.data, sharedHttp, JSON.stringify(args));
    }
    const first = await mcp(f.env, door, base);
    assert.deepEqual(first.data.posts.map((p: any) => p.id), [1,3]);
    assert.deepEqual(first.data.comments.map((c: any) => c.id), [11,17]);
    assert.deepEqual(first.data.nulls.map((n: any) => n.id), [31,37]);
    const next = await mcp(f.env, door, { since: 0, ...Object.fromEntries(fields.map((field) => [field, first.data[`next_${field}`]])) });
    assert.equal(next.error, false);
    assert.deepEqual([next.data.posts, next.data.comments, next.data.nulls], [[],[],[]]);
  });

  test(`${door}: changes rejects bad shapes before storage and keeps scalar refusals`, async (t) => {
    const f = fixture(t);
    let queries = 0;
    const denied = { ...f.env, DB: new Proxy(f.env.DB, { get(target, key, receiver) {
      if (key === "prepare" || key === "batch") return () => { queries++; throw new Error("storage denied"); };
      return Reflect.get(target, key, receiver);
    } }) };
    for (const field of fields) {
      for (const bad of [["done"], [["done"]], [], [null], ["id:0", "done"], {}, { toString: null }, true, false]) {
        const r = await mcp(denied, door, { ...base, [field]: bad });
        assert.equal(r.error, true, field + "=" + JSON.stringify(bad));
        assert.match(String(r.data.error), new RegExp(field));
        assert.equal(queries, 0, "a malformed cursor must not reach storage");
      }
      const malformed = ["", "no-token", "id:-1", -1, 1.5, ...(field === "nulls_since" ? [] : ["01"])];
      for (const bad of malformed) {
        const r = await mcp(f.env, door, { ...base, [field]: bad });
        assert.equal(r.error, true, field + "=" + JSON.stringify(bad));
      }
      for (const raw of ["1e309", "-1e309"]) {
        const args = { ...base, [field]: "RAW_CURSOR" };
        const body = JSON.stringify({ jsonrpc: "2.0", id: 19, method: "tools/call", params: { name: "changes", arguments: args } }).replace('"RAW_CURSOR"', raw);
        assert.equal((await mcp(f.env, door, {}, body)).error, true, "overflow remains a refusal");
      }
    }
    const invalidSince = await mcp(denied, door, { ...base, since: true, posts_since: ["done"] });
    assert.equal(invalidSince.error, true);
    assert.match(String(invalidSince.data.error), /since must be/);
    assert.equal(queries, 0, "since refusal precedence remains before cursor checks");
  });
}
