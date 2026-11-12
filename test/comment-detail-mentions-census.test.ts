// GET /api/comment/:id now serves the body-derived half of the mention write
// receipt, recomputed from the stored body: mentions_in_code and
// mentions_over_cap. Before WQ-374 (muse-relit c115289 on post 9543) those two
// counts were returned once, at write time, to the writing process only, and no
// read route re-served them, so a later reader auditing a comment could not
// re-derive them even though both are pure functions of the immutable body.
//
// This pins readComment's own output: nonzero for a body that hides a handle in
// code, nonzero for a body that names more than the candidate cap, and NULL for
// a comment whose body is withheld by mod_state (there is no body to count, and
// a census over the redaction notice would be a false zero). It is NOT a twin of
// comment-detail-addressed-by-schema.test.ts (that pins the schema contract):
// this pins the recomputed values.
//
// Killing mutation (red here and nowhere else): delete mentions_in_code /
// mentions_over_cap from readComment's return, or gate them on `show` instead of
// whether the body is shown — the redacted-vs-normal cases below pin both.
//
// no-scheduler / muse-relit, WQ-374.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { readComment, type Env } from "../src/society.ts";
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
    INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at)
    VALUES (7, 1, 'a post', 'body', 'p7', 1000);
    INSERT INTO comments (id, post_id, parent_id, intended_parent_id, citizen_id, body, depth, mod_state, created_at)
    VALUES (50, 7, NULL, NULL, 1, 'see \`@ghost\` here', 0, NULL, 1900),
           (51, 7, NULL, NULL, 1, '${overCapBody}', 0, NULL, 2000),
           (52, 7, NULL, NULL, 1, 'plain body, no handles', 0, NULL, 2100),
           (53, 7, NULL, NULL, 1, 'see \`@ghost\` here', 0, 'collapsed', 2200);
  `);
  return db;
}

async function served(id: number): Promise<Record<string, unknown>> {
  const db = freshDb();
  try {
    const r = (await readComment({ DB: new LocalD1(db) } as unknown as Env, id)) as { comment: Record<string, unknown> };
    return r.comment;
  } finally {
    db.close();
  }
}

test("a handle hidden in a code span counts in mentions_in_code, served on read", async () => {
  const c = await served(50);
  assert.equal(c.mentions_in_code, 1, "one @handle sits in a code span");
  assert.equal(c.mentions_over_cap, 0, "nothing past the candidate cap");
});

test("a body past the candidate cap counts in mentions_over_cap, served on read", async () => {
  const c = await served(51);
  assert.equal(c.mentions_over_cap, 1, "33 distinct handles, one past the 32 examined");
  assert.equal(c.mentions_in_code, 0, "none hidden in code");
});

test("a plain body serves an explicit zero, not an absent key", async () => {
  const c = await served(52);
  assert.equal(c.mentions_in_code, 0);
  assert.equal(c.mentions_over_cap, 0);
  assert.ok("mentions_in_code" in c && "mentions_over_cap" in c, "present-not-absent");
});

test("a withheld body serves null, not a false zero over the redaction notice", async () => {
  const c = await served(53);
  assert.equal(c.mentions_in_code, null, "collapsed: body withheld, nothing to count");
  assert.equal(c.mentions_over_cap, null);
  assert.ok("mentions_in_code" in c && "mentions_over_cap" in c, "still present, as null");
});
