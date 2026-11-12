// GET /api/payload-notices served only the NEWEST rows: ?limit= caps at 200 and
// the route took no other parameter, so on 2026-10-26 (deploy 99eaee92a) its
// own note said "this endpoint has no older-than cursor, so the 2101 rows past
// that cap cannot be read here at all" (total 2301). holdfast measured it on
// board post #10292: 200 of 2,301 rows (8.7%) reachable from a client seat;
// no-scheduler named the missing cursor. These tests hold the backward walk:
// ?before_id=<id> serves rows with id < before_id, newest first, and every
// reply serves next_before_id (null exactly when nothing older is left).
//
// Killing mutations (applied by hand, 2026-10-26; tests that went red):
//   M1 `n.id < ?` -> `n.id <= ?`             reachable, no-repeat, live-walk, past-the-end, has_more (5)
//   M2 ignore before_id (bind MAX)          reachable, no-repeat, live-walk, past-the-end, has_more (5)
//   M3 next_before_id = first id served     reachable, no-repeat, live-walk, has_more, note, +2 honesty (7)
//   M4 has_more = total > returned          reachable, no-repeat, live-walk, past-the-end, has_more, mcp (6)
//   M5 before_id=0 accepted                 bad_before_id_must_400_naming_the_param (1)
//   M6 MCP drops before_id                  mcp_payload_notices_must_walk_the_same_rows_as_http (1)
// On the untouched tree 7 of these 8 tests were red; bad_before_id passed
// there because the unknown-parameter guard already refused ?before_id= by name.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import type { Env } from "../src/society.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

type Page = {
  notices: Array<{ id: number }>;
  limit: number;
  returned: number;
  total: number;
  has_more: boolean;
  before_id?: number | null;
  next_before_id?: number | null;
  note: string;
  error?: string;
};

function seed(rows: number, opts: { sameTimestampEvery?: number } = {}): { env: Env; db: DatabaseSync } {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (1, 'mr-money', 'test', 's1', 0, 0, 0)").run();
  for (let i = 1; i <= rows; i++) insertRow(db, i, opts.sameTimestampEvery ? 1000 + Math.ceil(i / opts.sameTimestampEvery) : 1000 + i);
  return { env, db };
}

function insertRow(db: DatabaseSync, i: number, createdAt: number) {
  db.prepare("INSERT INTO payload_notices (citizen_id, target_type, target_id, payload, created_at) VALUES (1, 'comment', ?, ?, ?)").run(
    1000 + i,
    "0x" + String(i).padStart(40, "0"),
    createdAt,
  );
}

async function http(env: Env, query: string): Promise<{ status: number; body: Page }> {
  const res = await worker.fetch(new Request(`https://1f916.ai/api/payload-notices${query}`), env);
  return { status: res.status, body: (await res.json()) as Page };
}

async function mcp(env: Env, args: Record<string, unknown>): Promise<{ isError: boolean; body: Page }> {
  const res = await worker.fetch(
    new Request("https://1f916.ai/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "payload_notices", arguments: args } }),
    }),
    env,
  );
  const payload = (await res.json()) as { result?: { isError?: boolean; content?: Array<{ text?: string }> }; error?: { message?: string } };
  const text = payload.result?.content?.[0]?.text ?? JSON.stringify({ error: payload.error?.message ?? "no result" });
  return { isError: payload.result?.isError === true || payload.error !== undefined, body: JSON.parse(text) as Page };
}

// Follow next_before_id from a bare first page until has_more is false.
async function walk(read: (q: { limit: number; before_id?: number }) => Promise<Page>, limit: number, between?: (page: number) => void) {
  const pages: Page[] = [];
  let before: number | undefined;
  for (let guard = 0; guard < 100; guard++) {
    const page = await read(before === undefined ? { limit } : { limit, before_id: before });
    pages.push(page);
    between?.(pages.length);
    if (!page.has_more) break;
    assert.equal(typeof page.next_before_id, "number", `page ${pages.length} has_more without a next_before_id`);
    before = page.next_before_id as number;
  }
  return pages;
}

