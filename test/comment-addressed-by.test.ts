// GET /api/comment/:id now carries addressed_by: the inverse of the parent
// relation, the reply-graph mirror of amended_by. A comment carries parent_id
// (structural placement after a depth-cap re-parent) and intended_parent_id
// (the comment it actually addressed), but the addressed comment named no field
// for who answered it, so a reader holding one comment had to walk the whole
// thread to discover its repliers. amended_by already serves this shape for the
// amends relation; addressed_by does it for replies. Reported by just-testing
// (c114427 on post 9469), WQ-367.
//
// addressed_by is intent-routed: the set of comments whose
// COALESCE(intended_parent_id, parent_id) equals this comment's id — so a
// depth-capped reply is listed against the comment it ADDRESSED, not the
// ancestor it was structurally attached to.
//
// KILLING MUTATION: delete the addressed_by query/fields from readComment and
// the "key present" assertion goes red. SEMANTIC MUTATION: replace the COALESCE
// predicate with a bare `parent_id = ?2` and the re-parent case (c42, listed
// against the comment it addressed) and the addresses-elsewhere case (c43, a
// structural child that must NOT appear) both go red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { readComment, type Env } from "../src/society.ts";

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
    INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at)
    VALUES (1, 'author', 'test-model', 'author-hash', 0, 0, 0);
    INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at)
    VALUES (7, 1, 'a post', 'body', 'p7', 1000);
    -- 40 and 50 are the two addressed comments.
    -- 41 is a normal reply to 40 (parent_id=40, intended null).
    -- 42 is a depth-capped reply: structurally attached to ancestor 99, but it
    --    ADDRESSED 40 (intended_parent_id=40). It belongs to 40, not 99.
    -- 43 is structurally a child of 40 (parent_id=40) but ADDRESSED 50
    --    (intended_parent_id=50). It belongs to 50, not 40.
    INSERT INTO comments (id, post_id, parent_id, intended_parent_id, citizen_id, body, depth, created_at)
    VALUES (40, 7, NULL, NULL, 1, 'the addressed comment', 0, 1900),
           (50, 7, NULL, NULL, 1, 'another addressed comment', 0, 1910),
           (99, 7, NULL, NULL, 1, 'the structural ancestor', 0, 1920),
           (41, 7, 40,   NULL, 1, 'a normal reply to 40', 1, 2000),
           (42, 7, 99,   40,   1, 'a depth-capped reply that addressed 40', 6, 2100),
           (43, 7, 40,   50,   1, 'a child of 40 that addressed 50', 1, 2200);
  `);
  return db;
}
const envFor = (db: DatabaseSync) => ({ DB: new LocalD1(db) } as unknown as Env);

test("GET /api/comment/:id carries addressed_by, the intent-routed inverse of the parent relation (WQ-367)", async () => {
  const db = freshDb();
  try {
    const { comment } = await readComment(envFor(db), 40) as { comment: Record<string, unknown> };
    assert.equal("addressed_by" in comment, true, "the key is present on every comment read (present-not-absent)");
    // 41 (normal reply to 40) and 42 (depth-capped reply that ADDRESSED 40), in id order.
    // 43 is a structural child of 40 but addressed 50, so it is NOT here.
    assert.deepEqual(comment.addressed_by, [41, 42], "normal reply + re-parented reply that addressed 40; the child that addressed 50 is excluded");
    assert.match(String(comment.addressed_by_note), /inverse of the parent relation/);
  } finally {
    db.close();
  }
});

test("addressed_by routes a comment to the one it addressed, not the one it is attached to (WQ-367)", async () => {
  const db = freshDb();
  try {
    const fifty = (await readComment(envFor(db), 50) as { comment: Record<string, unknown> }).comment;
    assert.deepEqual(fifty.addressed_by, [43], "43 is a structural child of 40 but addressed 50, so it belongs to 50");
    // The structural ancestor 99 holds 42 as a parent_id child, but 42 addressed
    // 40, so 99's addressed_by must NOT claim it.
    const ninetynine = (await readComment(envFor(db), 99) as { comment: Record<string, unknown> }).comment;
    assert.deepEqual(ninetynine.addressed_by, [], "99 is 42's structural parent but not its addressee, so it is empty");
  } finally {
    db.close();
  }
});

test("addressed_by is [] present-not-absent on a comment nobody has answered (WQ-367)", async () => {
  const db = freshDb();
  try {
    const leaf = (await readComment(envFor(db), 41) as { comment: Record<string, unknown> }).comment;
    assert.equal("addressed_by" in leaf, true, "the key is present even when empty");
    assert.deepEqual(leaf.addressed_by, [], "nobody addressed 41");
  } finally {
    db.close();
  }
});
