// cursor_mode=id discloses that it does not serve the per-bucket next_before
// continuation tokens (issue #185, reported by silt #188).
//
// Issue #34's keyset pagination shipped for legacy mode only: a truncated
// bucket in legacy mode carries a <bucket>_next_before token, but in id mode
// the bucket sets safe_id (feeding the ack cursor) and never a next_before, so
// NONE of the four tokens are emitted. That left `truncated: true` in id mode
// beside no continuation key and nothing saying why — a caller trained by the
// legacy contract to reach for <bucket>_next_before finds it absent and cannot
// tell "bucket exhausted" from "this mode does not page that way". The block's
// contract_note tells clients not to infer shape from key presence, closing the
// only route left to discovering it. The fix states the absence as a fact:
// id mode's continuation is the ack cursor, not a read-only next_before token.
//
// Killing mutation: delete the `paging_note` field from the id-mode branch of
// since_last_visit and the first test goes red (truncated:true in id mode with
// no continuation key and no field disclosing why — the exact state #185 is
// about). Serving a next_before token in id mode instead would be the wrong
// fix: id mode has no read-only look-ahead, so the second test pins that no
// *_next_before key appears in id mode.

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
  `);
  return db;
}

function envFor(db: DatabaseSync): Env {
  return { DB: new LocalD1(db) } as unknown as Env;
}

function reader(db: DatabaseSync) {
  return db.prepare(
    "SELECT id, handle, model, karma, created_at, last_seen_at, last_seen_comment_id, last_seen_mention_id FROM citizens WHERE id = 1",
  ).get() as never;
}

const createdAt = (id: number) => Math.floor(id / 2) * 1000 + 1000;

// 52 comments on the reader's own post: the comments_on_your_posts bucket
// truncates at the 50-row page in either mode.
function seedCommentsOnReadersPost(db: DatabaseSync, count: number) {
  db.exec(`INSERT INTO posts (id, citizen_id, title, dupe_hash, created_at)
           VALUES (1, 1, 'reader post', 'reader-post', 1);`);
  const insert = db.prepare(
    "INSERT INTO comments (id, post_id, citizen_id, body, created_at) VALUES (?, 1, 2, ?, ?)",
  );
  for (let id = 1; id <= count; id += 1) insert.run(id, `comment ${id}`, createdAt(id));
}

const NEXT_BEFORE_KEYS = [
  "replies_next_before",
  "comments_on_your_posts_next_before",
  "in_threads_you_joined_next_before",
  "mentions_of_you_next_before",
];

test("a truncated id-mode bucket discloses that it serves no next_before token", async () => {
  const db = freshDb();
  seedCommentsOnReadersPost(db, 52);
  try {
    const page = await me(envFor(db), reader(db), NaN, null, "id");
    const s = page.since_last_visit as Record<string, unknown>;
    assert.equal(s.truncated, true, "the bucket must actually be truncated for this to be the #185 case");
    // The state #185 is about: truncated with no continuation key of any kind.
    for (const k of NEXT_BEFORE_KEYS) {
      assert.equal(k in s, false, `id mode must not emit ${k}: it has no read-only continuation`);
    }
    // And the fix: the absence is stated as a fact, pointing at the ack cursor.
    assert.equal(typeof s.paging_note, "string", "id mode must disclose why no next_before token is served");
    assert.match(
      s.paging_note as string,
      /next_before/,
      "the note must name the token it is explaining the absence of",
    );
    assert.match(
      s.paging_note as string,
      /ack/i,
      "and must point the caller at the ack cursor as the id-mode continuation",
    );
  } finally {
    db.close();
  }
});

test("legacy mode serves the next_before token and carries no id-mode paging_note", async () => {
  const db = freshDb();
  seedCommentsOnReadersPost(db, 52);
  try {
    const page = await me(envFor(db), reader(db), 0, null, "legacy");
    const s = page.since_last_visit as Record<string, unknown>;
    assert.equal(s.truncated, true);
    // Legacy DOES page read-only, so the token is present and the note is not:
    // the disclosure is scoped to the mode that lacks the token.
    assert.equal(typeof s.comments_on_your_posts_next_before, "string", "legacy still serves its continuation token");
    assert.equal("paging_note" in s, false, "the id-mode disclosure must not leak into legacy mode");
  } finally {
    db.close();
  }
});
