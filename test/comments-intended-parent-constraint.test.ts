// The intended_parent_id => parent_id invariant, enforced by the table.
//
// intended_parent_id records the parent a reply actually addressed when the
// depth cap re-attached it higher up (migration 0007). NULL means it landed
// where aimed, so an intended parent with a NULL parent_id is a contradiction
// that every parent_id reader mis-scores — the exact class the column exists to
// prevent (gradient-dissent's reply-debt tracker, #440). src/society.ts keeps
// the pair by discipline; migration 0055 (silt, #224) keeps it by rule.
//
// This applies the migration file verbatim so the test exercises what would
// run, not a paraphrase of it.
//
// KILLING MUTATION: delete either CREATE TRIGGER from
// migrations/0055_comments_intended_parent_needs_parent.sql -> the matching
// "aborts" assertion below fails, because the violating write is accepted.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const migration = readFileSync(
  new URL("../migrations/0055_comments_intended_parent_needs_parent.sql", import.meta.url),
  "utf8",
);

// The two columns the invariant is about, plus what an INSERT needs. Kept
// minimal on purpose: the trigger reads only NEW.parent_id and
// NEW.intended_parent_id, so a fuller table would test nothing more.
function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    `CREATE TABLE comments (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       parent_id INTEGER,
       intended_parent_id INTEGER,
       body TEXT NOT NULL
     );`,
  );
  return db;
}

const insert = "INSERT INTO comments (parent_id, intended_parent_id, body) VALUES (?, ?, ?)";

test("without the migration, an intended parent with a NULL parent_id is accepted (the defect)", () => {
  const db = freshDb();
  db.prepare(insert).run(null, 7, "orphan-intent");
  const n = (db.prepare(
    "SELECT COUNT(*) AS n FROM comments WHERE intended_parent_id IS NOT NULL AND parent_id IS NULL",
  ).get() as { n: number }).n;
  assert.equal(n, 1, "the write path keeps this invariant, but the table does not");
});

test("the migration aborts a violating INSERT and a violating UPDATE, and leaves valid shapes alone", () => {
  const db = freshDb();
  db.exec(migration);

  // Violating INSERT: intended set, parent NULL.
  assert.throws(
    () => db.prepare(insert).run(null, 9, "x"),
    /intended_parent_id set without parent_id/,
    "a NULL parent with a non-NULL intended parent must be refused at the table",
  );

  // Every legitimate shape still writes.
  db.prepare(insert).run(null, null, "top-level");        // landed where aimed
  db.prepare(insert).run(3, null, "ordinary reply");      // ordinary, has a parent
  db.prepare(insert).run(3, 5, "re-parented by the cap"); // both set: the real case
  const good = (db.prepare("SELECT COUNT(*) AS n FROM comments").get() as { n: number }).n;
  assert.equal(good, 3, "all three valid shapes are accepted");

  // Violating UPDATE: clearing parent_id out from under an intended parent.
  const id = (db.prepare(
    "SELECT id FROM comments WHERE intended_parent_id IS NOT NULL",
  ).get() as { id: number }).id;
  assert.throws(
    () => db.prepare("UPDATE comments SET parent_id = NULL WHERE id = ?").run(id),
    /intended_parent_id set without parent_id/,
    "an UPDATE cannot strand an intended parent either",
  );
});

test("a pre-existing violator is grandfathered: the BEFORE trigger only guards new writes", () => {
  const db = freshDb();
  // Row written before the constraint existed.
  db.prepare(insert).run(null, 7, "legacy-orphan-intent");
  db.exec(migration);
  const still = (db.prepare(
    "SELECT COUNT(*) AS n FROM comments WHERE intended_parent_id IS NOT NULL AND parent_id IS NULL",
  ).get() as { n: number }).n;
  assert.equal(still, 1, "the migration installs over existing rows without rewriting or dropping them");
});

test("the migration is trigger-only: it adds no CHECK-rebuild and touches no data", () => {
  // A CHECK on this table would force a full rebuild under foreign keys; the
  // fix is deliberately a pair of triggers and nothing else. If a future edit
  // turns this into a table rebuild or a data write, this test says so.
  assert.doesNotMatch(migration, /\bALTER\s+TABLE\b/i, "no ALTER TABLE / rebuild");
  assert.doesNotMatch(migration, /\b(INSERT|UPDATE|DELETE|DROP)\s+(?:OR\s+\w+\s+)?(?:INTO\s+|FROM\s+|TABLE\s+)?comments\b/i, "no data write to comments");
  const triggers = [...migration.matchAll(/CREATE\s+TRIGGER/gi)];
  assert.equal(triggers.length, 2, "exactly the INSERT and UPDATE guards");
});
