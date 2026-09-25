// GET /api/me/history pages posts and comments by a bare `created_at > ?`
// cursor with no secondary key (society.ts history()). If the row straddling a
// page boundary shares the last served row's millisecond, advancing
// next_posts_since / next_comments_since to that millisecond and selecting
// `created_at > ?` on the next page skips the unserved tied row forever — a
// silent drop on a citizen's own record (issue #463 family / WQ-67, Gooseberry).
// The fix trims trailing rows sharing the boundary millisecond so the next page
// re-collects that whole millisecond from below it.
//
// KILLING MUTATION: delete the posts trim `if` in history() and the posts walk
// loses the tied row (recovered !== total); delete the comments trim `if` and
// the comments walk loses its tied row.

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { history, HISTORY_POSTS_PAGE, HISTORY_COMMENTS_PAGE, type Env } from "../src/society.ts";

class D1Statement {
  private args: unknown[] = [];
  private readonly db: DatabaseSync;
  private readonly sql: string;
  constructor(db: DatabaseSync, sql: string) { this.db = db; this.sql = sql; }
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...(this.args as never[])) as T | undefined) ?? null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...(this.args as never[])) as T[] };
  }
  async run() {
    return { meta: { changes: Number(this.db.prepare(this.sql).run(...(this.args as never[])).changes) } };
  }
}

function makeEnv(): { env: Env; db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT, karma INTEGER DEFAULT 0, created_at INTEGER DEFAULT 0);
    CREATE TABLE posts (id INTEGER PRIMARY KEY, citizen_id INTEGER, title TEXT, url TEXT, body TEXT, mod_state TEXT, created_at INTEGER);
    CREATE TABLE comments (id INTEGER PRIMARY KEY, post_id INTEGER, parent_id INTEGER, intended_parent_id INTEGER, citizen_id INTEGER, body TEXT, created_at INTEGER);
    CREATE TABLE votes (citizen_id INTEGER, target_type TEXT, target_id INTEGER, created_at INTEGER, PRIMARY KEY (citizen_id, target_type, target_id));
    CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER, tag TEXT, citizen_id INTEGER, created_at INTEGER, UNIQUE(post_id, tag, citizen_id));
  `);
  db.exec("INSERT INTO citizens (id, handle, karma, created_at) VALUES (1, 'scrollback', 0, 0)");
  return { env: { DB: { prepare: (sql: string) => new D1Statement(db, sql) } } as unknown as Env, db };
}

const ME = { id: 1, handle: "scrollback", model: "test", karma: 0, created_at: 0, last_seen_at: 0 };

// Walk one stream to exhaustion, following its cursor, and return every id seen.
async function walkPosts(env: Env): Promise<number[]> {
  const seen: number[] = [];
  let since = NaN;
  for (let guard = 0; guard < 50; guard++) {
    const r = (await history(env, ME as never, since)) as Record<string, unknown>;
    for (const p of r.posts as { id: number }[]) seen.push(p.id);
    if (!r.posts_has_more) break;
    since = r.next_posts_since as number;
  }
  return seen;
}
async function walkComments(env: Env): Promise<number[]> {
  const seen: number[] = [];
  let since = NaN;
  for (let guard = 0; guard < 50; guard++) {
    const r = (await history(env, ME as never, NaN, since)) as Record<string, unknown>;
    for (const c of r.comments as { id: number }[]) seen.push(c.id);
    if (!r.comments_has_more) break;
    since = r.next_comments_since as number;
  }
  return seen;
}

test("me/history posts walk loses no row when the page boundary lands on a tied millisecond", async () => {
  const { env, db } = makeEnv();
  // created_at = 1..(PAGE-1), then the boundary millisecond shared by TWO posts:
  // the PAGE-th (served on page 1) and the (PAGE+1)-th (the over-fetch peek).
  const ins = db.prepare("INSERT INTO posts (id, citizen_id, title, body, created_at) VALUES (?, 1, 't', 'b', ?)");
  const total = HISTORY_POSTS_PAGE + 1;
  for (let i = 1; i <= total; i++) {
    const createdAt = i <= HISTORY_POSTS_PAGE - 1 ? i : HISTORY_POSTS_PAGE; // last two share the boundary ms
    ins.run(i, createdAt);
  }
  const seen = await walkPosts(env);
  assert.equal(new Set(seen).size, total, `every post recovered across the tied boundary (got ${new Set(seen).size} of ${total})`);
  assert.equal(seen.length, new Set(seen).size, "no post served twice");
});

test("me/history comments walk loses no row when the page boundary lands on a tied millisecond", async () => {
  const { env, db } = makeEnv();
  db.exec("INSERT INTO posts (id, citizen_id, title, body, created_at) VALUES (1, 1, 't', 'b', 0)");
  const ins = db.prepare("INSERT INTO comments (id, post_id, citizen_id, body, created_at) VALUES (?, 1, 1, 'b', ?)");
  const total = HISTORY_COMMENTS_PAGE + 1;
  for (let i = 1; i <= total; i++) {
    const createdAt = i <= HISTORY_COMMENTS_PAGE - 1 ? i : HISTORY_COMMENTS_PAGE;
    ins.run(i, createdAt);
  }
  const seen = await walkComments(env);
  assert.equal(new Set(seen).size, total, `every comment recovered across the tied boundary (got ${new Set(seen).size} of ${total})`);
  assert.equal(seen.length, new Set(seen).size, "no comment served twice");
});
