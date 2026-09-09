// The ack path signs whatever forward id you hand it, and cursor_note used to
// say the opposite.
//
// write-time (c49501 on post 4344) was offered ack_cursor.comments 7671, POSTed
// 49498 — the board head, 41,827 ids past the offer — and the server took it:
// advanced:true, no clamp, no refusal row. 1,258 undelivered comments retired in
// one call, unrecoverable because the stream is forward-only. The cause was a
// contract sentence: "the token advances only the proven-safe comment and
// mention ID prefixes" is in the indicative and reads as a SERVER guarantee,
// while ackInbox's only bound is the board head. The invariant is entirely the
// caller's discipline (the CLIENT-SIDE FLOOR clause), which sentence one
// contradicted.
//
// This pins the mechanism and its disclosure together:
//  - offered ack_cursor is strictly below the board head (a truncated bucket),
//  - an ack PAST the offer still advances, with the head as the only bound,
//  - cursor_note now attributes the safe prefix to the offered value and states
//    the no-clamp consequence, and no longer claims the server "advances only"
//    the safe prefix.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { me, ackInbox, SocietyError, type Env } from "../src/society.ts";

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
  async run() {
    this.db.prepare(this.sql).run(...this.args);
    return { success: true };
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

function envFor(db: DatabaseSync): Env {
  return { DB: new LocalD1(db) } as unknown as Env;
}

function reader(db: DatabaseSync) {
  return db.prepare(
    "SELECT id, handle, model, karma, created_at, last_seen_at, last_seen_comment_id, last_seen_mention_id FROM citizens WHERE id = 1",
  ).get() as never;
}

// reader (id 1) owns post 100; writer (id 2) leaves 60 comments on it. 60 > the
// 50-row INBOX_PAGE, so comments_on_your_posts truncates: its safe_id is the
// 50th id (ASC), strictly below the board head of 60.
function seedTruncatedOwnPostsBucket(db: DatabaseSync) {
  db.exec(`
    INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at)
    VALUES (100, 1, 'reader post', 'body', 'dupe-100', 0);
  `);
  const rows: string[] = [];
  for (let id = 1; id <= 60; id++) {
    rows.push(`(${id}, 100, 2, 'comment ${id}', ${id})`);
  }
  db.exec(`INSERT INTO comments (id, post_id, citizen_id, body, created_at) VALUES ${rows.join(",")};`);
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

test("the offered ack_cursor is strictly below the board head, and an ack past it still advances — the server does not clamp", async () => {
  const db = freshDb();
  seedTruncatedOwnPostsBucket(db);
  try {
    // since=NaN, not 0: a finite non-negative since is a replay window and
    // forces legacy mode, which serves no ack_cursor.
    const page = (await me(envFor(db), reader(db), NaN, null, "id")) as {
      ack_cursor: { comments: number };
    };
    const offered = page.ack_cursor.comments;
    assert.equal(offered, 50, "a truncated bucket offers the 50th id, not the board head");

    // write-time's move: send the board head (60), 10 ids past the offer.
    const boardHead = 60;
    assert.ok(boardHead > offered, "the seed must put the head above the offered prefix, or the test proves nothing");
    const acked = (await ackInbox(envFor(db), reader(db), {
      version: 1,
      timestamp: Date.now(),
      comments: boardHead,
      mentions: 0,
    })) as { advanced: boolean; comments: number };
    assert.equal(acked.advanced, true, "an ack past the offered safe prefix is accepted, not refused");
    assert.equal(acked.comments, boardHead, "the stored cursor jumps to the head, skipping ids 51..60 that were never delivered");

    const stored = db.prepare("SELECT last_seen_comment_id FROM citizens WHERE id = 1").get() as {
      last_seen_comment_id: number;
    };
    assert.equal(stored.last_seen_comment_id, boardHead, "the skip is durable and, the stream being forward-only, unrecoverable");
  } finally {
    db.close();
  }
});

test("the board head is the only bound: one id past it is a 400", async () => {
  const db = freshDb();
  seedTruncatedOwnPostsBucket(db);
  try {
    await assert.rejects(
      () => ackInbox(envFor(db), reader(db), { version: 1, timestamp: Date.now(), comments: 61, mentions: 0 }),
      (e: Error) => e instanceof SocietyError && e.status === 400 && /ahead of the database/.test(e.message),
      "the sole guard is the board head, which is exactly why the caller — not the server — carries the safe-prefix invariant",
    );
  } finally {
    db.close();
  }
});

test("cursor_note attributes the safe prefix to the offered value and states the no-clamp consequence", () => {
  const source = readFileSync(new URL("../src/society.ts", import.meta.url), "utf8");
  const start = source.indexOf('cursor_note:\n      "Reads never move the cursor. In cursor_mode=id');
  assert.ok(start >= 0, "the /api/me id-mode cursor_note must be present");
  const note = source.slice(start, source.indexOf('since_last_visit: {', start));

  assert.match(note, /does NOT clamp your POST/, "the note must say the server does not clamp the acked value");
  assert.match(note, /never redelivered/, "the note must state the unrecoverable consequence of over-acking");
  assert.match(note, /the OFFERED `ack_cursor` is the proven-safe/, "the safe prefix is a property of the offered value, not of what is accepted back");
  assert.doesNotMatch(
    note,
    /the token advances only the proven-safe comment and mention ID prefixes/,
    "the misleading indicative that read as a server guarantee is gone",
  );
});
