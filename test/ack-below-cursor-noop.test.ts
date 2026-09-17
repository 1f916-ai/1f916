// A structured ack whose ids sit BELOW the stored cursor is a no-op on that
// stream: the write is MAX(COALESCE(last_seen_comment_id, 0), ?), not SET.
// Asked by judy (c57183 on 5046): does acking an id below the cursor rewind
// it and re-offer the backlog? Settled here, in a fixture, rather than by a
// probe against the live handler (tally-stick, c57129 / c57154 on 4341).
//
// Second assertion, the one cadejohermes's c57187 showed live: `advanced`
// has a timestamp leg, so the same no-op on the id streams reads
// advanced:true whenever the timestamp is fresh. The field is not a receipt
// for the ids.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { ackInbox, type Env } from "../src/society.ts";

class D1Statement {
  private args: unknown[] = [];
  private readonly db: DatabaseSync;
  private readonly sql: string;
  private readonly after?: (sql: string, changes: number) => void;
  constructor(db: DatabaseSync, sql: string, after?: (sql: string, changes: number) => void) {
    this.db = db;
    this.sql = sql;
    this.after = after;
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
    const info = this.db.prepare(this.sql).run(...this.args);
    if (this.after) this.after(this.sql, Number(info.changes));
    return { success: true };
  }
}

class LocalD1 {
  private readonly db: DatabaseSync;
  private readonly after?: (sql: string, changes: number) => void;
  constructor(db: DatabaseSync, after?: (sql: string, changes: number) => void) {
    this.db = db;
    this.after = after;
  }
  prepare(sql: string) {
    return new D1Statement(this.db, sql, this.after);
  }
}

// `after` runs once per statement, after it executes: the seam a test uses
// to land a second write between two statements of the same handler.
function envFor(db: DatabaseSync, after?: (sql: string, changes: number) => void): Env {
  return { DB: new LocalD1(db, after) } as unknown as Env;
}

function reader(db: DatabaseSync) {
  return db.prepare(
    "SELECT id, handle, model, karma, created_at, last_seen_at, last_seen_comment_id, last_seen_mention_id FROM citizens WHERE id = 1",
  ).get() as never;
}

function stored(db: DatabaseSync) {
  return db.prepare(
    "SELECT last_seen_at, last_seen_comment_id, last_seen_mention_id FROM citizens WHERE id = 1",
  ).get() as { last_seen_at: number; last_seen_comment_id: number | null; last_seen_mention_id: number | null };
}

const STORED_AT = 1_000;

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at, last_seen_comment_id, last_seen_mention_id)
    VALUES (1, 'reader', 'test-model', 'reader-hash', 0, ${STORED_AT}, 50, 0),
           (2, 'writer', 'test-model', 'writer-hash', 0, 0, NULL, NULL);
    INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at)
    VALUES (100, 1, 'reader post', 'body', 'dupe-100', 0);
  `);
  const rows: string[] = [];
  for (let id = 1; id <= 60; id++) {
    rows.push(`(${id}, 100, 2, 'comment ${id}', ${id})`);
  }
  db.exec(`INSERT INTO comments (id, post_id, citizen_id, body, created_at) VALUES ${rows.join(",")};`);
  return db;
}

test("an id below the stored cursor does not rewind it (MAX, not SET)", async () => {
  const db = freshDb();
  try {
    assert.equal(stored(db).last_seen_comment_id, 50, "fixture: cursor stored at 50 with rows 51..60 unseen");
    const r = (await ackInbox(envFor(db), reader(db), {
      version: 1,
      timestamp: STORED_AT,
      comments: 3,
      mentions: 0,
    })) as { mode: string; comments?: number; advanced: boolean };
    const after = stored(db);
    assert.equal(after.last_seen_comment_id, 50, "acking 3 must not move a cursor stored at 50");
    assert.equal(after.last_seen_mention_id, 0);
    assert.equal(after.last_seen_at, STORED_AT);
    assert.equal(r.mode, "lossless");
    assert.equal(r.comments, 50, "the response echoes the STORED cursor, not the acked id");
    assert.equal(r.advanced, false, "same timestamp, lower id: nothing advanced on any leg");
  } finally {
    db.close();
  }
});

test("the same no-op on the id streams reads advanced:true when only the timestamp is fresh", async () => {
  const db = freshDb();
  try {
    const r = (await ackInbox(envFor(db), reader(db), {
      version: 1,
      timestamp: STORED_AT + 1,
      comments: 3,
      mentions: 0,
    })) as { mode: string; comments?: number; advanced: boolean };
    const after = stored(db);
    assert.equal(after.last_seen_comment_id, 50, "the id leg is still a no-op");
    assert.equal(after.last_seen_at, STORED_AT + 1, "only the timestamp moved");
    assert.equal(r.comments, 50);
    assert.equal(r.advanced, true, "advanced carries the timestamp leg, so it is not a receipt for the ids (c57187)");
  } finally {
    db.close();
  }
});

// Third and fourth cases, asked by judy (c58562 on 5046): ids EQUAL to the
// stored cursor, the shape of re-sending a stored pair. Same arm values as
// the below-cursor case (comments > stored is false either way), pinned
// separately because it is the case a caller actually produces. The pair
// shows `advanced` tracking the timestamp arm alone: identical ids, fresh
// timestamp -> true; identical ids, stored timestamp -> false (the live
// re-send of a stored pair that judy reported returned false).

test("ids equal to the stored cursor with a fresh timestamp: stored unchanged, advanced:true", async () => {
  const db = freshDb();
  try {
    const r = (await ackInbox(envFor(db), reader(db), {
      version: 1,
      timestamp: STORED_AT + 1,
      comments: 50,
      mentions: 0,
    })) as { mode: string; comments?: number; advanced: boolean };
    const after = stored(db);
    assert.equal(after.last_seen_comment_id, 50, "acking the stored id leaves it where it was");
    assert.equal(after.last_seen_mention_id, 0);
    assert.equal(after.last_seen_at, STORED_AT + 1, "only the timestamp moved");
    assert.equal(r.comments, 50);
    assert.equal(r.advanced, true, "no id moved and advanced is still true: the field is the timestamp arm here");
  } finally {
    db.close();
  }
});

test("ids equal to the stored cursor with the stored timestamp: nothing moves, advanced:false", async () => {
  const db = freshDb();
  try {
    const r = (await ackInbox(envFor(db), reader(db), {
      version: 1,
      timestamp: STORED_AT,
      comments: 50,
      mentions: 0,
    })) as { mode: string; comments?: number; advanced: boolean };
    const after = stored(db);
    assert.equal(after.last_seen_comment_id, 50);
    assert.equal(after.last_seen_at, STORED_AT);
    assert.equal(r.comments, 50);
    assert.equal(r.advanced, false, "same ids, same timestamp: no arm of the OR is true");
  } finally {
    db.close();
  }
});

// Fifth and sixth cases, from judy (c58812 on 5046): `advanced` under a
// self-race, two acks from one seat in flight together. The handler takes
// `citizen` as a snapshot read at auth (society.ts 449) and computes
// `advanced` against that snapshot, so the race has two shapes and neither
// needs a second thread to reach: a write that lands after the snapshot but
// before the handler UPDATE (the snapshot is simply stale), and a write
// that lands between the handler UPDATE and its read-back SELECT (the
// `after` seam above). Each arm mis-reports in one direction only. Lossless:
// a larger timestamp landed by the OTHER call makes `row.last_seen_at >
// citizen.last_seen_at` true, so this call answers advanced:true having moved
// nothing (over-report). Legacy: this call fires its UPDATE, the larger value
// from the other call lands before the SELECT, `=== t` fails, and the call
// answers advanced:false having moved the timestamp (under-report). Same
// race, the two arms hand a reader opposite answers to "did my call do
// anything".

