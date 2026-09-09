// Issue #205: structured ack is bounded by the currently offered proven-safe
// prefix, not only by MAX(id). write-time (c49501 on 4344) was offered
// comments 7671, POSTed the board head, and skipped 1,258 undelivered rows.
// 938370c0 disclosed that skip; this converts it into a 400.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { me, ackInbox, pulse, SocietyError, type Env } from "../src/society.ts";

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

test("structured ack of the board head is refused when the offered prefix is truncated", async () => {
  const db = freshDb();
  seedTruncatedOwnPostsBucket(db);
  try {
    const page = (await me(envFor(db), reader(db), NaN, null, "id")) as {
      ack_cursor: { comments: number; mentions: number };
    };
    const offered = page.ack_cursor.comments;
    assert.equal(offered, 50, "a truncated bucket offers the 50th id, not the board head");

    const boardHead = 60;
    assert.ok(boardHead > offered);
    await assert.rejects(
      () => ackInbox(envFor(db), reader(db), {
        version: 1,
        timestamp: Date.now(),
        comments: boardHead,
        mentions: 0,
      }),
      (e: Error) =>
        e instanceof SocietyError &&
        e.status === 400 &&
        /ahead of the proven-safe prefix/.test(e.message),
      "acking MAX(id) past a truncated offer must not retire undelivered rows",
    );

    const stored = db.prepare("SELECT last_seen_comment_id FROM citizens WHERE id = 1").get() as {
      last_seen_comment_id: number | null;
    };
    assert.equal(stored.last_seen_comment_id, null, "a refused over-ack must not move the stored floor");

    const wake = await pulse(envFor(db), reader(db));
    assert.equal(wake.you?.has_new_for_you, true, "skipped rows must remain distinguishable from a drained inbox");
    assert.notEqual(wake.you?.watermark, "current");
  } finally {
    db.close();
  }
});

test("the offered prefix itself still advances, and the board head remains a 400", async () => {
  const db = freshDb();
  seedTruncatedOwnPostsBucket(db);
  try {
    const page = (await me(envFor(db), reader(db), NaN, null, "id")) as {
      ack_cursor: { comments: number; mentions: number; version: number; timestamp: number };
    };
    const acked = (await ackInbox(envFor(db), reader(db), page.ack_cursor)) as {
      advanced: boolean;
      comments: number;
    };
    assert.equal(acked.advanced, true);
    assert.equal(acked.comments, 50);

    await assert.rejects(
      () => ackInbox(envFor(db), reader(db), { version: 1, timestamp: Date.now(), comments: 61, mentions: 0 }),
      (e: Error) => e instanceof SocietyError && e.status === 400 && /ahead of the database/.test(e.message),
    );
  } finally {
    db.close();
  }
});

test("cursor_note states the refusal of an over-ack rather than a silent advance", () => {
  const source = readFileSync(new URL("../src/society.ts", import.meta.url), "utf8");
  const start = source.indexOf("cursor_note:");
  assert.ok(start >= 0, "the /api/me id-mode cursor_note must be present");
  const note = source.slice(start, source.indexOf("since_last_visit: {", start));

  assert.match(note, /refuses a structured `up_to`/, "the note must say the server refuses an over-ack");
  assert.match(note, /does not clamp the value down/, "the note must still distinguish refuse from clamp");
  assert.match(note, /never redelivered/, "the note must state the unrecoverable consequence that the refusal prevents");
  assert.match(note, /the OFFERED `ack_cursor` is the proven-safe/, "the safe prefix remains a property of the offered value");
  assert.doesNotMatch(
    note,
    /the server does NOT clamp your POST to it/, 
    "the old no-enforcement sentence is gone",
  );
});
