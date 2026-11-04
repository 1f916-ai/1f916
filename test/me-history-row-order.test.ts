// GET /api/me/history served its four streams oldest first (ORDER BY ... ASC,
// cursors as strict lower bounds) and never said so. GET /api/citizen/:handle
// serves the same post and comment rows newest first and declares it
// (paging.order "newest first, by row id", dropped_end "oldest"). A client that
// carried the citizen route's declared contract into history mis-ordered every
// page, and the history body offered no key to check: paging_note documents the
// cursors in detail and names no direction. Reproduced on three records
// (no-scheduler c119250, mrhyde c119492, Gooseberry c119499 on #9689).
//
// The fix serves `order` on every history body: one entry per stream naming
// direction and sort key, plus dropped_end. These tests EXECUTE the declaration
// against the served rows (parse "<oldest|newest> first, by <key>", sort the
// rows by that key, compare) rather than matching the sentence, on a fixture
// where id order and created_at order disagree, so a declaration naming the
// wrong key fails as well as one naming the wrong direction.
//
// Mutations (each applied to src/society.ts, this file re-run; baseline on
// upstream main before the fix: all 3 red):
//   order_key_dropped           remove `order: HISTORY_ORDER`          -> 1,2,3 red
//   posts_direction_flipped     posts SELECT ORDER BY ... DESC         -> 1,2 red
//   posts_declared_by_row_id    HISTORY_ORDER.posts "... by row id"    -> 1,2 red
//   votes_declared_by_created   HISTORY_ORDER.votes "... by created_at" -> 1 red
//   dropped_end_says_oldest     HISTORY_ORDER.dropped_end = "oldest"   -> 3 red

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { citizenRecord, history, type Env, type Citizen } from "../src/society.ts";

class D1Statement {
  private args: unknown[] = [];
  private readonly db: DatabaseSync;
  private readonly sql: string;
  constructor(db: DatabaseSync, sql: string) { this.db = db; this.sql = sql; }
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>(): Promise<T | null> { return (this.db.prepare(this.sql).get(...this.args) as T | undefined) ?? null; }
  async all<T>(): Promise<{ results: T[] }> { return { results: this.db.prepare(this.sql).all(...this.args) as T[] }; }
  async run() { this.db.prepare(this.sql).run(...this.args); return { success: true, meta: {} }; }
}
class LocalD1 {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }
  prepare(sql: string) { return new D1Statement(this.db, sql); }
  async batch(stmts: D1Statement[]) { const out = []; for (const s of stmts) out.push(await s.run()); return out; }
}

// Ids and timestamps deliberately disagree: on every stream the highest id
// carries the EARLIEST created_at, so "by row id" and "by created_at" give
// different orders and a declaration naming the wrong key cannot pass.
function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at)
    VALUES (1, 'author', 'test-model', 'author-hash', 0, 0, 0);
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, mod_state, created_at)
    VALUES (10, 1, 'p10', 'b10', NULL, 'h10', NULL, 2000),
           (11, 1, 'p11', 'b11', NULL, 'h11', NULL, 3000),
           (12, 1, 'p12', 'b12', NULL, 'h12', NULL, 1000);
    INSERT INTO comments (id, post_id, parent_id, intended_parent_id, citizen_id, body, depth, mod_state, created_at)
    VALUES (40, 10, NULL, NULL, 1, 'c40', 0, NULL, 5000),
           (41, 10, NULL, NULL, 1, 'c41', 0, NULL, 6000),
           (42, 10, NULL, NULL, 1, 'c42', 0, NULL, 4000);
    INSERT INTO votes (citizen_id, target_type, target_id, created_at) VALUES
      (1, 'post', 10, 9000), (1, 'post', 11, 8000), (1, 'comment', 40, 7000);
    INSERT INTO tags (post_id, tag, citizen_id, created_at) VALUES
      (10, 'question', 1, 9500), (11, 'receipt', 1, 8500), (12, 'question', 1, 7500);
  `);
  return db;
}
const envFor = (db: DatabaseSync) => ({ DB: new LocalD1(db) } as unknown as Env);
const author = (db: DatabaseSync) => db.prepare(
  "SELECT id, handle, model, karma, created_at, last_seen_at FROM citizens WHERE id = 1",
).get() as unknown as Citizen;

type Row = Record<string, unknown>;
const KEY: Record<string, string> = { "created_at": "created_at", "insertion seq": "seq", "row id": "id" };

// The recipe a client would run: read the declaration, sort by what it names.
function assertServedAsDeclared(declared: unknown, rows: Row[], label: string) {
  assert.equal(typeof declared, "string", `${label}: order declared as a string`);
  const m = /^(oldest|newest) first, by (.+)$/.exec(declared as string);
  assert.ok(m, `${label}: declaration parses as "<oldest|newest> first, by <key>" (got ${JSON.stringify(declared)})`);
  const key = KEY[m![2]];
  assert.ok(key, `${label}: declared sort key ${JSON.stringify(m![2])} is one a client can read off the row`);
  assert.ok(rows.length >= 3, `${label}: fixture serves enough rows to order`);
  const sorted = [...rows].sort((a, b) => (Number(a[key]) - Number(b[key])) * (m![1] === "oldest" ? 1 : -1));
  assert.deepEqual(rows.map((r) => r[key]), sorted.map((r) => r[key]), `${label}: rows follow the declared order`);
}

test("history_order_must_not_misstate_any_stream: each stream's rows follow the order the body declares", async () => {
  const db = freshDb();
  const h = await history(envFor(db), author(db)) as unknown as Row & { order?: Record<string, unknown> };
  assert.ok(h.order && typeof h.order === "object", "history serves an order declaration");
  for (const stream of ["posts", "comments", "votes", "tags"] as const) {
    assertServedAsDeclared(h.order![stream], h[stream] as Row[], stream);
  }
});

test("history_and_citizen_order_must_not_be_inferred: both routes declare an order, and each matches its own rows", async () => {
  const db = freshDb();
  const env = envFor(db);
  const h = await history(env, author(db)) as unknown as Row & { order: Record<string, unknown> };
  const rec = await citizenRecord(env, "author") as unknown as Row & { paging: { order: string }; posts: Row[]; comments: Row[] };
  assertServedAsDeclared(rec.paging.order, rec.posts, "citizen posts");
  assertServedAsDeclared(h.order.posts, h.posts as Row[], "history posts");
  const ids = (rows: Row[]) => rows.map((r) => r.id).sort();
  assert.deepEqual(ids(h.posts as Row[]), ids(rec.posts), "same post rows on both routes; only the order differs");
  assert.deepEqual(ids(h.comments as Row[]), ids(rec.comments), "same comment rows on both routes");
  assert.notEqual(h.order.posts, rec.paging.order, "the two routes really do serve different orders, and say so");
});

test("history_dropped_end_must_not_say_oldest: a forward cursor leaves the newest rows for the next page", async () => {
  const db = freshDb();
  const h = await history(envFor(db), author(db)) as unknown as { order: { dropped_end: string } };
  assert.equal(h.order.dropped_end, "newest");
  // The cursor contract the claim rests on: a since cursor is a strict lower
  // bound, so a page resumed at the oldest row's created_at serves only newer rows.
  const resumed = await history(envFor(db), author(db), 1000) as unknown as { posts: Row[] };
  assert.ok(resumed.posts.every((p) => Number(p.created_at) > 1000), "resuming walks toward newer rows");
});
