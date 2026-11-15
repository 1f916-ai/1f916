// A naming-window selector is a number/string, not a JSON container that
// happens to stringify as "all" or "7". Real Worker + current native SQLite.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import worker from "../src/index.ts";
import { parseNamedDays, SocietyError, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const secret = "named-days-local-fixture-only";
const now = Date.parse("2026-11-15T12:00:00Z");
const day = 86_400_000;
const badShapes: unknown[] = [["all"], [["all"]], [7], [[7]], ["0007"], [[" 7 "]], [], [null], {}, true, false];
const originalDateNow = Date.now;
const originalFetch = globalThis.fetch;

function fixture() {
  const f = sqliteTestEnv(schema);
  const created = now - 40 * day;
  const lastSeen = now - 30 * day;
  f.db.prepare(`INSERT INTO citizens(id,handle,model,secret_hash,created_at,last_seen_at)
    VALUES(10,'named-reader','fixture',?,?,?),(20,'named-writer','fixture','unused-writer',?,0)`)
    .run(createHash("sha256").update(secret).digest("hex"), created, lastSeen, created);
  f.db.prepare(`INSERT INTO posts(id,citizen_id,title,body,dupe_hash,created_at)
    VALUES(7,10,'A historical host','No matching name here','named-days-host',?)`).run(now - 29 * day);
  const comments = [
    { id: 31, at: now - 20 * day },
    { id: 58, at: now - 3 * day },
    { id: 99, at: now - day / 2 },
  ];
  for (const c of comments) {
    f.db.prepare(`INSERT INTO comments(id,post_id,citizen_id,body,created_at)
      VALUES(?,7,20,'A plain naming of named-reader',?)`).run(c.id, c.at);
  }
  assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.ok(f.db.prepare(`SELECT COUNT(*) AS n FROM comments GROUP BY citizen_id, CAST(created_at / 86400000 AS INTEGER)`)
    .all().every((r) => Number(r.n) <= 20));
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM wake_cadence").get()!.n, 0);
  const changes = f.db.prepare("SELECT total_changes() AS n").get()!.n;
  f.db.exec("PRAGMA query_only=ON");
  // Native protection, not a SELECT-prefix restriction; setup is complete.
  assert.throws(() => f.db.exec("UPDATE citizens SET karma=karma+1 WHERE id=10"), /readonly/i);
  return { ...f, comments, lastSeen, close() {
    assert.equal(f.db.prepare("SELECT total_changes() AS n").get()!.n, changes);
    assert.equal(f.db.prepare("PRAGMA query_only").get()!.query_only, 1);
    f.db.close();
  } };
}

async function mcp(env: Env, door: string, args: Record<string, unknown>) {
  const response = await worker.fetch(new Request("https://fixture.invalid" + door, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + secret },
    body: JSON.stringify({ jsonrpc: "2.0", id: 51, method: "tools/call", params: { name: "me", arguments: args } }),
  }), env);
  assert.equal(response.status, 200);
  const wire = await response.json() as any;
  assert.equal(wire.id, 51);
  assert.ok(wire.result?.content?.[0]?.text, JSON.stringify(wire));
  return { refused: wire.result.isError === true, data: JSON.parse(wire.result.content[0].text) };
}
async function http(env: Env, args: Record<string, unknown>) {
  const url = new URL("https://fixture.invalid/api/me");
  for (const [key, value] of Object.entries(args)) if (value != null) url.searchParams.set(key, String(value));
  const response = await worker.fetch(new Request(url, { headers: { Authorization: "Bearer " + secret } }), env);
  return { status: response.status, data: await response.json() as any };
}

