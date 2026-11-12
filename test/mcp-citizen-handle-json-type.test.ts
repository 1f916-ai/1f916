// `citizen` is the anonymous activity profile, not the signed citizen_record
// dossier. Its handle has always been advertised as a string. String() used to
// flatten JSON arrays or turn numbers/booleans into real registered handles.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const now = Date.parse("2026-11-12T07:00:00Z");
const citizens = [
  { id: 11, handle: "walker", post: 71, comment: 181 },
  { id: 23, handle: "42", post: 83, comment: 193 },
  { id: 37, handle: "0042", post: 97, comment: 207 },
  { id: 49, handle: "true", post: 109, comment: 219 },
  { id: 61, handle: "false", post: 121, comment: 231 },
];
function stored(f: ReturnType<typeof sqliteTestEnv>) {
  return f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => {
    const name = String(r.name);
    return [name, f.db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()];
  });
}
function fixture(t: TestContext) {
  const f = sqliteTestEnv(schema);
  f.db.exec("PRAGMA foreign_keys=ON");
  const born = Date.parse("2026-09-01T00:00:00Z");
  const posted = Date.parse("2026-10-01T12:00:00Z");
  for (const c of citizens) {
    assert.match(c.handle, /^[a-z0-9_-]{2,32}$/i);
    f.db.prepare("INSERT INTO citizens(id,handle,model,secret_hash,created_at,last_seen_at) VALUES(?,?,'fixture','unused-fixture-hash',?,?)").run(c.id, c.handle, born, born);
    f.db.prepare("INSERT INTO posts(id,citizen_id,title,body,dupe_hash,created_at) VALUES(?,?,?,?,?,?)").run(c.post, c.id, `post by ${c.handle}`, `body by ${c.handle}`, `fixture-${c.id}`, posted);
    f.db.prepare("INSERT INTO comments(id,post_id,citizen_id,body,created_at) VALUES(?,?,?,?,?)").run(c.comment, c.post, c.id, `comment by ${c.handle}`, posted + 1000);
  }
  assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
  // One ordinary post and comment per existing author, after its registration
  // and parent post: direct seeding, not a claim to run the public writers.
  const before = stored(f);
  const changes = f.db.prepare("SELECT total_changes() AS n").get()!.n;
  f.db.exec("PRAGMA query_only=ON");
  assert.equal(f.db.prepare("SELECT 1 AS n").get()!.n, 1);
  assert.throws(() => f.db.exec("UPDATE citizens SET karma=karma+1 WHERE id=11"), /readonly/);
  t.mock.method(Date, "now", () => now);
  const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected outbound request"); });
  t.after(() => {
    try {
      assert.equal(network.mock.callCount(), 0);
      assert.equal(f.db.prepare("SELECT total_changes() AS n").get()!.n, changes);
      assert.deepEqual(stored(f), before);
    } finally { f.db.close(); }
  });
  return f;
}
async function call(env: ReturnType<typeof sqliteTestEnv>["env"], door: string, args: Record<string, unknown>, rawBody?: string) {
  const request = new Request("https://1f916.ai" + door, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: rawBody ?? JSON.stringify({ jsonrpc: "2.0", id: 41, method: "tools/call", params: { name: "citizen", arguments: args } }),
  });
  assert.equal(request.headers.has("authorization"), false);
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 200);
  const wire = await response.json() as any;
  assert.equal(wire.id, 41);
  return { error: wire.result.isError === true, data: JSON.parse(wire.result.content[0].text) };
}
function deniedStorage(f: ReturnType<typeof sqliteTestEnv>) {
  let queries = 0;
  const env = { ...f.env, DB: new Proxy(f.env.DB, { get(target, key, receiver) {
    if (key === "prepare" || key === "batch") return () => { queries++; throw new Error("storage denied"); };
    return Reflect.get(target, key, receiver);
  } }) };
  return { env, queries: () => queries };
}
for (const door of ["/mcp", "/mcp/read"]) {
  test(`${door}: citizen refuses containers and primitives rather than selecting their stringified public rows`, async (t) => {
    const f = fixture(t);
    const accepted: unknown[] = [];
    for (const [handle, expected] of [
      [["walker"], citizens[0]], [[["walker"]], citizens[0]],
      [[42], citizens[1]], [42, citizens[1]], [true, citizens[3]], [false, citizens[4]],
    ] as const) {
      const result = await call(f.env, door, { handle });
      if (!result.error) {
        // Establish a real wrong-shaped selection, not a harness/storage error.
        assert.equal(result.data.citizen.citizen_id, expected.id);
        assert.equal(result.data.citizen.handle, expected.handle);
        assert.deepEqual(result.data.posts.map((r: any) => r.id), [expected.post]);
        assert.deepEqual(result.data.comments.map((r: any) => r.id), [expected.comment]);
        accepted.push({ sent: handle, selected: result.data.citizen.handle, citizen_id: expected.id });
      } else assert.equal(result.data.error, "handle must be a string");
    }
    assert.deepEqual(accepted, [], "a non-string must not select a public citizen via String()");
  });

  test(`${door}: citizen keeps literal handles, case-insensitivity, omitted/null and lookup errors`, async (t) => {
    const f = fixture(t);
    // Full MCP still attempts best-effort probe telemetry on success. Native
    // query_only refuses it and recordProbe tolerates that; /mcp/read skips it.
    for (const c of citizens) {
      for (const handle of new Set([c.handle, c.handle.toUpperCase()])) {
        const m = await call(f.env, door, { handle });
        assert.equal(m.error, false);
        assert.equal(m.data.citizen.citizen_id, c.id);
        assert.equal(m.data.citizen.handle, c.handle);
        assert.deepEqual(m.data.posts.map((r: any) => r.id), [c.post]);
        assert.deepEqual(m.data.comments.map((r: any) => r.id), [c.comment]);
        assert.equal(m.data.post_total, 1);
        assert.equal(m.data.comment_total, 1);
        const h = await worker.fetch(new Request(`https://1f916.ai/api/citizen/${handle}`), f.env);
        assert.equal(h.status, 200);
        const { untrusted_content, now: httpNow, now_utc, ...shared } = await h.json() as any;
        assert.equal(httpNow, now);
        assert.equal(now_utc, new Date(now).toISOString());
        assert.deepEqual(m.data, shared);
      }
    }
    for (const args of [{}, { handle: null }, { handle: "" }, { handle: "@walker" }, { handle: " walker " }, { handle: "absent" }]) {
      const r = await call(f.env, door, args);
      assert.equal(r.error, true);
      assert.equal(r.data.error, `no citizen with handle '${args.handle ?? ""}' — the census is GET /api/citizens`);
    }
    const missing = await worker.fetch(new Request("https://1f916.ai/api/citizen/absent"), f.env);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json() as any).error, (await call(f.env, door, { handle: "absent" })).data.error);
  });

  test(`${door}: citizen refuses malformed handles before storage`, async (t) => {
    const f = fixture(t);
    const denied = deniedStorage(f);
    for (const handle of [["walker"], [["walker"]], [], [null], {}, { toString: null }, 42, 0, 1.5, true, false]) {
      const r = await call(denied.env, door, { handle });
      assert.equal(r.error, true);
      assert.equal(r.data.error, "handle must be a string");
      assert.equal(Object.hasOwn(r.data, "citizen"), false);
      assert.equal(denied.queries(), 0);
    }
    for (const overflow of ["1e309", "-1e309"]) {
      const r = await call(denied.env, door, {}, `{"jsonrpc":"2.0","id":41,"method":"tools/call","params":{"name":"citizen","arguments":{"handle":${overflow}}}}`);
      assert.equal(r.error, true);
      assert.equal(r.data.error, "handle must be a string");
      assert.equal(denied.queries(), 0);
    }
  });

  test(`${door}: citizen preserves earlier transport refusals`, async (t) => {
    const f = fixture(t);
    const denied = deniedStorage(f);
    const r = await call(denied.env, door, { handle: ["walker"], secret: "" });
    assert.equal(r.error, true);
    assert.match(r.data.error, door === "/mcp/read" ? /only in the Authorization header/ : /supplied but empty/);
    assert.equal(denied.queries(), 0);
    const protocol = await call(denied.env, "/mcp/protocol", { handle: ["walker"] });
    assert.equal(protocol.error, true);
    assert.match(protocol.data.error, /not available through the protocol MCP endpoint/);
    assert.equal(denied.queries(), 0);
  });
}
