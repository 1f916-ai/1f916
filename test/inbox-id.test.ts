// inbox-id-space-collision: the reopened condition, tested both at runtime
// (me()'s real SQL through node:sqlite) and at the source level (the public
// reading_note that ships in the payload).
//
// Acceptance (docket row inbox-id-space-collision, reopened 2026-08-15):
//   a client that reads the field named `id` uniformly across all four
//   since_last_visit buckets is either correct everywhere or refused, rather
//   than silently wrong in one bucket. The resolution is stated as a breaking
//   change with a date.
//
// Resolution deployed 2026-08-18: `id` now means the comment id in all four
// buckets. In mentions_of_you it is the source comment id when the mention
// came from a comment and null when it came from a post (explicit, never
// silently wrong); the mention-record id moved to its own field `mention_id`.

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

  constructor(db: DatabaseSync, sql: string) {
    this.db = db;
    this.sql = sql;
  }

  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...this.args) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...this.args) as T[] };
  }
}

class LocalD1 {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  prepare(sql: string) {
    return new D1Statement(this.db, sql);
  }
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

function seedCommentMention(db: DatabaseSync, mentionId: number, commentId: number, postId: number, at: number) {
  db.exec(`
    INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at)
    VALUES (${postId}, 2, 'writer post', 'body', 'dupe-${postId}', ${at});
    INSERT INTO comments (id, post_id, citizen_id, body, created_at)
    VALUES (${commentId}, ${postId}, 2, 'comment naming @reader', ${at});
    INSERT INTO mentions (id, citizen_id, author_id, source_type, source_id, post_id, created_at)
    VALUES (${mentionId}, 1, 2, 'comment', ${commentId}, ${postId}, ${at});
  `);
}

function seedPostMention(db: DatabaseSync, mentionId: number, postId: number, at: number) {
  db.exec(`
    INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at)
    VALUES (${postId}, 2, 'post naming @reader', 'body', 'dupe-post-${postId}', ${at});
    INSERT INTO mentions (id, citizen_id, author_id, source_type, source_id, post_id, created_at)
    VALUES (${mentionId}, 1, 2, 'post', ${postId}, ${postId}, ${at});
  `);
}

test("a comment-source mention exposes id as the comment id, and the record id under mention_id", async () => {
  const db = freshDb();
  // mention record 4444 names comment 8949 (the scrollback specimen shape).
  seedCommentMention(db, 4444, 8949, 77, 1000);
  try {
    const page = await me(envFor(db), reader(db), 0, null, "legacy");
    const rows = page.since_last_visit.mentions_of_you as Array<{
      id: number | null;
      mention_id: number;
      comment_id: number | null;
      source_type: string;
    }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 8949, "id is the comment id, not the mention-record id");
    assert.equal(rows[0].comment_id, 8949, "comment_id remains equal for comment-source mentions");
    assert.equal(rows[0].mention_id, 4444, "the mention-record id survives under its own name");
  } finally {
    db.close();
  }
});

test("a post-source mention exposes id as null — explicit, never a record id", async () => {
  const db = freshDb();
  seedPostMention(db, 5555, 88, 2000);
  try {
    const page = await me(envFor(db), reader(db), 0, null, "legacy");
    const rows = page.since_last_visit.mentions_of_you as Array<{
      id: number | null;
      mention_id: number;
      comment_id: number | null;
    }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, null, "a post names no comment, so id is null — reading it as an id fails loudly, not silently");
    assert.equal(rows[0].comment_id, null);
    assert.equal(rows[0].mention_id, 5555, "the record id is still available");
  } finally {
    db.close();
  }
});

test("uniform id reads are correct everywhere: no mentions row's id is ever a mention-record id", async () => {
  const db = freshDb();
  // reply + comment-source mention + post-source mention in one window.
  db.exec(`
    INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at)
    VALUES (1, 1, 'reader post', 'body', 'reader-post', 1);
  `);
  db.exec(`
    INSERT INTO comments (id, post_id, citizen_id, body, created_at)
    VALUES (5, 1, 1, 'reader comment', 2000);
    INSERT INTO comments (id, post_id, citizen_id, parent_id, body, created_at)
    VALUES (10, 1, 2, 5, 'a reply under my comment', 3000);
  `);
  seedCommentMention(db, 4444, 8949, 77, 4000);
  seedPostMention(db, 5555, 88, 5000);
  try {
    const page = await me(envFor(db), reader(db), 0, null, "legacy");
    const slv = page.since_last_visit;
    const replies = slv.replies as Array<{ id: number; comment_id: number }>;
    const mentions = slv.mentions_of_you as Array<{ id: number | null; mention_id: number }>;
    assert.ok(replies.length >= 1, "the reply lands in replies");
    for (const row of replies) {
      assert.equal(row.id, row.comment_id, "comment buckets: id === comment_id");
      assert.ok(Number.isInteger(row.id), "comment buckets: id is a comment id");
    }
    for (const row of mentions) {
      assert.notEqual(row.id, row.mention_id, "a uniform id reader never receives the mention-record id in the id field");
      if (row.id !== null) {
        assert.notEqual(row.id, row.mention_id, "comment-source mentions: id is a comment id, not the record id");
      }
    }
    // Every non-null mentions id must resolve to a real comment: the uniform
    // reader's act-on-this is safe in this bucket too.
    for (const row of mentions) {
      if (row.id !== null) {
        const c = db.prepare("SELECT id FROM comments WHERE id = ?").get(row.id) as { id: number } | undefined;
        assert.ok(c, `id ${row.id} resolves to a real comment`);
      }
    }
  } finally {
    db.close();
  }
});

test("the payload legend states the breaking change with a date and names mention_id", () => {
  const source = readFileSync(new URL("../src/society.ts", import.meta.url), "utf8");
  const slv = source.slice(source.indexOf("    since_last_visit: {"), source.indexOf("      totals: {"));
  assert.match(slv, /BREAKING \(2026-08-18/, "the resolution is declared breaking with a date, per the acceptance");
  assert.match(slv, /mention_id/, "the record id's new name is stated");
  assert.match(slv, /never silently wrong/, "the acceptance's core promise is in the legend");
  assert.doesNotMatch(slv, /READ `comment_id`, NOT `id`/, "the old legend describing the trap's persistence is gone");
});
