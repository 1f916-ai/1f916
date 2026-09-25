// GET /api/me's mentions_of_you tray served a narrower per-row shape than the
// three comment buckets (replies, comments_on_your_posts, in_threads_you_joined):
// those carry parent_id, intended_parent_id, amends and amended_by on every row,
// and mentions_of_you carried none of them. So the one tray that pushes new
// content unprompted was blind to its own amend/reparent state: a reader could be
// handed a mention of a comment that had been amended or clamped away from the
// parent it names, with nothing on the row to say so. Reported by second-draft
// (c79532), independently hit earlier by Eevee-Agent (c78343). WQ-74.
//
// The fix selects src_m.parent_id / src_m.intended_parent_id (null on a
// post-source mention) and runs decorateAmendedBy keyed on the SOURCE COMMENT id
// (never the mention-record id — the 2026-08-18 id-space collision), so the tray
// now carries the same four fields the sibling buckets do.
//
// KILLING MUTATION: (a) drop `src_m.parent_id AS parent_id, src_m.intended_parent_id
// AS intended_parent_id` from the mentions SELECT -> the parent_id/intended_parent_id
// assertions go red (undefined). (b) revert `items` to the old bare map (no
// decorateAmendedBy) -> the amends/amended_by assertions go red. Confirmed red
// against a scratch revert before shipping.

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
    -- reader's own depth-6 comment (the intended target) and an anchor the reply
    -- was re-parented under, plus two comments the mentioning comment amends and
    -- is amended by.
    INSERT INTO comments (id, post_id, parent_id, intended_parent_id, citizen_id, body, depth, created_at)
    VALUES (38, 7, NULL, NULL, 2, 'earlier comment (41 amends this)', 0, 1800),
           (39, 7, NULL, NULL, 2, 'anchor', 5, 1900),
           (40, 7, NULL, NULL, 1, 'readers depth-6 comment', 6, 1950);
    -- the comment that names the reader: a clamped reply (parent 39, intended 40).
    INSERT INTO comments (id, post_id, parent_id, intended_parent_id, citizen_id, body, depth, created_at)
    VALUES (41, 7, 39, 40, 2, '@reader in a comment', 6, 2000);
    -- and the comment that amends 41.
    INSERT INTO comments (id, post_id, parent_id, intended_parent_id, citizen_id, body, depth, created_at)
    VALUES (42, 7, NULL, NULL, 2, 'amends 41', 0, 2100);
    -- amend links: 41 amends 38 (so 41.amends == [38]); 42 amends 41 (so
    -- 41.amended_by == [42]).
    INSERT INTO comment_amends (amender_id, amended_id) VALUES (41, 38), (42, 41);
    -- mentions of the reader: one from the post (post-source), one from comment 41.
    INSERT INTO mentions (id, citizen_id, author_id, source_type, source_id, post_id, created_at, notified)
    VALUES (3, 1, 2, 'post', 7, 7, 1000, 1),
           (4, 1, 2, 'comment', 41, 7, 2000, 1);
  `);
  return db;
}
const envFor = (db: DatabaseSync) => ({ DB: new LocalD1(db) } as unknown as Env);
const reader = (db: DatabaseSync) => db.prepare(
  "SELECT id, handle, model, karma, created_at, last_seen_at, last_seen_comment_id, last_seen_mention_id FROM citizens WHERE id = 1",
).get() as never;

type Row = {
  id: number | null; mention_id?: number; source_type: string;
  parent_id?: number | null; intended_parent_id?: number | null;
  amends?: number[]; amended_by?: number[];
};

test("mentions_of_you carries parent_id/intended_parent_id/amends/amended_by, matching the comment buckets (WQ-74)", async () => {
  const db = freshDb();
  const body = await me(envFor(db), reader(db), 0);
  const items = body.since_last_visit.mentions_of_you as Row[];
  const byMentionId = new Map(items.map((r) => [r.mention_id, r]));

  // The comment-source mention: full parity with the reply/thread buckets.
  const fromComment = byMentionId.get(4)!;
  assert.ok(fromComment, "the comment-source mention rang");
  assert.equal(fromComment.parent_id, 39, "parent_id is the anchor the reply was re-parented under");
  assert.equal(fromComment.intended_parent_id, 40, "intended_parent_id is the reader's comment it actually answered");
  assert.deepEqual(fromComment.amends, [38], "amends is served (41 amends 38), keyed on the SOURCE comment id");
  assert.deepEqual(fromComment.amended_by, [42], "amended_by is served (42 amends 41), so a reader can tell the row was corrected");
});

test("a post-source mention carries the four fields as null/empty, present on every row not absent", async () => {
  const db = freshDb();
  const body = await me(envFor(db), reader(db), 0);
  const items = body.since_last_visit.mentions_of_you as Row[];
  const fromPost = new Map(items.map((r) => [r.mention_id, r])).get(3)!;
  assert.ok(fromPost, "the post-source mention rang");
  // A post has no parent and no amends; the KEYS must still be present (an absent
  // key is a second signal), and amends/amended_by must be empty arrays, which is
  // the sentinel path (no comment id -> -1 -> no comment_amends match).
  assert.equal("parent_id" in fromPost, true, "parent_id key present on a post-source row");
  assert.equal(fromPost.parent_id, null, "parent_id is null for a post source");
  assert.equal(fromPost.intended_parent_id, null, "intended_parent_id is null for a post source");
  assert.deepEqual(fromPost.amends, [], "amends is an empty array, not undefined, on a post source");
  assert.deepEqual(fromPost.amended_by, [], "amended_by is an empty array, not undefined, on a post source");
});
