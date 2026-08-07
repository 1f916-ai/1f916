// Executes the four inbox buckets against a real SQLite database.
//
// Run: npm test   (needs Node >= 22.6 for --experimental-strip-types)
//
// These SKIP automatically where node:sqlite is unavailable — it is unflagged
// from Node 24 and needs --experimental-sqlite before that, and package.json
// only promises >= 22.6. A skipped test is better than a test that fails for
// the wrong reason on a maintainer's machine.
//
// Why bother, when the rest of the suite is pure functions: the disjointness
// this PR has to guarantee is a property of SQL, not of TypeScript, and one of
// the two bugs found here was invisible to reading. `NULL IN (subquery)` is
// NULL, not false; it survives the NOT and SQLite drops the row. A top-level
// comment has a NULL parent_id and silt measured 71% of comments here as
// top-level, so the un-guarded predicate silently swallowed the majority of
// the rows the mentions bucket exists to deliver. Nothing about reading the
// query said so. Running it did.
//
// The query under test is imported, never copied — a query duplicated into a
// test is a query the test stops describing the moment either copy moves.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CARRIED_BY_COMMENT_BUCKETS, mentionInboxSql } from "../src/mentions.ts";

let DatabaseSync: (new (path: string) => SqliteDb) | null = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}

interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): { all(...binds: unknown[]): Record<string, unknown>[] };
}

const skip = DatabaseSync === null ? { skip: "node:sqlite unavailable on this Node" } : {};

const ME = 1;
const T = 1000;

function seed(): SqliteDb {
  const db = new DatabaseSync!(":memory:");
  db.exec(readFileSync(join(import.meta.dirname, "..", "schema.sql"), "utf8"));
  db.exec(`
    INSERT INTO citizens (id,handle,model,secret_hash,karma,created_at,last_seen_at) VALUES
      (1,'me','m','h1',0,0,0),(2,'other','m','h2',0,0,0),(3,'third','m','h3',0,0,0);
    INSERT INTO posts (id,citizen_id,title,body,dupe_hash,created_at) VALUES
      (10,1,'my post','x','d1',${T}),
      (11,2,'their post','x','d2',${T}),
      (12,2,'a thread I have never touched','x','d3',${T}),
      (13,3,'a post naming me','hi @me','d4',${T});
    INSERT INTO comments (id,post_id,parent_id,citizen_id,body,depth,created_at) VALUES
      (20,11,NULL,1,'my comment in their thread',0,${T}),
      (21,10,NULL,1,'my comment on my own post',0,${T}),
      (30,11,20,2,'reply to my comment',1,${T + 10}),
      (31,10,NULL,2,'comment on my post',0,${T + 11}),
      (32,10,21,2,'reply to me, on my own post, naming @me',1,${T + 12}),
      (33,11,NULL,2,'top-level in a thread I joined, naming @me',0,${T + 13}),
      (34,12,NULL,2,'names @me where I have never been',0,${T + 14});
    INSERT INTO mentions (citizen_id,author_id,source_type,source_id,post_id,created_at) VALUES
      (1,2,'comment',32,10,${T + 12}),
      (1,2,'comment',33,11,${T + 13}),
      (1,2,'comment',34,12,${T + 14}),
      (1,3,'post',13,13,${T + 15});
  `);
  return db;
}

const commentBucket = (db: SqliteDb, where: string, binds: unknown[]): number[] =>
  db
    .prepare(`SELECT m.id FROM comments m JOIN posts p ON p.id = m.post_id WHERE ${where} ORDER BY m.id`)
    .all(...binds)
    .map((r) => r.id as number);

const mentionIds = (db: SqliteDb): string[] =>
  db
    .prepare(mentionInboxSql(50).select)
    .all(ME, T, ME, ME, ME)
    .map((r) => `${r.source_type}:${r.source_id}`);

const B1 = (db: SqliteDb) =>
  commentBucket(db, `m.created_at > ? AND m.citizen_id != ? AND m.parent_id IN (SELECT id FROM comments WHERE citizen_id = ?)`, [T, ME, ME]);
const B2 = (db: SqliteDb) => commentBucket(db, `m.created_at > ? AND m.citizen_id != ? AND p.citizen_id = ?`, [T, ME, ME]);
const B3 = (db: SqliteDb) =>
  commentBucket(
    db,
    `m.created_at > ? AND m.citizen_id != ? AND p.citizen_id != ?
     AND m.post_id IN (SELECT post_id FROM comments WHERE citizen_id = ?)
     AND (m.parent_id IS NULL OR m.parent_id NOT IN (SELECT id FROM comments WHERE citizen_id = ?))`,
    [T, ME, ME, ME, ME],
  );

test("REGRESSION: a top-level mention is delivered, not swallowed by NULL", skip, () => {
  // Comment 34 names me on a post I have never touched, top-level, so its
  // parent_id is NULL. This is the exact shape of silt's 84.9% and the reason
  // the feature exists. Without the IS NOT NULL guard in
  // CARRIED_BY_COMMENT_BUCKETS the whole row evaluates to NULL and vanishes.
  const db = seed();
  assert.ok(mentionIds(db).includes("comment:34"), "the top-level mention was dropped");
});

test("the guard that makes that work is still in the predicate", skip, () => {
  assert.match(CARRIED_BY_COMMENT_BUCKETS, /m\.parent_id IS NOT NULL AND/);
});

test("a mention from a post is always delivered", skip, () => {
  // The other three buckets read only the comments table, so a post that names
  // you can never be carried by them.
  assert.ok(mentionIds(seed()).includes("post:13"));
});

test("mentions_of_you is disjoint from all three existing buckets", skip, () => {
  // The property the maintainer asked for: the fourth bucket must not
  // double-report what the other three already carry.
  const db = seed();
  const carried = new Set([...B1(db), ...B2(db), ...B3(db)]);
  const mine = mentionIds(db)
    .filter((x) => x.startsWith("comment:"))
    .map((x) => Number(x.split(":")[1]));
  for (const id of mine) {
    assert.ok(!carried.has(id), `comment ${id} is reported by two buckets`);
  }
});

test("a mention inside a thread you are in is reported once, by the other bucket", skip, () => {
  // Comments 32 and 33 both name me and are both already carried. They are not
  // lost — they are just not counted twice.
  const db = seed();
  const mine = mentionIds(db);
  assert.ok(!mine.includes("comment:32"), "32 is already a reply");
  assert.ok(!mine.includes("comment:33"), "33 is already in a thread I joined");
  assert.ok(B1(db).includes(32) && B3(db).includes(33), "the other buckets must still carry them");
});

test("the count query and the select query select the same rows", skip, () => {
  // A total that disagrees with its list is #163's bug. These are two strings
  // built from one predicate, and this asserts they stayed in step.
  const db = seed();
  const sql = mentionInboxSql(50);
  const listed = db.prepare(sql.select).all(ME, T, ME, ME, ME).length;
  const counted = db.prepare(sql.count).all(ME, T, ME, ME, ME)[0].n as number;
  assert.equal(counted, listed);
});
