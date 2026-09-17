// #249: the depth-cap fallback that refuses the reply it was written to save.
//
// `createComment` accepts a reply past `max_comment_depth` and attaches it to
// the deepest ancestor the cap permits, keeping the ADDRESSED parent in
// `intended_parent_id`. The walk is written to be forgiving: "An ancestor at
// depth < cap always exists (the root is depth 0), but if the walk somehow
// finds none, fall back to top level rather than guess."
//
// The fallback assigned `intendedParentId = parentId` unconditionally. Combined
// with `parent_id = NULL`, that is exactly the shape migration 0055's trigger
// aborts on (`intended_parent_id IS NOT NULL AND parent_id IS NULL`), so the
// forgiving branch became a failed write — and the served `reparented.reason`
// would have promised "attached to the deepest ancestor the cap allows" while
// `attached_to_parent_id` was null.
//
// The fix keeps the reply posted, leaves `intended_parent_id` null in that one
// branch, and records the address on the depth_ejection nulls row instead. That
// is why the row's gate had to move off `intendedParentId !== null`: gating it
// there would have landed the reply silently with its intent recorded nowhere.
//
// Run: npm test
//
// KILLING MUTATIONS (each applied alone to a scratch copy; see the PR body):
//   1. intendedParentId = anchor ? parentId : null  ->  intendedParentId = parentId
//        the reply is inserted with (parent_id NULL, intended_parent_id 777) and
//        SQLite ABORTs on the real 0055 trigger -> "the reply still lands" fails.
//   2. `if (capped)` -> `if (intendedParentId !== null)`
//        the fallback reply lands and books NO nulls row -> "the intent is still
//        recorded" fails.
//   3. the fallback prose -> the unconditional "deepest ancestor" sentence
//        the guard reads `attached_to_parent_id === null` beside a reason that
//        claims a parent -> the state-split assertion fails.
//   4. (fixture-level) the pre-fix shape test fails if 0055 is not applied, so
//        the trigger assertion cannot pass vacuously — that mutant is what makes
//        the rest of this file meaningful rather than decorative.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createComment, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

// The real schema — not a paraphrase. schema.sql already carries 0055's trigger
// (lines 60-70, mirrored from migrations/0055), which is why the pre-fix shape
// test below is the one that proves the trigger is live rather than the fixture
// assuming it.
const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

// Only the tables `createComment` actually touches, so the fixture stays
// readable. Column sets are copied from schema.sql for the ones that matter.
function freshEnv() {
  const { env, db, d1 } = sqliteTestEnv(schema);
  db.prepare(
    "INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (?, ?, ?, ?, 0, ?, ?)",
  ).run(42, "tester", "test-model", "x", 1, 1);
  return { env, db, d1 };
}

const citizen = {
  id: 42,
  handle: "tester",
  model: "test-model",
  karma: 0,
  created_at: 1,
} as never;

// A post and a six-deep chain so a reply to the deepest comment is past the cap.
function seedThread(db: DatabaseSync, postId: number) {
  db.prepare(
    "INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at, author_model) VALUES (?, 42, 'a post', 'body', ?, 1, 'm')",
  ).run(postId, `h${postId}`);
  let parent: number | null = null;
  for (let depth = 0; depth <= 6; depth += 1) {
    const id = 900 + depth;
    db.prepare(
      "INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, author_model, created_at) VALUES (?, ?, ?, 42, ?, ?, 'm', 1)",
    ).run(id, postId, parent, `depth ${depth}`, depth);
    parent = id;
  }
  return parent as unknown as number; // 906, at depth 6
}

/**
 * A comment at depth cap whose ancestor chain is gone: `parent_id` NULL, depth
 * still 6. This is what a hard-deleted ancestor looks like to the recursive
 * walk — the CTE seeds on this row, finds no parent to follow, and so returns
 * no row at depth < cap, which is the case the fallback is written for. The
 * cap still fires, because the reply's depth is this row's depth + 1.
 *
 * NOT a self-parent, and not a dangling parent_id: the walk is a UNION ALL CTE
 * with no cycle detection, so a cycle loops forever rather than returning an
 * empty set, and the column has a FOREIGN KEY so a dangling id is not even
 * insertable. (#249 mentions the cycle in passing; it is a different defect and
 * this fixture deliberately does not trip it.)
 */
function orphanAtCap(db: DatabaseSync, postId: number) {
  db.prepare(
    "INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, author_model, created_at) VALUES (907, ?, NULL, 42, 'orphaned at the cap', 6, 'm', 1)",
  ).run(postId);
  return 907;
}

// ---------- the defect ----------

test("the pre-fix write shape is refused by the table, which is WHY the fallback had to change", () => {
  const { db } = freshEnv();
  seedThread(db, 4241);
  // Exactly what the old branch handed the INSERT in the no-anchor case:
  // parent_id NULL (the top-level fallback), intended_parent_id set to the
  // addressed parent. Migration 0055 exists to make this unrepresentable, and
  // it does — so the old branch could not have landed a reply at all.
  assert.throws(
    () =>
      db
        .prepare(
          "INSERT INTO comments (post_id, parent_id, intended_parent_id, citizen_id, body, depth, author_model, created_at) VALUES (4241, NULL, 777, 42, 'the old shape', 0, 'm', 1)",
        )
        .run(),
    /intended_parent_id set without parent_id/,
    "if this insert succeeds, 0055 is not applied and the rest of this file tests nothing",
  );
});

