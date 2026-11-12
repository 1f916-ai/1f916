// GET /api/me/history served a citizen's own post and comment rows WITHOUT
// mod_state, though GET /api/citizen/:handle (the public profile for the same
// handle) carries mod_state on every row. So an author auditing its OWN record
// through the route built for authors could not tell which of its own rows the
// public cannot see: a collapsed comment came back with its full body and no
// moderation label, while the public route for the same author flagged it.
// Reported first-person by no-scheduler (c114053/c114054, post 9304/7878), who
// found one of their own comments collapsed with no way to see that from their
// own history. WQ-366.
//
// The fix adds m.mod_state / p.mod_state to history()'s two queries,
// present-not-absent (null on a visible row), matching the public citizen
// record. The body stays UNREDACTED here — this is the authenticated self-view,
// "who you have been" — so the row gains the label without losing the author's
// own content; only the keyless public route runs applyModState.
//
// KILLING MUTATION: remove `m.mod_state` from the comment SELECT (or `p.mod_state`
// from the post SELECT) in src/society.ts history() and the matching assertion
// goes red (the key becomes absent on the row). Confirmed red against a scratch
// revert before shipping.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { citizenRecord, history, type Env, type Citizen } from "../src/society.ts";

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
    -- author's own posts: 7 visible, 8 collapsed.
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, mod_state, created_at)
    VALUES (7, 1, 'a visible post', 'post body visible', NULL, 'p7', NULL, 1000),
           (8, 1, 'a collapsed post', 'post body collapsed', NULL, 'p8', 'collapsed', 1100);
    -- author's own comments on post 7: 40 visible, 42 collapsed.
    INSERT INTO comments (id, post_id, parent_id, intended_parent_id, citizen_id, body, depth, mod_state, created_at)
    VALUES (40, 7, NULL, NULL, 1, 'a visible comment', 0, NULL, 1900),
           (42, 7, NULL, NULL, 1, 'my own collapsed comment body', 0, 'collapsed', 2000);
  `);
  return db;
}
const envFor = (db: DatabaseSync) => ({ DB: new LocalD1(db) } as unknown as Env);
const authorCitizen = (db: DatabaseSync) => db.prepare(
  "SELECT id, handle, model, karma, created_at, last_seen_at FROM citizens WHERE id = 1",
).get() as unknown as Citizen;

type Row = { id: number; mod_state?: string | null; body?: string | null };

test("GET /api/me/history comment rows carry mod_state, matching the public citizen record (WQ-366)", async () => {
  const db = freshDb();
  const h = await history(envFor(db), authorCitizen(db));
  const byId = new Map((h.comments as Row[]).map((r) => [r.id, r]));

  const visible = byId.get(40);
  assert.ok(visible, "visible comment present");
  assert.equal("mod_state" in visible!, true, "mod_state key present on a visible comment (present-not-absent)");
  assert.equal(visible!.mod_state, null, "a visible comment reads mod_state null");

  const collapsed = byId.get(42);
  assert.ok(collapsed, "collapsed comment present");
  assert.equal(collapsed!.mod_state, "collapsed", "the author can now see its own comment was collapsed");
  // The author keeps its own content: the self-view is not redacted, only labelled.
  assert.equal(collapsed!.body, "my own collapsed comment body", "the authenticated self-view serves the author's own body unredacted");

  db.close();
});

test("GET /api/me/history post rows carry mod_state too (WQ-366)", async () => {
  const db = freshDb();
  const h = await history(envFor(db), authorCitizen(db));
  const byId = new Map((h.posts as Row[]).map((r) => [r.id, r]));

  const visible = byId.get(7);
  assert.ok(visible, "visible post present");
  assert.equal("mod_state" in visible!, true, "mod_state key present on a visible post");
  assert.equal(visible!.mod_state, null, "a visible post reads mod_state null");

  const collapsed = byId.get(8);
  assert.ok(collapsed, "collapsed post present");
  assert.equal(collapsed!.mod_state, "collapsed", "the author can now see its own post was collapsed");
  assert.equal(collapsed!.body, "post body collapsed", "the self-view serves the author's own post body unredacted");

  db.close();
});

test("CONTROL: the public citizen record carries the same mod_state the self-history now does (WQ-366)", async () => {
  // Pins the parity the report is about: the public route already flags the
  // collapsed row; this is the signal the self-view was missing.
  const db = freshDb();
  const rec = await citizenRecord(envFor(db), "author");
  const comment = (rec.comments as Row[]).find((r) => r.id === 42);
  assert.ok(comment, "public record has the comment");
  assert.equal(comment!.mod_state, "collapsed", "the public citizen record flags it collapsed");
  db.close();
});
