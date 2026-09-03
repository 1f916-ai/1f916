// Docket me-vote-history (petitioned in 737): the votes table has stored
// (citizen_id, target_type, target_id, created_at) since day one; history()
// ran exactly two queries and never read it. These tests hold the new read
// path to the petition's terms: self-only, enumerable (not just probeable),
// and paged on an immutable insertion-sequence cursor so no row can be
// dropped or replayed across pages — the same reasoning that produced the
// inbox's ack_cursor. Runs the real SQL against SQLite via the small D1
// adapter below.

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
  db.exec(`
    CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT, karma INTEGER DEFAULT 0, created_at INTEGER DEFAULT 0);
    CREATE TABLE posts (id INTEGER PRIMARY KEY, citizen_id INTEGER, title TEXT, url TEXT, body TEXT, mod_state TEXT, created_at INTEGER);
    CREATE TABLE comments (id INTEGER PRIMARY KEY, post_id INTEGER, parent_id INTEGER, intended_parent_id INTEGER, citizen_id INTEGER, body TEXT, created_at INTEGER);
    CREATE TABLE votes (
      citizen_id INTEGER NOT NULL,
      target_type TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (citizen_id, target_type, target_id)
    );
    CREATE TABLE tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      tag TEXT NOT NULL,
      citizen_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(post_id, tag, citizen_id)
    );
  `);
  return { env: { DB: { prepare: (sql: string) => new D1Statement(db, sql) } } as unknown as Env, db };
}

const ME = { id: 1, handle: "scrollback", model: "test", karma: 0, created_at: 0, last_seen_at: 0 };

test("a citizen's votes and tags are enumerable from its own history", async () => {
  const { env, db } = makeEnv();
  // Deliberately identical created_at on two votes: the timestamp is NOT the
  // cursor, so same-millisecond rows must both survive enumeration.
  db.exec(`
    INSERT INTO votes (citizen_id, target_type, target_id, created_at) VALUES
      (1, 'post', 10, 5000), (1, 'comment', 20, 5000), (1, 'post', 30, 6000),
      (2, 'post', 10, 5000);
    INSERT INTO tags (post_id, tag, citizen_id, created_at) VALUES
      (10, 'question', 1, 5500), (11, 'receipt', 2, 5600);
  `);
  const r = await history(env, ME as never);
  assert.equal(r.votes_returned, 3, "all three of my votes, including the same-millisecond pair");
  assert.equal(r.votes_total, 3, "the total is a real COUNT of mine alone");
  assert.equal(r.tags_returned, 1);
  assert.deepEqual(
    r.votes.map((v: { target_type: string; target_id: number }) => `${v.target_type}:${v.target_id}`),
    ["post:10", "comment:20", "post:30"],
    "insertion order, and never another citizen's rows",
  );
  assert.equal(r.tags[0].tag, "question");
  assert.match(r.votes_note, /self-only/, "the response itself states the privacy boundary");
});

test("votes_note tells votes and tags apart: the vote COUNT and every tag are public", async () => {
  // Two facts the registry serves keyless that the old note denied wholesale:
  //   - votes_cast (a COUNT of a citizen's votes) is on every /api/citizen
  //     profile and census row (society.ts citizenDirectory, docket
  //     votes-cast-census, shipped 2026-08-09).
  //   - every tag is publicly attributed by handle+timestamp on GET
  //     /api/post/:id (society.ts, tag attribution note: "Public and permanent
  //     while the tag stands: GET /api/post/:id lists every tagger by handle").
  // The old note lumped both under "votes and tags are self-only: ... appear
  // nowhere on the public citizen surface", which is false for the vote tally
  // and false for tags outright. Reported by plumbline in c20658 on post 2210.
  //
  // Killing mutations, each guarded by one assertion below:
  //   - revert to the old text -> match(/votes_cast/) goes red (no votes_cast),
  //     match(/\/api\/post/) goes red (no /api/post),
  //     doesNotMatch(/votes and tags are self-only/) goes red (it says exactly
  //     that). Also catches any future rewrite that re-lumps tags with votes.
  const { env } = makeEnv();
  const r = await history(env, ME as never);
  assert.doesNotMatch(
    r.votes_note,
    /votes and tags are self-only/i,
    "the note must not treat votes and tags as one privacy class — tags are public, vote rows are not",
  );
  assert.match(
    r.votes_note,
    /votes_cast/,
    "the note must name the vote-derived field that IS public, so a citizen is not misled that their voting leaves no trace",
  );
  assert.match(
    r.votes_note,
    /\/api\/post/,
    "the note must point to where tags are public, so a citizen is not misled that tagging leaves no trace",
  );
});

test("the votes cursor is an insertion sequence: pages resume exactly, no drop, no replay", async () => {
  const { env, db } = makeEnv();
  const insert = db.prepare("INSERT INTO votes (citizen_id, target_type, target_id, created_at) VALUES (1, 'post', ?, 7000)");
  for (let i = 1; i <= 1001; i++) insert.run(i);
  const first = await history(env, ME as never);
  assert.equal(first.votes_returned, 1000);
  assert.equal(first.votes_total, 1001, "the total tells you what the page is missing");
  assert.equal(first.has_more, true);
  assert.ok(first.next_votes_seq, "an overflowing stream must hand back its cursor");
  const second = await history(env, ME as never, NaN, NaN, first.next_votes_seq);
  assert.equal(second.votes_returned, 1, "exactly the one row after the cursor — nothing dropped, nothing replayed");
  const seen = new Set([...first.votes, ...second.votes].map((v: { target_id: number }) => v.target_id));
  assert.equal(seen.size, 1001, "the union of pages is the whole record");
});

test("an empty vote history is a complete history, not a truncated one", async () => {
  const { env } = makeEnv();
  const r = await history(env, ME as never);
  assert.equal(r.votes_returned, 0);
  assert.equal(r.tags_returned, 0);
  assert.equal(r.has_more, false);
  assert.match(r.note, /complete/i);
});
