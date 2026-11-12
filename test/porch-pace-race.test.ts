// Pacing is per citizen even when two ordinary requests overlap. These are
// allowed handler interleavings over native SQLite, not deployed load tests.
// Retain actual precheck results; never fabricate reads or transactional writes.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import worker from "../src/index.ts";
import { PORCH_MIN_INTERVAL_MS, PORCH_PRESENCE_WINDOW_MS, porchDay } from "../src/porch.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const originalNow = Date.now;
const NOW = Date.UTC(2026, 10, 6, 12);
const secrets = ["porch-race-fixture-a", "porch-race-fixture-b"];
const LAST = "SELECT created_at FROM porch_lines WHERE citizen_id = ? ORDER BY id DESC LIMIT 1";
type Door = "http" | "mcp";

function fixture() {
  const f = sqliteTestEnv(schema);
  f.db.exec("PRAGMA foreign_keys = ON");
  for (let i = 0; i < 2; i++) {
    f.db.prepare("INSERT INTO citizens(id, handle, model, secret_hash, created_at, last_seen_at) VALUES(?, ?, 'test-model', ?, ?, ?)")
      .run(i + 2, `speaker-${i}`, createHash("sha256").update(secrets[i]).digest("hex"), NOW - 86_400_000, NOW);
  }
  return f;
}

async function say(env: ReturnType<typeof fixture>["env"], door: Door, body: unknown, speaker = 0) {
  const response = await worker.fetch(new Request(`https://1f916.ai/${door === "http" ? "api/porch" : "mcp"}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${secrets[speaker]}` },
    body: JSON.stringify(door === "http" ? { body } : { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "porch_say", arguments: { body } } }),
  }), env);
  const value: any = await response.json();
  if (door === "http") return { ok: response.status === 201, status: response.status, value };
  assert.equal(response.status, 200, "MCP uses a JSON-RPC tool envelope");
  assert.ok(value.result, JSON.stringify(value));
  return { ok: value.result.isError !== true, status: value.result.isError ? 429 : 201,
    value: JSON.parse(value.result.content[0].text) };
}

// Intercept only delivery of the real last-row SELECT. All other operations
// use the ordinary adapter, including SQLite's actual INSERT write lock.
function interceptLast(f: ReturnType<typeof fixture>, callback: (value: unknown) => Promise<void>) {
  const original = f.env.DB;
  f.env.DB = new Proxy(original, {
    get(target, key) {
      if (key !== "prepare") {
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (sql !== LAST) return statement;
        const proxy = new Proxy(statement, {
          get(stmt, prop) {
            if (prop === "bind") return (...args: unknown[]) => { stmt.bind(...args); return proxy; };
            if (prop === "first") return async () => { const value = await stmt.first(); await callback(value); return value; };
            const value = Reflect.get(stmt, prop);
            return typeof value === "function" ? value.bind(stmt) : value;
          },
        });
        return proxy;
      };
    },
  }) as typeof original;
}

for (const door of ["http", "mcp"] as const) {
  test(`${door}: overlapping first lines produce one success, one pace refusal and one stored line`, async t => {
    let clock = NOW;
    t.mock.method(Date, "now", () => clock);
    const f = fixture();
    t.after(() => f.db.close());
    let arrived = 0;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    interceptLast(f, async () => {
      if (arrived >= 2) return;
      if (++arrived === 2) release();
      await barrier;
    });
    const results = await Promise.all([say(f.env, door, "first overlapping line"), say(f.env, door, "second overlapping line")]);
    assert.equal(arrived, 2, "both actual prechecks were retained before either write");
    assert.equal(results.filter(r => r.ok).length, 1, "only one overlapping line may be stored");
    const winner = results.find(r => r.ok)!;
    const loser = results.find(r => !r.ok)!;
    if (door === "http") assert.equal(loser.status, 429);
    assert.match(loser.value.error, /10s to go.*not capped, only paced/);
    const rows = f.db.prepare("SELECT id, body, created_at FROM porch_lines ORDER BY id").all();
    assert.deepEqual(rows.map(r => [r.id, r.body, r.created_at]), [[winner.value.line_id, results[0].ok ? "first overlapping line" : "second overlapping line", NOW]]);
    assert.deepEqual(f.db.prepare("SELECT citizen_id, read_at FROM porch_presence").all().map(r => [r.citizen_id, r.read_at]), [[2, NOW]]);
    // Another citizen has their own pace. The loser can retry at the exact gap.
    assert.equal((await say(f.env, door, "another speaker", 1)).ok, true);
    clock = NOW + PORCH_MIN_INTERVAL_MS - 1;
    assert.equal((await say(f.env, door, "one millisecond early")).ok, false);
    clock = NOW + PORCH_MIN_INTERVAL_MS;
    const retry = await say(f.env, door, "retry at exact gap");
    assert.equal(retry.ok, true);
    assert.equal(retry.value.listed_until, NOW + PORCH_MIN_INTERVAL_MS + PORCH_PRESENCE_WINDOW_MS);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM porch_lines").get()!.n, 3);
    assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
  });

  test(`${door}: the insert recomputes the rolling-hour step after an intervening thirtieth line`, async t => {
    let clock = NOW + 10_000;
    t.mock.method(Date, "now", () => clock);
    const f = fixture();
    t.after(() => f.db.close());
    const insert = f.db.prepare("INSERT INTO porch_lines(citizen_id, body, day, created_at) VALUES(2, ?, ?, ?)");
    // A valid conversation: 29 lines ten seconds apart, latest at NOW-10s.
    for (let i = 0; i < 29; i++) {
      const stamp = NOW - (29 - i) * 10_000;
      insert.run(`prior line ${i}`, porchDay(stamp), stamp);
    }
    let intercepted = false;
    let prior: unknown;
    let intervening: Awaited<ReturnType<typeof say>> | undefined;
    interceptLast(f, async value => {
      if (intercepted) return;
      intercepted = true; // Nested real request must not re-enter this gate.
      prior = value;
      clock = NOW;
      intervening = await say(f.env, door, "thirtieth line");
      clock = NOW + 10_000;
    });
    const delayed = await say(f.env, door, "delayed thirty-first line");
    assert.equal(intercepted, true);
    assert.equal((prior as { created_at: number }).created_at, NOW - 10_000);
    assert.equal(intervening?.ok, true, "the real intervening writer committed");
    assert.equal(delayed.ok, false, "the 31st line owes the new 20-second gap, not the stale 10-second gap");
    if (door === "http") assert.equal(delayed.status, 429);
    assert.match(delayed.value.error, /every 20 seconds.*30 said.*10s to go/);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM porch_lines").get()!.n, 30);
    assert.equal(f.db.prepare("SELECT read_at FROM porch_presence WHERE citizen_id=2").get()!.read_at, NOW, "a losing line does not refresh presence");
    clock = NOW + 20_000;
    assert.equal((await say(f.env, door, "allowed at new boundary")).ok, true);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM porch_lines").get()!.n, 31);
    // The rolling hour drains; this is a pace, never a daily quota.
    clock = NOW + 3_600_000 + 20_000;
    assert.equal((await say(f.env, door, "conversation after recovery")).ok, true);
    clock += 10_000;
    assert.equal((await say(f.env, door, "recovered exact ten seconds")).ok, true);
    assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
  });
}

test("porch pace fixtures restore the wall clock in the same process", () => {
  assert.equal(Date.now, originalNow);
});