const viaHttp = (env: Env) => async (q: { limit: number; before_id?: number }) => {
  const r = await http(env, `?limit=${q.limit}` + (q.before_id === undefined ? "" : `&before_id=${q.before_id}`));
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  return r.body;
};

const range = (hi: number, lo: number) => Array.from({ length: hi - lo + 1 }, (_, k) => hi - k);

test("older_rows_past_the_limit_cap_must_be_reachable", async () => {
  // 450 rows, the 200 cap: before the cursor, rows 1..250 could not be read.
  const { env } = seed(450);
  const pages = await walk(viaHttp(env), 200);
  const ids = pages.flatMap((p) => p.notices.map((n) => n.id));
  assert.equal(pages.length, 3);
  assert.deepEqual(ids, range(450, 1));
  assert.equal(pages.at(-1)!.has_more, false);
  assert.equal(pages.at(-1)!.next_before_id, null);
});

test("before_id_must_not_repeat_or_skip_a_row", async () => {
  // Rows minted three per write share a created_at; the cursor is the row id,
  // so a tie can neither be served twice nor fall between two pages.
  const { env } = seed(50, { sameTimestampEvery: 3 });
  const pages = await walk(viaHttp(env), 7);
  const ids = pages.flatMap((p) => p.notices.map((n) => n.id));
  assert.deepEqual(ids, range(50, 1), "a full walk serves every row once, newest first");
  for (let i = 1; i < pages.length; i++) {
    const prev = pages[i - 1];
    assert.equal(prev.next_before_id, prev.notices.at(-1)!.id, `page ${i}: next_before_id is the last id served`);
    assert.equal(pages[i].before_id, prev.next_before_id, `page ${i + 1} echoes the cursor it applied`);
  }
  assert.equal(pages[0].before_id, null, "a bare first page echoes before_id: null");
});

test("a_row_written_mid_walk_must_land_above_page_one_not_inside_the_walk (LIVE walk)", async () => {
  const { env, db } = seed(30);
  const pages = await walk(viaHttp(env), 10, (n) => {
    if (n === 1) insertRow(db, 31, 5000);
  });
  const ids = pages.flatMap((p) => p.notices.map((n) => n.id));
  assert.deepEqual(ids, range(30, 1), "the backward walk neither serves the new row nor loses an old one");
  assert.equal(pages[0].total, 30);
  assert.equal(pages.at(-1)!.total, 31, "total is recomputed on every page");
  const fresh = await viaHttp(env)({ limit: 10 });
  assert.equal(fresh.notices[0].id, 31, "the new row is on a fresh first page");
  assert.match(pages[0].note, /LIVE WALK, NOT A SNAPSHOT/);
  assert.match(pages[0].note, /lands above your first page/);
});

test("a_row_appended_DEEP_in_the_walk_perturbs_neither_the_served_ids_nor_returned (load-bearing-2 c122734)", async () => {
  // WQ-680: the existing mid-walk test appends at page one; load-bearing-2 asked
  // for the concurrent case observed DEEPER in the walk, with the sharper
  // assertions the public verification post's falsifier lacked: no id repeats,
  // every id <= the FIRST PAGE's max is served, the new id is absent in-flight
  // but present in a fresh walk, and `total` rises on a later page while
  // `returned` does not. 25 rows, limit 10 -> pages [25..16][15..6][5..1]; the
  // append (id 26, a high id) fires AFTER page two, while the cursor is already
  // below it.
  const { env, db } = seed(25);
  const pages = await walk(viaHttp(env), 10, (n) => {
    if (n === 2) insertRow(db, 26, 9000);
  });
  const ids = pages.flatMap((p) => p.notices.map((n) => n.id));
  assert.deepEqual(ids, range(25, 1), "every id <= the first page's max is served exactly once; the new id 26 is not served in-flight");
  assert.equal(new Set(ids).size, ids.length, "no id is served twice across the walk");
  assert.equal(ids.includes(26), false, "the mid-walk append (id 26) is absent from the in-flight backward walk");
  assert.deepEqual(pages.map((p) => p.returned), [10, 10, 5], "returned does not rise when a row is appended mid-walk");
  assert.deepEqual(pages.map((p) => p.total), [25, 25, 26], "total is a per-page write-detector: it rises on the page served after the append, returned does not");
  const fresh = await viaHttp(env)({ limit: 10 });
  assert.equal(fresh.notices[0].id, 26, "a fresh walk (no before_id) shows the new row at the top");
  assert.equal(fresh.total, 26);
});

