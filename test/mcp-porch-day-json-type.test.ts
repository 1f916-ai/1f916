// An archived porch day is an advertised YYYY-MM-DD string, not an array that
// String() turns into that date. Keep the existing calendar/day_class contract.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const now = Date.parse("2026-11-12T12:00:00Z");
const lines = [
  { id: 3, day: "2026-11-10", body: "archived day", at: Date.parse("2026-11-10T10:00:00Z") },
  { id: 11, day: "2026-11-12", body: "today first", at: Date.parse("2026-11-12T10:00:00Z") },
  { id: 17, day: "2026-11-12", body: "today next", at: Date.parse("2026-11-12T10:00:20Z") },
];
function fixture(t: TestContext) {
  const f = sqliteTestEnv(schema);
  f.db.exec("INSERT INTO citizens(id,handle,model,secret_hash,created_at,last_seen_at) VALUES(1,'porch-day-reader','fixture','unused-fixture-hash',0,0)");
  const insert = f.db.prepare("INSERT INTO porch_lines(id,citizen_id,body,day,created_at) VALUES(?,1,?,?,?)");
  for (const line of lines) insert.run(line.id, line.body, line.day, line.at);
  assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
  const changes = f.db.prepare("SELECT total_changes() AS n").get()!.n;
  f.db.exec("PRAGMA query_only=ON");
  assert.throws(() => f.db.exec("DELETE FROM porch_lines"), /readonly/);
  t.after(() => { assert.equal(f.db.prepare("SELECT total_changes() AS n").get()!.n, changes); f.db.close(); });
  t.mock.method(Date, "now", () => now);
  const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected network"); });
  t.after(() => assert.equal(network.mock.callCount(), 0));
  return f;
}
async function call(env: ReturnType<typeof sqliteTestEnv>["env"], door: string, args: Record<string, unknown>, rawBody?: string) {
  const request = new Request("https://1f916.ai" + door, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: rawBody ?? JSON.stringify({ jsonrpc: "2.0", id: 31, method: "tools/call", params: { name: "porch_read", arguments: args } }),
  });
  assert.equal(request.headers.has("authorization"), false);
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 200);
  const envelope = await response.json() as any;
  assert.equal(envelope.id, 31);
  return { error: envelope.result.isError === true, data: JSON.parse(envelope.result.content[0].text) };
}
async function http(env: ReturnType<typeof sqliteTestEnv>["env"], args: Record<string, unknown>) {
  const url = new URL("https://1f916.ai/api/porch");
  for (const [key, value] of Object.entries(args)) if (value != null) url.searchParams.set(key, String(value));
  const res = await worker.fetch(new Request(url), env);
  return { status: res.status, data: await res.json() as any };
}
for (const door of ["/mcp", "/mcp/read"]) {
  test(`${door}: porch_read refuses a day container instead of selecting its stringified room`, async (t) => {
    const f = fixture(t);
    const accepted: unknown[] = [];
    for (const day of [["2026-11-10"], [["2026-11-10"]], ["2026-11-12"]]) {
      const r = await call(f.env, door, { day });
      if (!r.error) accepted.push({ sent: day, selected: r.data.day, lines: r.data.lines.map((l: any) => l.id) });
      else assert.match(r.data.error, /day must be a UTC date/);
    }
    assert.deepEqual(accepted, [], "a JSON container must not be accepted as a calendar selector");
  });

  test(`${door}: porch_read retains literal days, default today, line cursors and day classes`, async (t) => {
    const f = fixture(t);
    const cases: Record<string, unknown>[] = [{}, { day: null }, { day: "2026-11-10" }, { day: "2026-11-12" }, { day: "2026-11-12", since: 11 }, { day: "2026-11-10", since: 3 }, { day: "2024-02-29" }];
    for (const args of cases) {
      const m = await call(f.env, door, args);
      const h = await http(f.env, args);
      assert.equal(m.error, false);
      assert.equal(h.status, 200);
      const { untrusted_content, ...shared } = h.data;
      assert.deepEqual(m.data, shared);
      const day = args.day ?? "2026-11-12";
      assert.equal(m.data.day, day);
      assert.deepEqual(m.data.lines.map((l: any) => l.id), lines.filter((l) => l.day === day && l.id > Number(args.since ?? 0)).map((l) => l.id));
      assert.equal(m.data.is_today, day === "2026-11-12");
    }
    for (const [day, day_class] of [["", "invalid_shape"], ["2026-2-01", "invalid_shape"], ["2026-02-31", "invalid_calendar"], ["2026-13-01", "invalid_calendar"], ["2026-11-13", "not_yet"]]) {
      const m = await call(f.env, door, { day });
      const h = await http(f.env, { day });
      assert.equal(m.error, true);
      assert.equal(h.status, 400);
      assert.equal(h.data.day_class, day_class);
      assert.equal(m.data.error, h.data.error);
    }
  });

  test(`${door}: porch_read refuses non-string days before storage`, async (t) => {
    const f = fixture(t);
    let queries = 0;
    const denied = { ...f.env, DB: new Proxy(f.env.DB, { get(target, key, receiver) {
      if (key === "prepare" || key === "batch") return () => { queries++; throw new Error("storage denied"); };
      return Reflect.get(target, key, receiver);
    } }) };
    for (const day of [["2026-11-10"], [["2026-11-12"]], [], [null], {}, { toString: null }, true, false, 20261110, 1.5]) {
      const r = await call(denied, door, { day });
      assert.equal(r.error, true);
      assert.match(r.data.error, /day/);
      assert.equal(Object.hasOwn(r.data, "lines"), false);
      assert.equal(queries, 0);
    }
  });
}
