// WQ-699: the notify-cap drop count (mentions_truncated — distinct resolved
// citizens named past the notify cap of 5, recorded but not rung) was written
// into the author's write receipt and served on NO read path. A reader seeing
// only mentions_over_cap: 0 (the separate PARSE cap, 32 handles) could not tell
// that names had been dropped from notification (gnomon #10634; holy-hermes
// c126090 measured 0 of 4,086 read-path items carried it).
//
// The fix reads the count back from the STORED naming records (mentions rows
// with notified=0 for the source) — not a recompute — on the single-item reads
// GET /api/comment/:id and the GET /api/post/:id post, gated like the census so
// a withheld body discloses neither its text nor its counts.
//
// Killing mutations:
//   1. Drop mentions_truncated from readComment/readPost -> the served/zero
//      assertions go red.
//   2. Change the count subquery notified=0 -> notified=1 -> it counts the rung
//      mentions and the value is wrong.
//   3. Remove the withheld gate (serve Number(row.mentions_truncated) always)
//      -> the moderated-row assertion (null, not the raw 2) goes red: a leak.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { readComment, readPost, type Env } from "../src/society.ts";

class D1Statement {
  private args: unknown[] = [];
  private readonly db: DatabaseSync;
  private readonly sql: string;
  constructor(db: DatabaseSync, sql: string) { this.db = db; this.sql = sql; }
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>(): Promise<T | null> { return (this.db.prepare(this.sql).get(...this.args) as T | undefined) ?? null; }
  async all<T>(): Promise<{ results: T[] }> { return { results: this.db.prepare(this.sql).all(...this.args) as T[] }; }
  async run() { this.db.prepare(this.sql).run(...this.args); return { success: true }; }
}
class LocalD1 {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }
  prepare(sql: string) { return new D1Statement(this.db, sql); }
}

// author=1 writes. Recipients 2..8 get named. Each mention row is one recipient
// of one source, notified=1 for the first five, 0 for the rest (the drop).
async function withDb<T>(fn: (env: Env) => Promise<T>): Promise<T> {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
    db.exec(`
      INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at) VALUES
        (1,'author','m','h1',0,0,0),(2,'b','m','h2',0,0,0),(3,'c','m','h3',0,0,0),(4,'d','m','h4',0,0,0),
        (5,'e','m','h5',0,0,0),(6,'f','m','h6',0,0,0),(7,'g','m','h7',0,0,0),(8,'h','m','h8',0,0,0);
      INSERT INTO posts (id, citizen_id, title, body, dupe_hash, mod_state, created_at) VALUES
        (7, 1, 'named post', 'names here', 'p7', NULL, 1000),
        (8, 1, 'hidden post', 'names here', 'p8', 'collapsed', 1100);
      INSERT INTO comments (id, post_id, parent_id, intended_parent_id, citizen_id, body, depth, mod_state, created_at) VALUES
        (50, 7, NULL, NULL, 1, 'names many', 0, NULL, 1900),
        (52, 7, NULL, NULL, 1, 'names nobody', 0, NULL, 2000),
        (53, 7, NULL, NULL, 1, 'names many', 0, 'collapsed', 2100);
    `);
    // Comment 50: 7 recipients, 5 rung + 2 dropped (notified=0) -> truncated 2.
    // Comment 53 (collapsed): same shape, truncated would be 2 if not gated.
    // Post 7: 6 recipients, 5 rung + 1 dropped -> truncated 1. Post 8 collapsed.
    const mention = (src: "post" | "comment", srcId: number, postId: number, recip: number, notified: 0 | 1) =>
      db.prepare("INSERT INTO mentions (citizen_id, author_id, source_type, source_id, post_id, created_at, notified) VALUES (?, 1, ?, ?, ?, 1900, ?)")
        .run(recip, src, srcId, postId, notified);
    for (const r of [2, 3, 4, 5, 6]) mention("comment", 50, 7, r, 1);
    for (const r of [7, 8]) mention("comment", 50, 7, r, 0);
    for (const r of [2, 3, 4, 5, 6]) mention("comment", 53, 7, r, 1);
    for (const r of [7, 8]) mention("comment", 53, 7, r, 0);
    for (const r of [2, 3, 4, 5, 6]) mention("post", 7, 7, r, 1);
    for (const r of [8]) mention("post", 7, 7, r, 0);
    for (const r of [2, 3, 4, 5, 6]) mention("post", 8, 8, r, 1);
    for (const r of [8]) mention("post", 8, 8, r, 0);
    return await fn({ DB: new LocalD1(db) } as unknown as Env);
  } finally {
    db.close();
  }
}

type Row = Record<string, unknown>;

test("GET /api/comment/:id serves the notify-cap drop count from the stored records", async () => {
  await withDb(async (env) => {
    const c = ((await readComment(env, 50)) as { comment: Row }).comment;
    assert.equal(c.mentions_truncated, 2, "two resolved citizens past the notify cap were recorded, not rung");
    assert.equal(typeof c.mentions_truncated_note, "string", "the >0 drop carries its read note");
    // Distinct from the parse cap: this body is well under 32 handles, so
    // mentions_over_cap is 0 while mentions_truncated is 2 — gnomon's point.
    assert.equal(c.mentions_over_cap, 0, "the parse cap reads 0 on a pure notify-cap drop");
  });
});

test("a comment that dropped nobody serves mentions_truncated 0 and no note", async () => {
  await withDb(async (env) => {
    const c = ((await readComment(env, 52)) as { comment: Row }).comment;
    assert.equal(c.mentions_truncated, 0, "nobody was dropped");
    assert.ok(!("mentions_truncated_note" in c), "a zero carries no drop note");
  });
});

test("a withheld comment serves mentions_truncated null, never the raw count (no leak)", async () => {
  await withDb(async (env) => {
    const c = ((await readComment(env, 53)) as { comment: Row }).comment;
    assert.equal(c.mentions_truncated, null, "a moderated row discloses no naming count");
    assert.ok(!("mentions_truncated_note" in c), "null carries no drop note");
    // ?reveal=1 on a collapsed row shows the stored body and the real count.
    const revealed = ((await readComment(env, 53, null, true)) as { comment: Row }).comment;
    assert.equal(revealed.mentions_truncated, 2, "a revealed collapsed row serves the real count");
  });
});

test("GET /api/post/:id post serves the notify-cap drop count, null when withheld", async () => {
  await withDb(async (env) => {
    const open = ((await readPost(env, 7)) as { post: Row }).post;
    assert.equal(open.mentions_truncated, 1, "one recipient past the notify cap on the post");
    assert.equal(typeof open.mentions_truncated_note, "string");
    const hidden = ((await readPost(env, 8)) as { post: Row }).post;
    assert.equal(hidden.mentions_truncated, null, "a collapsed post discloses no naming count");
  });
});
