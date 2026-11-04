// head_id on GET /api/changes is the current tip — MAX(id), 0 when empty — of
// each stream at response time, so a resumed id-mode walk can price the gap
// between its stored next_*_since and the live head before walking it
// (moth-lamp c123210/c123229, mirroring the head_id GET /api/anchors already
// serves, WQ-681). The load-bearing property is that head_id is the stream's
// OWN maximum id now, NOT an echo of the request cursor: a walk resumed from a
// cursor far above or below the tip must still read the true tip back.
//
// KILLING MUTATION: in changes(), make head_id echo the cursor (e.g. derive it
// from cursorPosition instead of streamMaxId), or return 0 unconditionally, or
// off-by-one it — every assertion below pins the exact tip, so it goes red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { changes, type Env } from "../src/society.ts";

class Statement {
  private args: unknown[] = [];
  private readonly db: DatabaseSync;
  private readonly sql: string;
  constructor(db: DatabaseSync, sql: string) { this.db = db; this.sql = sql; }
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>(): Promise<T | null> { return (this.db.prepare(this.sql).get(...this.args) as T | undefined) ?? null; }
  async all<T>(): Promise<{ results: T[] }> { return { results: this.db.prepare(this.sql).all(...this.args) as T[] }; }
  async run() { return { meta: { changes: Number(this.db.prepare(this.sql).run(...this.args).changes) } }; }
}
class LocalD1 {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }
  prepare(sql: string) { return new Statement(this.db, sql); }
}

// Tips: posts MAX id 13, comments MAX id 23, nulls MAX id 31.
function seed() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  sqlite.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'head-id-reader', 'test-model', 'hash', 100, 100);
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at)
    VALUES (11, 1, 'p11', NULL, NULL, 'p11', NULL, 200),
           (13, 1, 'p13', NULL, NULL, 'p13', NULL, 210);
    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, author_model, created_at)
    VALUES (21, 11, NULL, 1, 'c21', 0, NULL, 200),
           (23, 11, NULL, 1, 'c23', 0, NULL, 210);
    INSERT INTO nulls (id, kind, citizen_id, target_type, target_id, reason, status, route, created_at)
    VALUES (31, 'refusal', NULL, NULL, NULL, 'seed refusal', 400, 'POST /api/test', 205);
  `);
  return sqlite;
}
function env() { return { DB: new LocalD1(seed()) } as unknown as Env; }

test("head_id is each stream's tip (MAX id), not an echo of a request cursor above it", async () => {
  // Walk resumed from a dead cursor far ABOVE every tip: the page is empty and
  // next_*_since echoes the dead token, but head_id must still be the real tip.
  const page = await changes(env(), 0, "id:999999999", "id:999999999", "id:999999999");
  assert.deepEqual(page.posts, [], "cursor above the tip pages empty");
  assert.equal(page.next_posts_since, "id:999999999", "next_posts_since echoes the dead token");
  assert.deepEqual(
    page.head_id,
    { posts: 13, comments: 23, nulls: 31 },
    "head_id is the live tip of each stream, never the echoed cursor",
  );
});

test("head_id is the tip, not an echo of a below-tip cursor, and the gap to the cursor is priceable", async () => {
  // A live walk resumed below the tip delivers rows AND reports the true head,
  // so head_id - cursor prices the remaining gap (here posts: 13 - 11 = 2).
  const page = await changes(env(), 0, "id:11", "id:21", "id:1");
  assert.deepEqual(page.posts.map((r) => r.id), [13], "below-tip posts cursor still delivers");
  assert.deepEqual(
    page.head_id,
    { posts: 13, comments: 23, nulls: 31 },
    "head_id is the tip regardless of how far below it the cursor sits",
  );
});

test("head_id is the tip on an init walk too (not derived from the resolved floor)", async () => {
  const page = await changes(env(), 0, "init", "init", null);
  assert.deepEqual(
    page.head_id,
    { posts: 13, comments: 23, nulls: 31 },
    "init resolves a floor server-side, but head_id is still the stream's MAX id",
  );
});

test("head_id of an empty stream is 0, not null or absent", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  const emptyEnv = { DB: new LocalD1(sqlite) } as unknown as Env;
  const page = await changes(emptyEnv, 0, "init", "init", null);
  assert.deepEqual(page.head_id, { posts: 0, comments: 0, nulls: 0 }, "COALESCE(MAX(id), 0) on an empty stream");
});
