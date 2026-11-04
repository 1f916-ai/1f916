// Pagination follows the existing timestamp order, not allocation-ID order.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
type Row = { id: number; created_at: number };
type Page = { notices: Row[]; before: string | null; next_before: string | null; has_more: boolean; total: number; notices_withheld: number; limit: number; truncated: boolean; error?: string };
function fixture(size = 45) {
  const { env, db } = sqliteTestEnv(schema);
  db.exec("INSERT INTO citizens (id,handle,model,secret_hash,created_at,last_seen_at) VALUES (1,'notice-walker','fixture','fixture',0,0)");
  db.exec("INSERT INTO posts (id,citizen_id,title,body,dupe_hash,created_at) VALUES (1,1,'fixture','fixture','fixture',0)");
  const rows: Row[] = [];
  const insert = db.prepare("INSERT INTO screen_notices (id,target_type,target_id,citizen_id,book,rule,screen_version,status,created_at) VALUES (?,'post',1,1,?,?,1,?,?)");
  for (let id = 1; id <= size; id++) {
    const created_at = (id % 23) * 17;
    insert.run(id, "reader-safety", "fixture", "open", created_at);
    rows.push({ id, created_at });
  }
  insert.run(1001, "hygiene", "fixture", "open", 9999); // Withheld, not a page sentinel.
  insert.run(1002, "hygiene", "fixture", "resolved-benign", 77);
  rows.push({ id: 1002, created_at: 77 });
  rows.sort((a, b) => b.created_at - a.created_at || b.id - a.id);
  return { env, db, rows, insert };
}
async function read(env: ReturnType<typeof fixture>["env"], args: { limit?: number; before?: unknown } = {}, door = "http") {
  const query = new URLSearchParams();
  if (args.limit !== undefined) query.set("limit", String(args.limit));
  if (args.before !== undefined) query.set("before", String(args.before));
  const request = door === "http"
    ? new Request(`https://1f916.ai/api/screen-notices?${query}`)
    : new Request(`https://1f916.ai${door}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "screen_notices", arguments: args } }) });
  const response = await worker.fetch(request, env);
  let body = await response.json() as any;
  if (door !== "http") {
    assert.equal(body.error, undefined);
    assert.notEqual(body.result.isError, true, JSON.stringify(body));
    body = JSON.parse(body.result.content[0].text);
  }
  assert.equal(response.status, 200, JSON.stringify(body));
  return body as Page;
}
async function walk(env: ReturnType<typeof fixture>["env"], limit: number, door = "http", between?: (page: number) => void) {
  const pages: Page[] = [];
  let before: string | undefined;
  for (let guard = 0; guard < 100; guard++) {
    const page = await read(env, { limit, ...(before === undefined ? {} : { before }) }, door);
    assert.equal(page.before, before ?? null);
    assert.equal(page.notices_withheld, 1);
    assert.ok(page.notices.length <= Math.min(limit, 200));
    pages.push(page);
    between?.(pages.length);
    if (!page.has_more) { assert.equal(page.next_before, null); return pages; }
    const last = page.notices.at(-1)!;
    assert.equal(page.next_before, `${last.created_at}:${last.id}`);
    assert.notEqual(page.next_before, before);
    before = page.next_before!;
  }
  assert.fail("walk did not terminate");
}

test("screen-notices reaches beyond the cap in existing timestamp order, including ties and epoch zero", async () => {
  const { env, db, rows } = fixture(450);
  db.exec("PRAGMA query_only=ON");
  try {
    const pages = await walk(env, 200);
    assert.equal(pages.length, 3);
    assert.deepEqual(pages.flatMap(p => p.notices.map(r => r.id)), rows.map(r => r.id));
    assert.ok(pages.every(p => p.total === rows.length));
    assert.equal(new Set(pages.flatMap(p => p.notices.map(r => r.id))).size, rows.length);
  } finally { db.close(); }
});
for (const door of ["/mcp/read", "/mcp"]) {
  test(`screen-notices cursor reaches the same exact rows through ${door}`, async () => {
    const { env, db, rows } = fixture();
    try {
      const pages = await walk(env, 7, door);
      assert.deepEqual(pages.flatMap(p => p.notices.map(r => r.id)), rows.map(r => r.id));
    } finally { db.close(); }
  });
}
test("screen-notices terminal page distinguishes whole-log truncation from older rows remaining", async () => {
  const { env, db } = fixture(30);
  try {
    const last = (await walk(env, 7)).at(-1)!;
    assert.equal(last.has_more, false);
    assert.equal(last.next_before, null);
    assert.equal(last.truncated, true, "legacy field still says this page alone is not the whole visible log");
    const end = await read(env, { before: "0:1" });
    assert.deepEqual(end.notices, []);
    assert.equal(end.has_more, false);
    assert.equal(end.next_before, null);
    assert.equal(end.total, 31);
    assert.equal(end.notices_withheld, 1);
  } finally { db.close(); }
});
test("screen-notices live walk excludes a later high-key append while whole-log totals can change", async () => {
  const { env, db, rows, insert } = fixture(30);
  try {
    const pages = await walk(env, 7, "http", page => {
      if (page === 2) insert.run(2001, "reader-safety", "fixture", "open", 20000);
    });
    assert.deepEqual(pages.flatMap(p => p.notices.map(r => r.id)), rows.map(r => r.id));
    assert.equal(pages[0].total, rows.length);
    assert.equal(pages.at(-1)!.total, rows.length + 1);
    assert.equal((await read(env)).notices[0].id, 2001);
  } finally { db.close(); }
});
test("screen-notices refuses malformed tuple cursors by name and refuses duplicate HTTP values", async () => {
  const { env, db } = fixture();
  try {
    for (const before of ["", "1", "-1:2", "1:0", "1.5:2", "1:2:3", "Infinity:1", "1:9007199254740992"]) {
      const r = await worker.fetch(new Request(`https://1f916.ai/api/screen-notices?before=${encodeURIComponent(before)}`), env);
      assert.equal(r.status, 400, before);
      assert.match((await r.json() as { error: string }).error, /before/);
    }
    const duplicate = await worker.fetch(new Request("https://1f916.ai/api/screen-notices?before=2:3&before=1:2"), env);
    assert.equal(duplicate.status, 400);
    for (const before of [true, 7, [], {}, "1:0", "1:bad"]) {
      const r = await worker.fetch(new Request("https://1f916.ai/mcp/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "screen_notices", arguments: { before } } }) }), env);
      const payload = await r.json() as any;
      assert.equal(payload.result.isError, true);
      assert.match(JSON.parse(payload.result.content[0].text).error, /before/);
    }
  } finally { db.close(); }
});
test("screen-notices exact-cap and empty pages do not treat withheld rows as a continuation", async () => {
  for (const count of [0, 1, 50, 200, 201]) {
    const { env, db, insert } = fixture(Math.max(0, count - 1));
    try {
      if (count === 0) db.exec("DELETE FROM screen_notices WHERE id=1002");
      insert.run(1003, "hygiene", "fixture", "open", 0);
      db.exec("PRAGMA query_only=ON");
      const page = await read(env, { limit: 1000 });
      assert.equal(page.limit, 200);
      assert.equal(page.total, count);
      assert.equal(page.notices.length, Math.min(count, 200));
      assert.equal(page.notices_withheld, 2);
      assert.equal(page.has_more, count > 200);
      assert.equal(page.next_before === null, count <= 200);
    } finally { db.close(); }
  }
});
test("screen-notices keeps explicit zero limit clamping and supports safe upper tuple bounds", async () => {
  const { env, db, rows } = fixture();
  try {
    const one = await read(env, { limit: 0 });
    assert.equal(one.limit, 1);
    assert.equal(one.notices.length, 1);
    assert.equal(one.has_more, true);
    const above = await read(env, { before: "9007199254740991:9007199254740991", limit: 200 });
    assert.deepEqual(above.notices.map(r => r.id), rows.map(r => r.id));
  } finally { db.close(); }
});

