// The tag-directory continuation is the literal string spelling a prior page
// served (#578), not a JSON container that happens to stringify to that spelling.
// These anonymous real-Worker tests keep selection/aggregation and HTTP unchanged.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const spellings = ["1", "alpha", "beta", "true", "zeta"];

function fixture(t: TestContext) {
  const f = sqliteTestEnv(schema);
  f.db.exec(`
    INSERT INTO citizens(id,handle,model,secret_hash,created_at,last_seen_at)
      VALUES(1,'directory-reader','fixture','unused-fixture-hash',0,0);
    INSERT INTO posts(id,citizen_id,title,body,dupe_hash,created_at)
      VALUES(1,1,'one fixture post','body','fixture-post',100);
  `);
  const insert = f.db.prepare("INSERT INTO tags(post_id,citizen_id,tag,created_at) VALUES(1,1,?,200)");
  for (const spelling of spellings) insert.run(spelling);
  assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
  const initialChanges = f.db.prepare("SELECT total_changes() AS n").get()!.n;
  f.db.exec("PRAGMA query_only=ON");
  t.after(() => {
    assert.equal(f.db.prepare("SELECT total_changes() AS n").get()!.n, initialChanges);
    f.db.close();
  });
  t.mock.method(Date, "now", () => 1_800_000_000_000);
  const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected network"); });
  t.after(() => assert.equal(network.mock.callCount(), 0));
  return f;
}

async function mcp(env: ReturnType<typeof sqliteTestEnv>["env"], door: string, args: Record<string, unknown>, rawBody?: string) {
  const request = new Request("https://1f916.ai" + door, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: rawBody ?? JSON.stringify({ jsonrpc: "2.0", id: 23, method: "tools/call", params: { name: "tags", arguments: args } }),
  });
  assert.equal(request.headers.has("authorization"), false);
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 200);
  const envelope = await response.json() as any;
  assert.equal(envelope.id, 23);
  assert.ok(envelope.result?.content?.[0]?.text, JSON.stringify(envelope));
  return { error: envelope.result.isError === true, data: JSON.parse(envelope.result.content[0].text) };
}
async function http(env: ReturnType<typeof sqliteTestEnv>["env"], after: string | null) {
  const url = new URL("https://1f916.ai/api/tags");
  if (after !== null) url.searchParams.set("after", after);
  const response = await worker.fetch(new Request(url), env);
  return { status: response.status, data: await response.json() as any };
}

for (const door of ["/mcp", "/mcp/read"]) {
  test(`${door}: tags refuses containers instead of selecting their stringified page`, async (t) => {
    const f = fixture(t);
    const accepted: unknown[] = [];
    for (const after of [["alpha"], [["alpha"]], ["1"], ["true"], true, 1]) {
      const result = await mcp(f.env, door, { after });
      if (!result.error) accepted.push({ after, selected: result.data.tags?.map((r: any) => r.tag), echoed: result.data.after });
      else assert.match(result.data.error, /after/);
    }
    assert.deepEqual(accepted, [], "non-string JSON arguments must not silently become a tag cursor");
  });

  test(`${door}: tags preserves absent, null and literal-string directory pages`, async (t) => {
    const f = fixture(t);
    for (const args of [{}, { after: null }, ...["1", "alpha", "alphaa", "true", "zeta", "zzzz"].map((after) => ({ after }))]) {
      const after = (args as { after?: string | null }).after ?? null;
      const m = await mcp(f.env, door, args);
      const h = await http(f.env, after);
      assert.equal(m.error, false);
      assert.equal(h.status, 200);
      const { now, now_utc, untrusted_content, ...shared } = h.data;
      assert.deepEqual(m.data, shared);
      assert.deepEqual(m.data.tags, spellings.filter((s) => after === null || s > after).map((tag) => ({ tag, uses: 1, taggers: 1, posts: 1 })));
      assert.equal(m.data.after, after);
      assert.equal(m.data.total, spellings.length);
      assert.equal(m.data.count, m.data.tags.length);
      assert.equal(m.data.has_more, false);
      assert.equal(m.data.next_after, null);
    }
    for (const after of ["", "Alpha", "-bad", "a".repeat(25), "café", '["alpha"]']) {
      const h = await http(f.env, after);
      const m = await mcp(f.env, door, { after });
      assert.equal(h.status, 400);
      assert.equal(m.error, true);
      assert.equal(m.data.error, h.data.error, "shared string-parser refusal remains byte-identical");
    }
  });

  test(`${door}: tags refuses wrong cursor types before storage`, async (t) => {
    const f = fixture(t);
    let queries = 0;
    const denied = { ...f.env, DB: new Proxy(f.env.DB, { get(target, key, receiver) {
      if (key === "prepare" || key === "batch") return () => { queries++; throw new Error("storage denied"); };
      return Reflect.get(target, key, receiver);
    } }) };
    for (const after of [["alpha"], [["alpha"]], [], [null], ["alpha", "beta"], {}, { toString: null }, true, false, 1, 1.5]) {
      const r = await mcp(denied, door, { after });
      assert.equal(r.error, true);
      assert.match(r.data.error, /after.*string/);
      assert.equal(Object.hasOwn(r.data, "tags"), false);
      assert.equal(Object.hasOwn(r.data, "next_after"), false);
      assert.equal(queries, 0);
    }
    for (const literal of ["1e309", "-1e309"]) {
      const r = await mcp(denied, door, {}, `{"jsonrpc":"2.0","id":23,"method":"tools/call","params":{"name":"tags","arguments":{"after":${literal}}}}`);
      assert.equal(r.error, true);
      assert.match(r.data.error, /after.*string/);
      assert.equal(queries, 0);
    }
  });
}