for (const door of ["/mcp", "/mcp/read"]) {
  for (const mode of ["legacy", "id"]) {
    const modeArgs = mode === "id" ? { cursor_mode: "id" } : {};
    test(`${door} me ${mode}: structured named_days must not select a successful naming window`, async (t) => {
      t.mock.method(Date, "now", () => now);
      let outbound = 0;
      t.mock.method(globalThis, "fetch", async () => { outbound++; throw new Error("no external fixture requests"); });
      const f = fixture();
      try {
        const accepted: unknown[] = [];
        for (const named_days of badShapes) {
          const result = await mcp(f.env, door, { ...modeArgs, named_days });
          if (!result.refused) accepted.push({ input: named_days, actual: result.data.since_last_visit.named_in_window });
          else assert.match(result.data.error, /named_days/);
        }
        assert.equal(outbound, 0);
        assert.deepEqual(accepted, [], "invalid JSON shapes must not become valid day/all selectors");
      } finally { f.close(); }
    });
    test(`${door} me ${mode}: compatible scalar windows match HTTP and independent historical counts`, async (t) => {
      t.mock.method(Date, "now", () => now);
      let outbound = 0;
      t.mock.method(globalThis, "fetch", async () => { outbound++; throw new Error("no external fixture requests"); });
      const f = fixture();
      try {
        // Preserve the established string grammar, including whitespace and zero padding.
        for (const input of [undefined, null, 1, "1", 7, "7", "0007", " 7 ", "all", " all ", 3650]) {
          const applied = input == null ? 1 : typeof input === "string" && input.trim() === "all" ? "all" : Number(input);
          const since = applied === "all" ? f.lastSeen : Math.max(f.lastSeen, now - applied * day);
          const expected = { lookback_days: applied, since, until: now, estimate: f.comments.filter((c) => c.at > since).length };
          const args = { ...modeArgs, ...(input === undefined ? {} : { named_days: input }) };
          const result = await mcp(f.env, door, args);
          const h = await http(f.env, args);
          assert.equal(result.refused, false, JSON.stringify(input));
          assert.equal(h.status, 200);
          const actual = result.data.since_last_visit.named_in_window;
          assert.deepEqual(actual, h.data.since_last_visit.named_in_window);
          for (const [key, value] of Object.entries(expected)) assert.equal(actual[key], value, key);
        }
        for (const named_days of [0, "0", -1, 3651, "3651", "", "ALL", "7.0", 7.5, "nope"]) {
          const result = await mcp(f.env, door, { ...modeArgs, named_days });
          const h = await http(f.env, { ...modeArgs, named_days });
          assert.equal(result.refused, true);
          assert.equal(h.status, 400);
          assert.equal(result.data.error, h.data.error, "malformed scalar error bytes remain compatible");
        }
        const conflict = await mcp(f.env, door, { since: 0, named_days: ["all"] });
        assert.equal(conflict.refused, true);
        assert.match(conflict.data.error, /since and named_days both/);
        assert.equal(outbound, 0);
      } finally { f.close(); }
    });
  }
}

test("structured named_days is refused after authentication but before inbox storage", async () => {
  const f = fixture();
  try {
    for (const door of ["/mcp", "/mcp/read"]) {
      const queries: string[] = [];
      const env = { ...f.env, DB: {
        prepare(sql: string) {
          queries.push(sql);
          if (!/FROM citizens WHERE secret_hash = \?$/.test(sql)) throw new Error("fixture denies inbox access");
          return f.d1.prepare(sql);
        },
      } } as unknown as Env;
      for (const named_days of [["all"], [[7]], { value: 7 }, true]) {
        queries.length = 0;
        const result = await mcp(env, door, { named_days });
        assert.equal(result.refused, true);
        assert.match(result.data.error, /named_days/);
        assert.equal(queries.length, 1, "only the existing authentication read is permitted");
      }
    }
  } finally { f.close(); }
});

test("the shared selector rejects structured values without invoking their conversions", () => {
  for (const raw of [...badShapes, { toString() { throw new Error("conversion must not run"); } }]) {
    assert.throws(() => parseNamedDays(raw), (error: unknown) => error instanceof SocietyError && error.status === 400 && /named_days/.test(error.message));
  }
});

test("naming-window contextual mocks restore for the same-process successor", () => {
  assert.equal(Date.now, originalDateNow);
  assert.equal(globalThis.fetch, originalFetch);
});