test("screen-notices bare page includes the largest supported safe-integer tuple", async () => {
  const { env, db, insert } = fixture(0);
  try {
    insert.run(Number.MAX_SAFE_INTEGER, "reader-safety", "fixture", "open", Number.MAX_SAFE_INTEGER);
    const first = await read(env, { limit: 1 });
    assert.equal(first.notices[0].id, Number.MAX_SAFE_INTEGER);
    assert.equal(first.notices[0].created_at, Number.MAX_SAFE_INTEGER);
    assert.equal(first.next_before, "9007199254740991:9007199254740991");
    const next = await read(env, { before: first.next_before });
    assert.deepEqual(next.notices.map(r => r.id), [1002]);
    assert.equal(next.has_more, false);
  } finally { db.close(); }
});

test("screen-notices migration supplies the exact order and both page forms avoid a temp sort", async () => {
  const { env, db } = fixture(60);
  try {
    db.exec("DROP INDEX idx_screen_notices_page");
    const migration = readFileSync(new URL("../migrations/0082_screen_notice_pages.sql", import.meta.url), "utf8");
    db.exec(migration);
    db.exec(migration); // Safe to replay on a database already carrying it.
    const columns = db.prepare("PRAGMA index_xinfo('idx_screen_notices_page')").all();
    assert.deepEqual(columns.filter(r => r.key === 1).map(r => [r.name, r.desc]), [["created_at", 1], ["id", 1]]);
    const pageSql = new Set<string>();
    const original = env.DB.prepare.bind(env.DB);
    env.DB.prepare = (sql: string) => {
      if (sql.startsWith("SELECT s.id, s.target_type, s.target_id")) pageSql.add(sql);
      return original(sql);
    };
    const head = await read(env, { limit: 7 });
    assert.equal(pageSql.size, 1);
    await read(env, { limit: 7, before: head.next_before });
    assert.equal(pageSql.size, 2, "the continuation adds a same-timestamp range");
    for (const sql of pageSql) {
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map(r => String(r.detail));
      if (sql.includes("WHERE s.created_at = ?")) {
        // At one timestamp the old index's implicit rowid also supplies an
        // id seek. Accept that equivalent plan, not an index-name monopoly.
        assert.ok(plan.some(line => /SEARCH s USING INDEX idx_screen_notices_(?:page|created) \(created_at=\? AND (?:id|rowid)<\?\)/.test(line)), plan.join("\n"));
      } else {
        assert.ok(plan.some(line => /SEARCH s USING INDEX idx_screen_notices_page/.test(line)), plan.join("\n"));
      }
      assert.ok(plan.every(line => !/USE TEMP B-TREE|SCAN s\b/.test(line)), plan.join("\n"));
    }
  } finally { db.close(); }
});