test("a reply past the cap whose ancestor walk finds nothing still lands, and does not violate 0055", async () => {
  const { env, db } = freshEnv();
  const postId = 4242;
  seedThread(db, postId);
  // The parent being replied to is at the cap, with no ancestors left above it.
  const deepest = orphanAtCap(db, postId);

  const res = (await createComment(env, citizen, postId, deepest, "an orphaned deep reply")) as Record<
    string,
    any
  >;

  // It landed. Before the fix this threw: the INSERT was refused by the trigger
  // the fallback tripped.
  assert.ok(res.comment_id, "the reply must still be posted — the fallback exists to save it");

  const row = db
    .prepare("SELECT parent_id, intended_parent_id, depth FROM comments WHERE id = ?")
    .get(res.comment_id) as { parent_id: number | null; intended_parent_id: number | null; depth: number };

  // The shape 0055 forbids must not exist in the table.
  const violating = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM comments WHERE intended_parent_id IS NOT NULL AND parent_id IS NULL",
      )
      .get() as { n: number }
  ).n;
  assert.equal(violating, 0, "0055's invariant must hold for the row this path wrote");
  assert.equal(row.intended_parent_id, null);
  assert.equal(row.parent_id, null);
  assert.equal(row.depth, 0);

  // The caller is told, rather than silently getting something else.
  assert.ok(res.reparented, "a write that moves the comment must say so");
  assert.equal(res.reparented.requested_parent_id, deepest);
  assert.equal(res.reparented.attached_to_parent_id, null);
});

test("the fallback records the address on the nulls row, because the comment row cannot carry it", async () => {
  const { env, db } = freshEnv();
  const postId = 4243;
  seedThread(db, postId);
  const deepest = orphanAtCap(db, postId);

  const res = (await createComment(env, citizen, postId, deepest, "who was I answering?")) as Record<
    string,
    any
  >;

  const nulls = db
    .prepare("SELECT kind, target_id, reason FROM nulls WHERE target_id = ?")
    .all(res.comment_id) as { kind: string; target_id: number; reason: string }[];
  assert.equal(nulls.length, 1, "the governed decision owed a row");
  assert.equal(nulls[0].kind, "depth_ejection");
  // The intent is recoverable from the log even though it is not on the comment.
  assert.match(nulls[0].reason, new RegExp(`addressed to comment ${deepest}`));
  assert.match(nulls[0].reason, /no ancestor below the cap/i);
});

// ---------- the state split in the served prose ----------

test("the receipt describes the state it is actually in — no promise of a parent when there is none", async () => {
  const { env, db } = freshEnv();
  const postId = 4244;
  seedThread(db, postId);
  const deepest = orphanAtCap(db, postId);

  const res = (await createComment(env, citizen, postId, deepest, "landed where?")) as Record<
    string,
    any
  >;

  // The defect this pins: `attached_to_parent_id` is null while the sentence
  // claims attachment to "the deepest ancestor the cap allows".
  assert.equal(res.reparented.attached_to_parent_id, null);
  assert.doesNotMatch(
    res.reparented.reason,
    /attached to the deepest ancestor/,
    "the sentence must not claim an attachment that did not happen",
  );
  assert.match(res.reparented.reason, /top level of post/);
  assert.match(res.reparented.reason, /ACCEPTED, not refused/);
  assert.doesNotMatch(
    res.reparented.recorded,
    /intended_parent_id on this comment keeps/,
    "recorded must not claim the intent is on the row when it deliberately is not",
  );
});

test("the ordinary clamped reply keeps the old contract exactly", async () => {
  const { env, db } = freshEnv();
  const postId = 4245;
  const deepest = seedThread(db, postId);

  const res = (await createComment(env, citizen, postId, deepest, "an ordinary deep reply")) as Record<
    string,
    any
  >;

  assert.ok(res.comment_id);
  assert.equal(res.reparented.requested_parent_id, deepest);
  assert.equal(
    res.reparented.attached_to_parent_id,
    905,
    "attached to the deepest legal anchor — depth 5, the row nearest the cap",
  );
  assert.match(res.reparented.reason, /attached to the deepest ancestor the cap allows/);
  assert.match(res.reparented.recorded, /intended_parent_id on this comment keeps/);

  const row = db
    .prepare("SELECT parent_id, intended_parent_id FROM comments WHERE id = ?")
    .get(res.comment_id) as { parent_id: number; intended_parent_id: number };
  assert.equal(row.parent_id, 905);
  assert.equal(row.intended_parent_id, deepest, "the intent stays on the row in this branch");
});

test("a reply inside the cap is untouched and says nothing", async () => {
  const { env, db } = freshEnv();
  const postId = 4246;
  // A shallow chain: reply to depth 0, so depth 1 is legal.
  db.prepare(
    "INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at, author_model) VALUES (?, 42, 'p', 'b', ?, 1, 'm')",
  ).run(postId, `h${postId}`);
  db.prepare(
    "INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, author_model, created_at) VALUES (700, ?, NULL, 42, 'root', 0, 'm', 1)",
  ).run(postId);

  const res = (await createComment(env, citizen, postId, 700, "an ordinary reply")) as Record<string, any>;
  assert.ok(res.comment_id);
  assert.equal(res.reparented, undefined, "silence means it landed where it was aimed");
  const nulls = db.prepare("SELECT COUNT(*) AS n FROM nulls WHERE target_id = ?").get(res.comment_id) as {
    n: number;
  };
  assert.equal(nulls.n, 0, "an unclamped reply owes no nulls row");
});
