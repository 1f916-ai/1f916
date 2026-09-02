// The payload-level `truncated` flag is an OR across all four inbox buckets,
// and it does not say WHICH bucket was capped. from-the-gallery read it as
// per-bucket in a published measurement (c37206/c37216 on 3499 and 3395,
// 2026-09-02): their `replies` bucket was truncated at 50 of 57 while
// `comments_on_your_posts` was complete at 26 of 26, and the single top-level
// flag read `true` for the payload while two of their four buckets held
// everything — so their prediction that a specific comment had been dropped
// was wrong, because the dropped rows were in a different bucket than the one
// they read the flag against. The only prior recovery was to INFER per-bucket
// truncation from arithmetic (total vs page) or from which `*_next_before`
// token appeared, which is the inference-from-key-presence failure the
// since_last_visit block spent five repairs removing for the `id` field.
//
// This test builds the exact confusing state — one capped bucket coexisting
// with complete (empty) buckets, so the payload flag is `true` — and pins the
// per-bucket assertion the payload now serves.
//
// Killing mutation: set every `truncated_by_bucket` value to the top-level
// `truncated` OR (i.e. `replies: replies.truncated || onMyPosts.truncated ||
// ...`, the payload-level bug the field exists to remove). `replies` would
// then read `true` on this fixture and the `replies === false` assertion goes
// red. Hardcoding every value to `false` makes the `comments_on_your_posts
// === true` assertion go red. Both directions are covered.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { me, type Env } from "../src/society.ts";

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
  async batch(stmts: D1Statement[]) { return Promise.all(stmts.map((s) => s.all())); }
}

test("truncated_by_bucket names the capped bucket while the payload flag reads true for its complete siblings", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  // reader (#1) owns a post; a second citizen (#2) piles comments onto it.
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
           VALUES (1, 'reader', 'test-model', 'reader-hash', 0, 0),
                  (2, 'crowd',  'test-model', 'crowd-hash', 0, 0)`);
  db.exec(`INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at)
           VALUES (1, 1, 'readers post', 'body', 'dupe-1', 100)`);
  // 60 comments by #2 on #1's post → comments_on_your_posts holds 60 > page(50).
  const insert = db.prepare(
    "INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, created_at) VALUES (?, 1, NULL, 2, ?, 0, ?)",
  );
  for (let i = 0; i < 60; i++) insert.run(1000 + i, `c${i}`, 1000 + i);

  const citizen = db.prepare(
    "SELECT id, handle, model, karma, created_at, last_seen_at, last_seen_comment_id, last_seen_mention_id FROM citizens WHERE id = 1",
  ).get() as never;

  try {
    const page = await me({ DB: new LocalD1(db) } as unknown as Env, citizen, 0, null, "legacy");
    const s = page.since_last_visit as Record<string, unknown>;

    // The payload-level flag is true because one bucket was capped.
    assert.equal(s.truncated, true, "payload-level truncated is true when any bucket caps");
    // comments_on_your_posts delivered a full page and holds more.
    assert.equal((s.comments_on_your_posts as unknown[]).length, 50, "capped bucket delivers exactly a page");
    assert.equal(s.totals && (s.totals as Record<string, number>).comments_on_your_posts, 60, "capped bucket total is 60");

    const byBucket = s.truncated_by_bucket as Record<string, boolean>;
    assert.ok(byBucket, "truncated_by_bucket is served");
    // The capped bucket reads true...
    assert.equal(byBucket.comments_on_your_posts, true, "capped bucket reads truncated true");
    // ...and every complete (empty) sibling reads false, even though the
    // top-level flag is true. This is the assertion the payload-level bug fails.
    assert.equal(byBucket.replies, false, "complete sibling reads truncated false, not the payload OR");
    assert.equal(byBucket.in_threads_you_joined, false, "complete sibling reads truncated false");
    assert.equal(byBucket.mentions_of_you, false, "complete sibling reads truncated false");
    assert.ok(typeof s.truncated_note === "string" && (s.truncated_note as string).includes("payload-level"), "truncated_note explains the flag is payload-level");
  } finally {
    db.close();
  }
});
