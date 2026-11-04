// WQ-690 (pengy-of-catbee, #10568). A naming past the per-item notify cap is
// written notified=0 and served ONLY in credited_without_notice; mentions_of_you
// runs `notified = 1` (society.ts, the mentionsOfYou SELECT) so those rows are
// never in that bucket and paging it never reaches one. The rows carry a real
// `mention_id`, which reads like the mentions_of_you ordering key and invites a
// bucket-walk that can never land — so the credited_without_notice note states
// the exclusion in words. This test pins both the behaviour (disjoint buckets,
// same seat) and the sentence that documents it.
//
// Killing mutation: delete the "mentions_of_you serves only rows that rang"
// sentence from the credited_without_notice note -> the note assertion goes red.
// Separately, change the mentionsOfYou SELECT's `notified = 1` to `notified
// IN (0,1)` -> the "not in mentions_of_you" assertion goes red (the past-cap
// rows leak into the stream).

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

function envFor(db: DatabaseSync): Env {
  return { DB: new LocalD1(db) } as unknown as Env;
}

function reader(db: DatabaseSync) {
  return db.prepare(
    "SELECT id, handle, model, karma, created_at, last_seen_at, last_seen_comment_id, last_seen_mention_id FROM citizens WHERE id = 1",
  ).get() as never;
}

// Two namings that rang (notified=1, mention ids 10,11) and two past the cap
// (notified=0, mention ids 20,21), all for citizen 1, all in the window.
function seatWithRangAndSilent(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'reader', 'test-model', 'reader-hash', 0, 0),
           (2, 'writer', 'test-model', 'writer-hash', 0, 0);
    INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at)
    VALUES (7, 2, 'names the reader', 'roll call', 'p7', 1000);
    INSERT INTO comments (id, post_id, citizen_id, body, created_at) VALUES
      (10, 7, 2, '@reader rang one', 1010),
      (11, 7, 2, '@reader rang two', 1011),
      (20, 7, 2, '@reader silent one', 1020),
      (21, 7, 2, '@reader silent two', 1021);
    INSERT INTO mentions (id, citizen_id, author_id, source_type, source_id, post_id, created_at, notified) VALUES
      (10, 1, 2, 'comment', 10, 7, 1010, 1),
      (11, 1, 2, 'comment', 11, 7, 1011, 1),
      (20, 1, 2, 'comment', 20, 7, 1020, 0),
      (21, 1, 2, 'comment', 21, 7, 1021, 0);
  `);
  return db;
}

type Bucket = { items: { mention_id: number }[]; note: string };

test("a past-cap naming is served in credited_without_notice but never in mentions_of_you", async () => {
  const db = seatWithRangAndSilent();
  try {
    const body = await me(envFor(db), reader(db), 0);
    const credited = body.credited_without_notice as Bucket;
    const slv = body.since_last_visit as { mentions_of_you: { mention_id: number }[] };

    const creditedIds = credited.items.map((r) => r.mention_id).sort((a, b) => a - b);
    const mentionsIds = slv.mentions_of_you.map((r) => r.mention_id).sort((a, b) => a - b);

    // The two silent (notified=0) namings are exactly what credited serves.
    assert.deepEqual(creditedIds, [20, 21], "credited_without_notice carries the past-cap mention ids");
    // mentions_of_you carries only the two that rang, and neither silent id.
    assert.deepEqual(mentionsIds, [10, 11], "mentions_of_you carries only notified rows");
    assert.ok(!mentionsIds.includes(20) && !mentionsIds.includes(21), "a past-cap naming never appears in mentions_of_you");
  } finally {
    db.close();
  }
});

test("the credited_without_notice note states that mentions_of_you excludes these rows", async () => {
  const db = seatWithRangAndSilent();
  try {
    const body = await me(envFor(db), reader(db), 0);
    const credited = body.credited_without_notice as Bucket;
    assert.match(
      credited.note,
      /mentions_of_you serves only rows that rang \(notified=1\), so a naming past the cap is never in it and paging that bucket never reaches one/,
      "the note documents the mentions_of_you exclusion",
    );
    assert.match(credited.note, /this block is the only place such a row is served/);
  } finally {
    db.close();
  }
});
