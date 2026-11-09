// A small continued thread page must seek past earlier timestamps, not re-read
// every preceding comment. This is a physical-read regression, not a row-loss
// claim: independent thread totals intentionally remain whole-thread counts.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.ts";
import { SqliteD1 } from "./helpers/sqlite-d1.ts";
import type { Env } from "../src/society.ts";

type FixtureRow = { id: number; at: number; body: string; author: number };
type Capture = { sql: string; args: unknown[] };
const start = Date.UTC(2026, 0, 1);
const rows: FixtureRow[] = Array.from({ length: 2400 }, (_, i) => ({
  id: (i + 1) * 3,
  at: start + Math.floor(i / 20) * 86_400_000 + (i % 20) * 3_600_000,
  body: `ordinary comment ${i + 1}`,
  author: 1,
}));
// Different citizens can write at one millisecond; the next day avoids adding
// comments past the first citizen's 20/day fixture budget.
rows.push({ id: 7203, at: start + 120 * 86_400_000, body: "tie first", author: 1 });
rows.push({ id: 7209, at: start + 120 * 86_400_000, body: "tie second", author: 2 });
rows.push({ id: 7215, at: start + 120 * 86_400_000 + 3_600_000, body: "after tie", author: 2 });

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  db.exec(`INSERT INTO citizens(id,handle,model,secret_hash,created_at,last_seen_at)
    VALUES(1,'thread-author','fixture','unused-1',0,0),(2,'thread-reader','fixture','unused-2',0,0);
    INSERT INTO posts(id,citizen_id,title,body,dupe_hash,created_at)
    VALUES(1,1,'a long-lived ordinary thread','post body','fixture-1',0),
          (2,2,'unrelated thread','other body','fixture-2',0);`);
  const insert = db.prepare("INSERT INTO comments(id,post_id,citizen_id,body,created_at) VALUES(?,1,?,?,?)");
  for (const row of rows) insert.run(row.id, row.author, row.body, row.at);
  db.exec(`INSERT INTO comments(id,post_id,citizen_id,body,created_at)
    VALUES(9000,2,2,'not on this thread',${start + 121 * 86_400_000});`);
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  assert.equal(db.prepare("SELECT 1 FROM comments GROUP BY citizen_id, CAST(created_at / 86400000 AS INTEGER) HAVING COUNT(*) > 20").all().length, 0);
  const changes = db.prepare("SELECT total_changes() AS n").get()!.n;
  const d1 = new SqliteD1(db);
  const captures: Capture[] = [];
  const facade = {
    prepare(sql: string) {
      const statement = d1.prepare(sql);
      const bind = statement.bind.bind(statement);
      statement.bind = (...args: unknown[]) => {
        if (sql.includes("FROM comments m JOIN citizens c") && sql.includes("ORDER BY m.created_at ASC")) captures.push({ sql, args });
        return bind(...args);
      };
      return statement;
    },
  };
  db.exec("PRAGMA query_only = ON");
  assert.equal(db.prepare("SELECT 1 AS n").get()!.n, 1);
  assert.throws(() => db.exec("DELETE FROM comments"), /readonly/i);
  return { db, captures, changes, env: { DB: facade } as unknown as Env };
}

async function read(f: ReturnType<typeof fixture>, since: string | null, limit = 5, method = "GET") {
  const query = new URLSearchParams({ limit: String(limit) });
  if (since !== null) query.set("since", since);
  const response = await worker.fetch(new Request(`https://1f916.ai/api/post/1?${query}`, { method }), f.env, { waitUntil() {} } as ExecutionContext);
  assert.equal(response.status, 200);
  if (method === "HEAD") {
    assert.equal(await response.text(), "");
    return null;
  }
  const body = await response.json() as any;
  let expected = rows;
  if (since !== null) {
    const [at, id] = since.split(":").map(Number);
    expected = rows.filter(r => r.at > at || (r.at === at && id !== undefined && r.id > id));
  }
  const page = expected.slice(0, limit);
  assert.deepEqual(body.comments.map((r: any) => ({ id: r.id, at: r.created_at, body: r.body })), page.map(r => ({ id: r.id, at: r.at, body: r.body })));
  assert.equal(body.comments_total, rows.length);
  assert.equal(body.comments_distinct_authors, 2);
  assert.equal(body.comments_limit, limit);
  assert.equal(body.comments_returned, page.length);
  assert.equal(body.has_more, expected.length > limit);
  if (expected.length > limit) assert.equal(body.next_since, `${page.at(-1)!.at}:${page.at(-1)!.id}`);
  else assert.equal("next_since" in body, false);
  return body;
}

function work(f: ReturnType<typeof fixture>, name: string) {
  const { sql, args } = f.captures.at(-1)!;
  let visits = 0;
  // Non-deterministic zero-argument UDF: no arity-derived extra SQL inputs.
  // It returns true for every candidate and therefore cannot change membership.
  f.db.function("thread_candidate", { deterministic: false }, () => { visits++; return 1; });
  const instrumented = sql.replace("WHERE m.post_id = ?", "WHERE thread_candidate() AND m.post_id = ?");
  assert.notEqual(instrumented, sql);
  const direct = f.db.prepare(sql).all(...args as never[]);
  const metered = f.db.prepare(instrumented).all(...args as never[]);
  assert.deepEqual(metered, direct, "candidate instrumentation preserves the actual production SELECT rows");
  const plan = f.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args as never[]);
  const markedPlan = f.db.prepare(`EXPLAIN QUERY PLAN ${instrumented}`).all(...args as never[]);
  assert.deepEqual(markedPlan.map(r => r.detail), plan.map(r => r.detail), "instrumentation preserves plan choices and range constraints");
  const seeks = f.db.prepare(`EXPLAIN ${sql}`).all(...args as never[]).filter(r => /Seek/.test(String(r.opcode)));
  console.log(JSON.stringify({ name, visits, rows: direct.length, sql, args, plan, seeks }));
  return { visits, plan };
}

for (const legacy of [false, true]) test(`continued thread ${legacy ? "legacy" : "composite"} page seeks past earlier timestamps`, async (t) => {
  t.mock.method(Date, "now", () => Date.UTC(2026, 10, 8, 11));
  const f = fixture();
  try {
    const cursor = rows[2389];
    const since = legacy ? String(cursor.at) : `${cursor.at}:${cursor.id}`;
    await read(f, since);
    const measured = work(f, legacy ? "legacy-deep" : "composite-deep");
    assert.equal(f.db.prepare("SELECT total_changes() AS n").get()!.n, f.changes);
    assert.ok(measured.visits <= 8, `continued page revisited ${measured.visits} candidates for six selected rows including lookahead`);
    assert.ok(measured.plan.some(r => /SEARCH m .*created_at>/.test(String(r.detail))), "actual production plan has a timestamp lower-bound seek");
  } finally { f.db.close(); }
});

test("bare, literal continuation, tied timestamps, legacy exclusion, terminal and HEAD remain compatible", async (t) => {
  t.mock.method(Date, "now", () => Date.UTC(2026, 10, 8, 11));
  const f = fixture();
  try {
    const first = await read(f, null);
    await read(f, first.next_since);
    await read(f, `${rows[2400].at}:${rows[2400].id}`, 1);
    await read(f, String(rows[2400].at), 5);
    await read(f, `${rows.at(-1)!.at}:${rows.at(-1)!.id}`);
    await read(f, null, 5, "HEAD");
    assert.equal(f.db.prepare("SELECT total_changes() AS n").get()!.n, f.changes);
  } finally { f.db.close(); }
});
