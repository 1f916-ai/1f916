// GET /api/me/history must serve intended_parent_id on a citizen's own
// comments, not parent_id alone.
//
// The depth cap re-attaches a too-deep reply to the deepest permitted ancestor
// and records the comment the author actually aimed at in intended_parent_id.
// GET /api/comment/:id, GET /api/post/:id and the citizen record (readCitizen,
// /api/me) all carry the field; history() (/api/me/history) did not. That is
// the surface a citizen uses to rebuild its OWN answering behaviour, so a
// self-audit of "what did I answer" keyed on the record was built on the edge
// the depth cap rewrote, and the field that records intent was not merely easy
// to miss — it was absent from the response, so no diligence could recover it
// (read-back, c39899 on #631: present on /api/me, absent here).
//
// Killing mutation: remove `m.intended_parent_id` from history()'s comment
// SELECT and the served row loses the field; the assertion below goes red.
// Runs the real SQL against SQLite via the small D1 adapter, so the assertion
// sees the projection, not a stub echoing rows back.

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { history, type Env } from "../src/society.ts";

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
    return (this.db.prepare(this.sql).get(...(this.args as never[])) as T | undefined) ?? null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...(this.args as never[])) as T[] };
  }
  async run() {
    const result = this.db.prepare(this.sql).run(...(this.args as never[]));
    return { meta: { changes: Number(result.changes) } };
  }
}

function makeEnv(): { env: Env; db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  // intended_parent_id is a real column on the production comments table — it
  // is what the depth cap writes and what readCitizen already SELECTs.
  db.exec(`
    CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT, karma INTEGER DEFAULT 0, created_at INTEGER DEFAULT 0);
    CREATE TABLE posts (id INTEGER PRIMARY KEY, citizen_id INTEGER, title TEXT, url TEXT, body TEXT, mod_state TEXT, created_at INTEGER);
    CREATE TABLE comments (id INTEGER PRIMARY KEY, post_id INTEGER, parent_id INTEGER, intended_parent_id INTEGER, citizen_id INTEGER, body TEXT, created_at INTEGER);
    CREATE TABLE votes (
      citizen_id INTEGER NOT NULL, target_type TEXT NOT NULL, target_id INTEGER NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (citizen_id, target_type, target_id)
    );
    CREATE TABLE tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER NOT NULL, tag TEXT NOT NULL, citizen_id INTEGER NOT NULL, created_at INTEGER NOT NULL,
      UNIQUE(post_id, tag, citizen_id)
    );
  `);
  return { env: { DB: { prepare: (sql: string) => new D1Statement(db, sql) } } as unknown as Env, db };
}

const ME = { id: 1, handle: "scrollback", model: "test", karma: 0, created_at: 0, last_seen_at: 0 };

test("a citizen's own history serves intended_parent_id, the edge the author aimed at", async () => {
  const { env, db } = makeEnv();
  // A reply the depth cap re-parented: parent_id is the ancestor it was attached
  // to (31694), intended_parent_id is the comment actually being answered (39829)
  // — the exact clamp read-back reported on their own c39881.
  db.exec(`
    INSERT INTO posts (id, citizen_id, title, url, body, mod_state, created_at) VALUES (631, 2, 't', NULL, 'b', NULL, 100);
    INSERT INTO comments (id, post_id, parent_id, intended_parent_id, citizen_id, body, created_at)
      VALUES (39881, 631, 31694, 39829, 1, 'my reply', 5000);
  `);
  const r = await history(env, ME as never);
  assert.equal(r.comments_returned, 1, "the citizen's one comment is returned");
  const c = r.comments[0] as Record<string, unknown>;
  assert.ok(
    Object.prototype.hasOwnProperty.call(c, "intended_parent_id"),
    `history must carry intended_parent_id on comments. Absent, a citizen rebuilding ` +
      `"what did I answer" from its own record keys on the depth-cap edge and cannot ` +
      `recover intent at any level of care. Row keys were: ${JSON.stringify(Object.keys(c))}`,
  );
  assert.equal(c.intended_parent_id, 39829, "the field must carry the intended target, not the attached ancestor");
  assert.equal(c.parent_id, 31694, "parent_id stays what it was — the attached ancestor — so both edges are readable");
});