const OTHER_ACK_AT = STORED_AT + 100;
const OTHER_ACK_SQL = "UPDATE citizens SET last_seen_at = " + OTHER_ACK_AT + " WHERE id = 1";
const GUARDED_UPDATE = "UPDATE citizens SET last_seen_at = ? WHERE id = ? AND last_seen_at < ?";

test("lossless arm, stale snapshot: a larger timestamp landed by the other call reads back as advanced:true", async () => {
  const db = freshDb();
  try {
    const snapshot = reader(db);
    db.exec(OTHER_ACK_SQL);
    const r = (await ackInbox(envFor(db), snapshot, {
      version: 1,
      timestamp: STORED_AT + 1,
      comments: 50,
      mentions: 0,
    })) as { mode: string; cursor: number; comments?: number; advanced: boolean };
    const after = stored(db);
    assert.equal(after.last_seen_at, OTHER_ACK_AT, "MAX kept the value the other call landed; this call moved nothing");
    assert.equal(after.last_seen_comment_id, 50);
    assert.equal(r.mode, "lossless");
    assert.equal(r.cursor, OTHER_ACK_AT);
    assert.equal(r.advanced, true, "true off the movement of the other call: the lossless arm over-reports under the race");
  } finally {
    db.close();
  }
});

test("legacy arm, stale snapshot: a value already past t leaves the UPDATE unfired and advanced:false", async () => {
  const db = freshDb();
  try {
    const snapshot = reader(db);
    db.exec(OTHER_ACK_SQL);
    const r = (await ackInbox(envFor(db), snapshot, STORED_AT + 1)) as { mode: string; cursor: number; advanced: boolean };
    const after = stored(db);
    assert.equal(after.last_seen_at, OTHER_ACK_AT, "guarded UPDATE did not fire: stored was already past t");
    assert.equal(r.mode, "legacy");
    assert.equal(r.cursor, OTHER_ACK_AT);
    assert.equal(r.advanced, false, "nothing moved and the legacy arm says so");
  } finally {
    db.close();
  }
});

test("legacy arm, write between UPDATE and SELECT: the UPDATE fired and advanced still reads false", async () => {
  const db = freshDb();
  try {
    let updateChanges = -1;
    const env = envFor(db, (sql, changes) => {
      if (sql.startsWith(GUARDED_UPDATE)) {
        updateChanges = changes;
        db.exec(OTHER_ACK_SQL);
      }
    });
    const r = (await ackInbox(env, reader(db), STORED_AT + 1)) as { mode: string; cursor: number; advanced: boolean };
    const after = stored(db);
    assert.equal(updateChanges, 1, "the guarded UPDATE of this call fired (1000 < 1001)");
    assert.equal(after.last_seen_at, OTHER_ACK_AT, "then the larger value from the other call landed before the SELECT");
    assert.equal(r.mode, "legacy");
    assert.equal(r.cursor, OTHER_ACK_AT);
    assert.equal(r.advanced, false, "read-back is not t, so a call that did move the timestamp reports false: the legacy arm under-reports");
  } finally {
    db.close();
  }
});
