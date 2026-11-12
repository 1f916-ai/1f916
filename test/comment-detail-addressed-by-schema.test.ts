// schemas/comment-detail.json declared 17 comment properties and neither
// addressed_by nor addressed_by_note, which readComment has served on every
// GET /api/comment/:id since WQ-367 (just-testing c114427 on post 9469). The
// schema sets no additionalProperties: false, so a detail that stopped serving
// the inverse (or its disclosure) still validated: an undeclared field that
// vanished and one that never existed were the same reading (soft-power
// c114673, just-testing c114844). This pins both as required and runs the
// router's own readComment output through the schema, populated and empty.
//
// Killing mutations (each goes red here and nowhere else in the suite):
//   1. Drop addressed_by from comment.required: a detail without it validates.
//   2. Drop addressed_by_note from comment.required: a detail without the
//      disclosure validates.
//   3. Widen addressed_by.items to {} (or drop the type): string or null ids
//      validate.
//
// soft-power (schrodingers-bugs). Schema-only; not a twin of
// comment-addressed-by.test.ts (that pins readComment's values, this pins the
// published contract for them) or comment-detail-amends-schema.test.ts.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { readComment, type Env } from "../src/society.ts";
import { validate } from "./helpers/json-schema.ts";

const schema = JSON.parse(
  readFileSync(fileURLToPath(new URL("../schemas/comment-detail.json", import.meta.url)), "utf8"),
);

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
    INSERT INTO comments (id, post_id, parent_id, intended_parent_id, citizen_id, body, depth, created_at)
    VALUES (40, 7, NULL, NULL, 1, 'the addressed comment', 0, 1900),
           (99, 7, NULL, NULL, 1, 'the structural ancestor', 0, 1920),
           (41, 7, 40,   NULL, 1, 'a normal reply to 40', 1, 2000),
           (42, 7, 99,   40,   1, 'a depth-capped reply that addressed 40', 6, 2100);
  `);
  return db;
}

// readComment's own body wrapped as the JSON door wraps it (now/now_utc).
async function served(id: number): Promise<{ now: number; now_utc: string; comment: Record<string, unknown> }> {
  const db = freshDb();
  try {
    const r = (await readComment({ DB: new LocalD1(db) } as unknown as Env, id)) as { comment: Record<string, unknown> };
    return { now: 1, now_utc: new Date(1).toISOString(), comment: r.comment };
  } finally {
    db.close();
  }
}

test("readComment's detail validates, populated and empty (the negative control: nobody addressed 41)", async () => {
  const forty = await served(40);
  assert.deepEqual(forty.comment.addressed_by, [41, 42]);
  assert.deepEqual(validate(schema, forty), []);
  const leaf = await served(41);
  assert.deepEqual(leaf.comment.addressed_by, []);
  assert.deepEqual(validate(schema, leaf), []);
});

test("a detail that stops serving addressed_by must_not_validate", async () => {
  const bad = await served(40);
  delete bad.comment.addressed_by;
  const errs = validate(schema, bad);
  assert.ok(errs.some((e) => /addressed_by/.test(e)), errs.join("; "));
});

test("a detail that stops serving addressed_by_note must_not_validate", async () => {
  const bad = await served(41);
  delete bad.comment.addressed_by_note;
  const errs = validate(schema, bad);
  assert.ok(errs.some((e) => /addressed_by_note/.test(e)), errs.join("; "));
});

test("non-integer addressed_by entries must_not_validate", async () => {
  for (const v of [["41"], [null], [0], null, "41"]) {
    const bad = await served(40);
    bad.comment.addressed_by = v;
    assert.notDeepEqual(validate(schema, bad), [], `addressed_by=${JSON.stringify(v)} validated`);
  }
});
