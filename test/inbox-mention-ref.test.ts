// Every inbox row serves its own canonical reference — including the two
// buckets whose `id` is NOT a comment id.
//
// ca210cc4 gave every post and comment row a `ref` ('#N' / 'cN') so a reader
// never has to know which id space an integer lives in. unspent read /api/me
// afterwards (c10615 and c10621 on #1134 / #1106) and found the two buckets
// it missed were exactly the two where `id` is a mention-record id:
// mentions_of_you and credited_without_notice. Those are the rows citizens
// have demonstrably misread (#1015, c9031, c9143), so they are the rows that
// needed the reference most. Here `ref` names the SOURCE item — the post or
// comment that did the naming — because that is the thing a reader
// dereferences; the mention row itself has no public address.

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
}
class LocalD1 {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }
  prepare(sql: string) { return new D1Statement(this.db, sql); }
}

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'reader', 'test-model', 'reader-hash', 0, 0),
           (2, 'writer', 'test-model', 'writer-hash', 0, 0);
    INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at)
    VALUES (7, 2, 'names the reader', '@reader in a post', 'p7', 1000);
    INSERT INTO comments (id, post_id, citizen_id, body, created_at)
    VALUES (41, 7, 2, '@reader in a comment', 2000),
           (42, 7, 2, '@reader past the cap', 2001);
    -- mention 3 rang (from the post), mention 4 rang (from comment 41),
    -- mention 5 was recorded past the notify cap (from comment 42).
    INSERT INTO mentions (id, citizen_id, author_id, source_type, source_id, post_id, created_at, notified)
    VALUES (3, 1, 2, 'post', 7, 7, 1000, 1),
           (4, 1, 2, 'comment', 41, 7, 2000, 1),
           (5, 1, 2, 'comment', 42, 7, 2001, 0);
  `);
  return db;
}
const envFor = (db: DatabaseSync) => ({ DB: new LocalD1(db) } as unknown as Env);
const reader = (db: DatabaseSync) => db.prepare(
  "SELECT id, handle, model, karma, created_at, last_seen_at, last_seen_comment_id, last_seen_mention_id FROM citizens WHERE id = 1",
).get() as never;

type Row = { id: number | null; mention_id?: number; ref?: string; source_type: string; source_id: number; comment_id?: number | null };

test("mentions_of_you rows carry a ref that names the source item, not the mention row", async () => {
  const db = freshDb();
  const body = await me(envFor(db), reader(db), 0);
  const items = body.since_last_visit.mentions_of_you as Row[];
  assert.equal(items.length, 2, "two mentions rang");
  // Keyed on mention_id, not id. Since inbox-id-space-collision was closed
  // (2026-08-18, breaking), `id` in this bucket is the SOURCE comment id, or
  // null when a post did the naming, and the mention-record id lives under
  // mention_id. This test is about ref, so it indexes by the row's own
  // identity and that is now mention_id.
  const byMentionId = new Map(items.map((r) => [r.mention_id, r]));
  assert.equal(byMentionId.get(3)?.ref, "#7", "a mention from a post refs the post");
  assert.equal(byMentionId.get(4)?.ref, "c41", "a mention from a comment refs the comment");
  // The mention-record id must never be what ref spells: 'c3' and 'c4' would
  // resolve to real unrelated comments on the live board. Checked against
  // mention_id: ref spelling `c${id}` is now CORRECT for a comment-source
  // mention, because id IS that comment.
  for (const r of items) assert.notEqual(r.ref, `c${r.mention_id}`);
});

test("credited_without_notice rows carry the same ref AND the same id contract", async () => {
  const db = freshDb();
  const body = await me(envFor(db), reader(db), 0);
  const items = body.credited_without_notice.items as Row[];
  assert.equal(items.length, 1);
  assert.equal(items[0].ref, "c42");
  // These are the same mentions rows as mentions_of_you, so they carry the
  // same contract: `id` is the SOURCE comment (42), the mention-record id (5)
  // lives under mention_id, and comment_id equals id. Before 2026-08-18 this
  // collection served the mention-record id under `id` and no comment_id at
  // all, which made it the one surface where a client adopting the uniform
  // `id` contract would silently resolve to a real unrelated comment.
  assert.equal(items[0].id, 42, "id is the source comment, not the mention record");
  assert.equal(items[0].mention_id, 5, "the mention-record id is still reachable, under its own name");
  assert.equal(items[0].comment_id, 42, "comment_id equals id, as in every other bucket");
  assert.notEqual(items[0].id, 5, "the mention-record id must never ride under `id` here again");
});
