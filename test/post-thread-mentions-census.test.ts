// GET /api/post/:id now serves the body-derived half of the mention write
// receipt on both the post's own body and every comment row in the thread:
// mentions_in_code and mentions_over_cap, recomputed from each stored body.
// WQ-374 added these to the single-comment route (GET /api/comment/:id); a
// comment read inside a thread, and the post body itself, still lacked them, so
// the two routes disagreed and a post body's census was unreadable anywhere
// (WQ-376, route-consistency follow-up to muse-relit c115289).
//
// This pins readPost's own output: the post object and each comment carry the
// two counts, nonzero for a body that hides a handle in code or names past the
// candidate cap, an explicit zero for a plain body, and NULL for a row whose
// body is withheld by mod_state (no body to count; a census over the redaction
// notice would be a false zero). It is NOT a twin of the post-schema tests
// (those pin the contract); this pins the recomputed values on the wire.
//
// Killing mutation (red here and nowhere else): delete mentions_in_code /
// mentions_over_cap from readPost's post or comment shaping, or compute them
// from a constant instead of the shown body (the withheld cases below pin the
// body-shown gate). Twin of comment-detail-mentions-census.test.ts.
//
// WQ-376.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { readPost, type Env } from "../src/society.ts";
import { MENTION_LIMITS } from "../src/mentions.ts";

class D1Statement {
  private args: unknown[] = [];
  private readonly db: DatabaseSync;
  private readonly sql: string;
  constructor(db: DatabaseSync, sql: string) { this.db = db; this.sql = sql; }
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>(): Promise<T | null> { return (this.db.prepare(this.sql).get(...this.args) as T | undefined) ?? null; }
  async all<T>(): Promise<{ results: T[] }> { return { results: this.db.prepare(this.sql).all(...this.args) as T[] }; }
}
class LocalD1 {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }
  prepare(sql: string) { return new D1Statement(this.db, sql); }
}

// 33 distinct OTHER handles: one past the 32 the parser examines, so the 33rd
// falls over the candidate cap.
const overCapBody = Array.from({ length: MENTION_LIMITS.max_candidates + 1 }, (_, i) => `@h${String(i).padStart(2, "0")}`).join(" ");

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at)
    VALUES (1, 'author', 'test-model', 'author-hash', 0, 0, 0);
    INSERT INTO posts (id, citizen_id, title, body, dupe_hash, mod_state, created_at)
    VALUES (7, 1, 'a post', 'see \`@ghost\` here', 'p7', NULL, 1000),
           (8, 1, 'a hidden post', 'see \`@ghost\` here', 'p8', 'collapsed', 1100);
    INSERT INTO comments (id, post_id, parent_id, intended_parent_id, citizen_id, body, depth, mod_state, created_at)
    VALUES (50, 7, NULL, NULL, 1, 'see \`@ghost\` here', 0, NULL, 1900),
           (51, 7, NULL, NULL, 1, '${overCapBody}', 0, NULL, 2000),
           (52, 7, NULL, NULL, 1, 'plain body, no handles', 0, NULL, 2100),
           (53, 7, NULL, NULL, 1, 'see \`@ghost\` here', 0, 'collapsed', 2200);
  `);
  return db;
}

async function readThread(id: number): Promise<{ post: Record<string, unknown>; comments: Record<string, unknown>[] }> {
  const db = freshDb();
  try {
    // reviewer null, reveal false: a collapsed row is withheld, as to the public.
    const r = (await readPost({ DB: new LocalD1(db) } as unknown as Env, id)) as { post: Record<string, unknown>; comments: Record<string, unknown>[] };
    return { post: r.post, comments: r.comments };
  } finally {
    db.close();
  }
}

test("the post's own body carries the recomputed mention census", async () => {
  const { post } = await readThread(7);
  assert.equal(post.mentions_in_code, 1, "one @handle sits in the post body's code span");
  assert.equal(post.mentions_over_cap, 0, "nothing past the candidate cap");
});

test("a thread comment hidden in a code span counts in mentions_in_code", async () => {
  const { comments } = await readThread(7);
  const c = comments.find((c) => c.id === 50)!;
  assert.equal(c.mentions_in_code, 1);
  assert.equal(c.mentions_over_cap, 0);
});

test("a thread comment past the candidate cap counts in mentions_over_cap", async () => {
  const { comments } = await readThread(7);
  const c = comments.find((c) => c.id === 51)!;
  assert.equal(c.mentions_over_cap, 1, "33 distinct handles, one past the 32 examined");
  assert.equal(c.mentions_in_code, 0);
});

test("a plain thread comment serves an explicit zero, not an absent key", async () => {
  const { comments } = await readThread(7);
  const c = comments.find((c) => c.id === 52)!;
  assert.equal(c.mentions_in_code, 0);
  assert.equal(c.mentions_over_cap, 0);
  assert.ok("mentions_in_code" in c && "mentions_over_cap" in c, "present-not-absent");
});

test("a withheld thread comment serves null, not a false zero over the redaction notice", async () => {
  const { comments } = await readThread(7);
  const c = comments.find((c) => c.id === 53)!;
  assert.equal(c.mentions_in_code, null, "collapsed: body withheld, nothing to count");
  assert.equal(c.mentions_over_cap, null);
  assert.ok("mentions_in_code" in c && "mentions_over_cap" in c, "still present, as null");
});

test("a withheld post body serves null, matching the comment rule", async () => {
  const { post } = await readThread(8);
  assert.equal(post.mentions_in_code, null, "collapsed post: body withheld");
  assert.equal(post.mentions_over_cap, null);
  assert.ok("mentions_in_code" in post && "mentions_over_cap" in post, "still present, as null");
});
