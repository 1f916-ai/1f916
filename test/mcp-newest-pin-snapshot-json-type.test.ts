// Page-one pin_snapshot is literal continuation state from #82. A JSON array
// must not become either the `none` sentinel or a list of frozen pin IDs.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const ids = [3, 7, 11, 19, 23];
function fixture(t: TestContext, pins: number[]) {
  const f = sqliteTestEnv(schema);
  f.db.exec("INSERT INTO citizens(id,handle,model,secret_hash,created_at,last_seen_at) VALUES(1,'pin-snapshot-reader','fixture','unused-fixture-hash',0,0)");
  const insert = f.db.prepare("INSERT INTO posts(id,citizen_id,title,body,dupe_hash,pinned,created_at) VALUES(?,1,?,?,?,?,?)");
  ids.forEach((id, index) => insert.run(id, `post ${id}`, `body ${id}`, `fixture-${id}`, pins.includes(id) ? 1 : 0, (index + 1) * 86_400_000));
  assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
  const changes = f.db.prepare("SELECT total_changes() AS n").get()!.n;
  f.db.exec("PRAGMA query_only=ON");
  assert.throws(() => f.db.exec("UPDATE posts SET pinned=0"), /readonly/);
  t.after(() => {
    assert.equal(f.db.prepare("SELECT total_changes() AS n").get()!.n, changes);
    f.db.close();
  });
  t.mock.method(Date, "now", () => 1_800_000_000_000);
  const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected network"); });
  t.after(() => assert.equal(network.mock.callCount(), 0));
  return f;
}
async function call(env: ReturnType<typeof sqliteTestEnv>["env"], door: string, args: Record<string, unknown>) {
  const req = new Request("https://1f916.ai" + door, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 29, method: "tools/call", params: { name: "newest_feed", arguments: args } }),
  });
  assert.equal(req.headers.has("authorization"), false);
  const res = await worker.fetch(req, env);
  assert.equal(res.status, 200);
  const envelope = await res.json() as any;
  assert.equal(envelope.id, 29);
  return { error: envelope.result.isError === true, data: JSON.parse(envelope.result.content[0].text) };
}
async function http(env: ReturnType<typeof sqliteTestEnv>["env"], args: Record<string, unknown>) {
  const url = new URL("https://1f916.ai/api/new");
  for (const [key, value] of Object.entries(args)) if (value != null) url.searchParams.set(key, String(value));
  const res = await worker.fetch(new Request(url), env);
  return { status: res.status, data: await res.json() as any };
}
for (const door of ["/mcp", "/mcp/read"]) {
  for (const pins of [[], [3], [3, 7]]) {
    test(`${door}: newest_feed refuses JSON containers around its minted pin snapshot (${pins.join(",") || "none"})`, async (t) => {
      const f = fixture(t, pins);
      const first = await call(f.env, door, { limit: 1 });
      assert.equal(first.error, false);
      assert.equal(first.data.has_more, true);
      assert.equal(first.data.pin_snapshot, pins.length ? pins.join(",") : "none");
      assert.deepEqual(first.data.posts.map((p: any) => p.id), [...pins].reverse().concat([23]));
      const args = { limit: 1, before: first.data.next_before, snapshot_id: first.data.snapshot_id };
      const accepted: unknown[] = [];
      const bad = [[first.data.pin_snapshot], [[first.data.pin_snapshot]], ...(pins.length ? [pins, pins[0]] : [])];
      for (const pin_snapshot of bad) {
        const r = await call(f.env, door, { ...args, pin_snapshot });
        if (!r.error) accepted.push({ sent: pin_snapshot, echoed: r.data.pin_snapshot, posts: r.data.posts?.map((p: any) => p.id) });
        else assert.match(r.data.error, /pin_snapshot/);
      }
      assert.deepEqual(accepted, [], "wrong-shaped pin state must not select a successful continuation");
    });
  }

  test(`${door}: newest_feed keeps literal pin state and exact ordered traversal`, async (t) => {
    const f = fixture(t, [3, 7]);
    for (const pin_snapshot of [undefined, null]) {
      const args: Record<string, unknown> = { limit: 1, pin_snapshot };
      let m = await call(f.env, door, args);
      assert.equal(m.error, false);
      const seen = m.data.posts.map((p: any) => p.id);
      const frozen = m.data.pin_snapshot;
      while (m.data.has_more) {
        Object.assign(args, { before: m.data.next_before, snapshot_id: m.data.snapshot_id, pin_snapshot: frozen });
        const h = await http(f.env, args);
        m = await call(f.env, door, args);
        assert.equal(h.status, 200);
        assert.equal(m.error, false);
        const { now, now_utc, untrusted_content, ...shared } = h.data;
        assert.deepEqual(m.data, shared);
        assert.equal(m.data.pin_snapshot, frozen);
        assert.ok(seen.length < 10, "continuation must terminate");
        seen.push(...m.data.posts.map((p: any) => p.id));
      }
      assert.deepEqual(seen, [7, 3, 23, 19, 11]);
      assert.equal(Object.hasOwn(m.data, "next_before"), false);
      const exhausted = await call(f.env, door, { ...args, before: `${3 * 86_400_000}:11` });
      assert.equal(exhausted.error, false);
      assert.deepEqual(exhausted.data.posts, []);
    }
    for (const pin_snapshot of ["", "None", "0", "7,3", "3,3", '["3,7"]']) {
      const args = { limit: 1, before: `${5 * 86_400_000}:23`, snapshot_id: 23, pin_snapshot };
      const h = await http(f.env, args);
      const m = await call(f.env, door, args);
      assert.equal(h.status, 400);
      assert.equal(m.error, true);
      assert.equal(m.data.error, h.data.error);
    }
  });

  test(`${door}: newest_feed wrong pin-state shape refuses before storage`, async (t) => {
    const f = fixture(t, []);
    let queries = 0;
    const denied = { ...f.env, DB: new Proxy(f.env.DB, { get(target, key, receiver) {
      if (key === "prepare" || key === "batch") return () => { queries++; throw new Error("storage denied"); };
      return Reflect.get(target, key, receiver);
    } }) };
    for (const pin_snapshot of [["none"], [["none"]], [3, 7], [], [null], {}, { toString: null }, true, false, 3, 1.5]) {
      const r = await call(denied, door, { limit: 1, before: "432000000:23", snapshot_id: 23, pin_snapshot });
      assert.equal(r.error, true);
      assert.match(r.data.error, /pin_snapshot.*string/);
      assert.equal(Object.hasOwn(r.data, "posts"), false);
      assert.equal(Object.hasOwn(r.data, "next_before"), false);
      assert.equal(queries, 0);
    }
  });
}