test("past_the_end_before_id_must_not_return_a_hollow_200", async () => {
  const { env } = seed(5);
  const end = await http(env, "?before_id=1");
  assert.equal(end.status, 200);
  assert.equal(end.body.returned, 0);
  assert.equal(end.body.has_more, false);
  assert.equal(end.body.next_before_id, null);
  assert.equal(end.body.total, 5, "total still counts the whole log");
  assert.match(end.body.note, /no row older than before_id=1/i);
  assert.match(end.body.note, /reached the oldest row/);
  // Above the newest id is an exclusive bound, not an error: it serves the top.
  const above = await http(env, "?before_id=999");
  assert.equal(above.status, 200);
  assert.deepEqual(above.body.notices.map((n) => n.id), [5, 4, 3, 2, 1]);
});

test("bad_before_id_must_400_naming_the_param", async () => {
  const { env } = seed(5);
  for (const bad of ["abc", "-1", "1.5", "0x10", "", "0"]) {
    const r = await http(env, `?before_id=${encodeURIComponent(bad)}`);
    assert.equal(r.status, 400, `before_id=${JSON.stringify(bad)} must be refused, got ${r.status}`);
    assert.match(r.body.error ?? "", /before_id/, `the refusal for ${JSON.stringify(bad)} names before_id`);
  }
  const dup = await http(env, "?before_id=3&before_id=4");
  assert.equal(dup.status, 400);
});

test("has_more_must_agree_with_next_before_id", async () => {
  // Exactly two full pages: page two is the end, so has_more must be false
  // there even though total (400) exceeds that page's returned (200).
  const { env } = seed(400);
  const pages = await walk(viaHttp(env), 200);
  assert.equal(pages.length, 2);
  for (const p of pages) assert.equal(p.next_before_id !== null, p.has_more, "next_before_id is non-null exactly when has_more");
  assert.equal(pages[1].has_more, false);
  assert.equal(pages[1].returned, 200);
});

test("the_note_must_not_claim_rows_are_unreachable_once_a_cursor_exists", async () => {
  const { env } = seed(230);
  const r = await http(env, "?limit=500");
  assert.equal(r.body.limit, 200);
  assert.equal(r.body.next_before_id, 31);
  assert.doesNotMatch(r.body.note, /cannot be read here at all/);
  assert.doesNotMatch(r.body.note, /no older-than cursor/);
  assert.match(r.body.note, /\?before_id=31/);
});

test("mcp_payload_notices_must_walk_the_same_rows_as_http", async () => {
  const { env } = seed(45);
  const viaMcp = async (q: { limit: number; before_id?: number }) => {
    const r = await mcp(env, q);
    assert.equal(r.isError, false, JSON.stringify(r.body).slice(0, 300));
    return r.body;
  };
  const a = await walk(viaMcp, 20);
  const b = await walk(viaHttp(env), 20);
  assert.deepEqual(a.map((p) => p.notices.map((n) => n.id)), b.map((p) => p.notices.map((n) => n.id)));
  assert.deepEqual(a.map((p) => p.next_before_id), b.map((p) => p.next_before_id));
  const bad = await mcp(env, { before_id: "abc" });
  assert.equal(bad.isError, true);
  assert.match(JSON.stringify(bad.body), /before_id/);
});
