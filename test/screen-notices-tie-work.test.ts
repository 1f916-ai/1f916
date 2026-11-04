// Candidate work of the PAGE SELECTs, not the unchanged global count/group
// reads. Replay captured real SQL with an equivalent-result/plan visit probe
// outside the Worker call, so instrumentation never enters shared SQL capture.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.ts";
import { screenNotices } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
type Row = { id: number; created_at: number };
type Call = { sql: string; args: unknown[] };
function fixture(size: number, timestamp = 12) {
  const { env, db } = sqliteTestEnv(schema);
  db.exec("INSERT INTO citizens(id,handle,model,secret_hash,created_at,last_seen_at) VALUES(1,'tie-work','fixture','fixture',0,0)");
  const insert = db.prepare("INSERT INTO screen_notices(id,target_type,target_id,citizen_id,book,rule,screen_version,status,created_at) VALUES(?,'post',1,1,'reader-safety','fixture',1,'open',?)");
  const rows: Row[] = [];
  db.exec("BEGIN");
  for (let id = 1; id <= size; id++) { insert.run(id, timestamp); rows.push({ id, created_at: timestamp }); }
  if (timestamp > 0) for (let i = 1; i <= 8; i++) { const id = size + i; insert.run(id, timestamp - 1); rows.push({ id, created_at: timestamp - 1 }); }
  db.exec("COMMIT");
  rows.sort((a, b) => b.created_at - a.created_at || b.id - a.id);
  const calls: Call[] = [];
  const pageStatements = new Set<unknown>();
  const pageBatches: number[] = [];
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql: string) => {
    const statement = prepare(sql);
    if (sql.startsWith("SELECT s.id, s.target_type, s.target_id")) {
      pageStatements.add(statement);
      const bind = statement.bind.bind(statement);
      statement.bind = (...args: unknown[]) => { calls.push({ sql, args }); return bind(...args); };
    }
    return statement;
  };
  const batch = env.DB.batch.bind(env.DB);
  env.DB.batch = async (statements) => {
    if (statements.every(s => pageStatements.has(s))) pageBatches.push(statements.length);
    return batch(statements);
  };
  let visits = 0;
  db.function("notice_page_visit", (_id: number) => { visits++; return 1; });
  function candidateWork() {
    let total = 0;
    for (const call of calls) {
      const instrumented = call.sql.replace(/\bWHERE\b/, "WHERE notice_page_visit(s.id) AND");
      assert.notEqual(instrumented, call.sql);
      const explain = (sql: string) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...call.args as never[]).map(r => r.detail);
      assert.deepEqual(explain(instrumented), explain(call.sql), "probe preserves the actual access plan");
      const original = db.prepare(call.sql).all(...call.args as never[]);
      visits = 0;
      const measured = db.prepare(instrumented).all(...call.args as never[]);
      assert.deepEqual(measured, original, "probe preserves complete SQL results, including lookahead");
      total += visits;
    }
    return total;
  }
  db.exec("PRAGMA query_only=ON");
  const changesBefore = Number(db.prepare("SELECT total_changes() AS n").get()!.n);
  return { env, db, rows, calls, pageBatches, candidateWork, changesBefore };
}
async function read(env: ReturnType<typeof fixture>["env"], door: string, limit: number, before: string) {
  const request = door === "http"
    ? new Request(`https://1f916.ai/api/screen-notices?${new URLSearchParams({ limit: String(limit), before })}`)
    : new Request(`https://1f916.ai${door}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "screen_notices", arguments: { limit, before } } }) });
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 200);
  let page = await response.json() as any;
  if (door !== "http") { assert.equal(page.error, undefined); assert.notEqual(page.result.isError, true); page = JSON.parse(page.result.content[0].text); }
  return page;
}
function checkPage(page: any, rows: Row[], limit: number, before: string) {
  const [time, id] = before.split(":").map(Number);
  const candidates = rows.filter(r => r.created_at < time || r.created_at === time && r.id < id);
  assert.deepEqual(page.notices.map((r: Row) => [r.id, r.created_at]), candidates.slice(0, limit).map(r => [r.id, r.created_at]));
  assert.equal(page.before, before);
  assert.equal(page.total, rows.length);
  assert.equal(page.notices_withheld, 0);
  assert.equal(page.truncated, page.notices.length < rows.length);
  assert.equal(page.has_more, candidates.length > limit);
  const last = candidates[limit - 1];
  assert.equal(page.next_before, candidates.length > limit ? `${last.created_at}:${last.id}` : null);
}
for (const size of [100, 1000, 10000]) {
  test(`screen-notices page work does not grow with ${size} already-passed timestamp ties`, async t => {
    const { env, db, rows, candidateWork } = fixture(size);
    try {
      const page = await read(env, "http", 1, "12:11");
      checkPage(page, rows, 1, "12:11");
      const work = candidateWork();
      t.diagnostic(JSON.stringify({ tied_rows: size, page_size: 1, page_candidates: work }));
      assert.ok(work <= 4, `page inspected ${work} candidates for a one-row page after skipping the dense tie prefix`);
    } finally { db.close(); }
  });
}
for (const door of ["http", "/mcp/read", "/mcp"]) {
  test(`screen-notices tie boundary, partial group and older fallback stay bounded: ${door}`, async t => {
    const { env, db, rows, calls, pageBatches, candidateWork } = fixture(1000);
    try {
      for (const before of ["12:1", "12:2", "12:3", "11:1006", "0:1"]) {
        calls.length = 0; pageBatches.length = 0;
        const page = await read(env, door, 3, before);
        checkPage(page, rows, 3, before);
        const work = candidateWork();
        t.diagnostic(JSON.stringify({ before, page_candidates: work }));
        assert.ok(work <= 8, `page work ${work} exceeded two bounded four-row probes`);
        if (calls.length > 1) assert.deepEqual(pageBatches, [2], "split arms must share one transactional batch");
      }
    } finally { db.close(); }
  });
}
test("screen-notices epoch-zero ties and safe upper bounds preserve exact semantics", async () => {
  const { env, db, rows, calls, candidateWork } = fixture(1000, 0);
  try {
    for (const before of ["0:11", "0:1", "9007199254740991:9007199254740991"]) {
      calls.length = 0;
      const page = await read(env, "http", 2, before);
      checkPage(page, rows, 2, before);
      assert.ok(candidateWork() <= 6);
    }
  } finally { db.close(); }
});
test("screen-notices keeps a split page inside one read-only transaction", async () => {
  const { env, db, calls, pageBatches, changesBefore } = fixture(100);
  const exec = db.exec.bind(db);
  const transactions: string[] = [];
  db.exec = (sql: string) => { transactions.push(sql); return exec(sql); };
  try {
    await screenNotices(env, 3, "12:3");
    // The base's single SELECT also satisfied page-level consistency. If the
    // implementation splits it, both disjoint arms must still see one state.
    if (calls.length > 1) {
      assert.deepEqual(pageBatches, [2]);
      assert.deepEqual(transactions, ["BEGIN", "COMMIT"]);
    }
    assert.equal(Number(db.prepare("SELECT total_changes() AS n").get()!.n), changesBefore);
  } finally { db.close(); }
});
