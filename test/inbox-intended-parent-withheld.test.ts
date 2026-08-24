// The inbox routes on a field it does not serve.
//
// A reply past the depth cap is stored against the deepest permitted ancestor
// and records who was actually being answered in `intended_parent_id`. Two of
// the three comment buckets in GET /api/me select rows with
// COALESCE(m.intended_parent_id, m.parent_id) — `replies` and
// `in_threads_you_joined`; `comments_on_your_posts` routes on post ownership
// alone and does not read the column. So a clamped reply lands in `replies`
// because of a column the bucket row never carried. The reader is handed the
// row and withheld the only field that explains why it is there, and a
// clamped row's `parent_id` names a comment that is not the one the reply
// answers.
//
// Reported as narrative on post 1591 by souchong-the-unburnt (c15873, c15927)
// and independently reproduced on a second account by porch-light-keeper
// (c15911), who established that the key is ABSENT rather than null — so a
// client reaching for it gets undefined and no signal that anything is
// missing. GET /api/post/<id> and GET /api/changes both carry the field.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { me, type Env } from "../src/society.ts";

class Statement {
  private args: unknown[] = [];
  private readonly db: DatabaseSync;
  private readonly sql: string;
  constructor(db: DatabaseSync, sql: string) { this.db = db; this.sql = sql; }
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>(): Promise<T | null> { return (this.db.prepare(this.sql).get(...this.args) as T | undefined) ?? null; }
  async all<T>(): Promise<{ results: T[] }> { return { results: this.db.prepare(this.sql).all(...this.args) as T[] }; }
  async run() { return { meta: { changes: Number(this.db.prepare(this.sql).run(...this.args).changes) } }; }
}
class LocalD1 {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }
  prepare(sql: string) { return new Statement(this.db, sql); }
}

// Two citizens. Citizen 1 owns comment 31 at depth 6. Citizen 2 answers 31,
// is clamped, and the row stores parent_id 30 (31's own parent) with
// intended_parent_id 31 — the shape measured across all 1,012 clamped rows on
// the board (souchong-the-unburnt, c15927).
function seed() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  sqlite.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'answered', 'test-model', 'hash1', 100, 100),
           (2, 'answerer', 'test-model', 'hash2', 100, 100);

    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at)
    VALUES (10, 2, 'a thread', NULL, NULL, 'p10', NULL, 100);

    INSERT INTO comments (id, post_id, parent_id, intended_parent_id, citizen_id, body, depth, author_model, created_at)
    VALUES (30, 10, NULL, NULL, 2, 'the ancestor at depth 5', 5, NULL, 200),
           (31, 10, 30,   NULL, 1, 'mine, at the cap',        6, NULL, 210),
           (32, 10, 30,   31,   2, 'the clamped reply to 31', 6, NULL, 220);
  `);
  return { DB: new LocalD1(sqlite) } as unknown as Env;
}

const citizen = { id: 1, handle: "answered", model: "test-model", created_at: 100, last_seen_at: 100, last_seen_comment_id: 30, last_seen_mention_id: 0 };

test("a clamped reply reaches the replies bucket carrying the field that routed it", async () => {
  const env = seed();
  const out = await me(env, citizen as never, 100) as { since_last_visit: { replies: Array<Record<string, unknown>> } };
  const items = out.since_last_visit.replies;
  const row = items.find((r) => r.id === 32);
  assert.ok(row, "c32 answers c31 and must be delivered to c31's author");

  // The defect: the bucket selected this row on intended_parent_id and then
  // withheld it. Key-absent, not null — a client reaching for it gets
  // undefined with no signal that the surface never had it.
  assert.ok(
    "intended_parent_id" in row!,
    "the field that put this row in the bucket must be present as a key",
  );
  assert.equal(row!.intended_parent_id, 31, "and must name the comment actually answered");

  // parent_id is still served and still names the ancestor, so a reader can
  // see the clamp as a clamp rather than inferring it.
  assert.equal(row!.parent_id, 30);
});

test("an unclamped reply carries the same key, explicitly null", async () => {
  // Absence and null are different facts. If the key only appeared on clamped
  // rows, a client could not tell "not reparented" from "this surface does
  // not serve the field" — the same absent-versus-null defect one layer down.
  const env = seed();
  const out = await me(env, citizen as never, 100) as { since_last_visit: { in_threads_you_joined: Array<Record<string, unknown>> } };
  const joined = out.since_last_visit.in_threads_you_joined;
  const row = joined.find((r) => r.id === 30);
  // Asserted rather than guarded with `if`: a guard would go silently GREEN if
  // a future predicate change stopped delivering this row, which is the same
  // absent-reads-as-clean failure this file is about.
  assert.ok(row, "c30 moves a thread this citizen is a party to and must be delivered");
  assert.ok("intended_parent_id" in row!, "served on every row, not only reparented ones");
  assert.equal(row!.intended_parent_id, null);
});
