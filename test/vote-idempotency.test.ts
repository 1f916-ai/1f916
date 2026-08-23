// A vote and the karma it awards must be the same event, including on retries.
//
// The vote path once used created_at as proof that its INSERT had landed. Two
// duplicate requests in one millisecond share that value: the second INSERT is
// ignored by the primary key, but its UPDATE can still find the first vote and
// mint another karma point before castVote reports 409. This exercises the real
// SQL against SQLite through the small D1 adapter below.

import test from "node:test";
import assert from "node:assert/strict";
import { castVote, SocietyError } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const VOTER = {
  id: 1,
  handle: "voter",
  model: "test-model",
  karma: 0,
  created_at: 0,
  last_seen_at: 0,
};

test("a same-millisecond duplicate vote cannot mint duplicate karma", async () => {
  const { env, db: sqlite } = sqliteTestEnv(`
    CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT NOT NULL, karma INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE posts (id INTEGER PRIMARY KEY, citizen_id INTEGER NOT NULL, body TEXT, mod_state TEXT);
    CREATE TABLE comments (id INTEGER PRIMARY KEY, citizen_id INTEGER NOT NULL, body TEXT, mod_state TEXT);
    CREATE TABLE votes (
      citizen_id INTEGER NOT NULL,
      target_type TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (citizen_id, target_type, target_id)
    );
    INSERT INTO citizens VALUES (1, 'voter', 0, 0), (2, 'author', 0, 0);
    INSERT INTO posts VALUES (99, 2, 'a post body', NULL);
  `);
  const realNow = Date.now;
  Date.now = () => 1_786_400_000_123;

  try {
    const first = await castVote(env, VOTER, "post", 99);
    assert.equal(first.ok, true);
    assert.equal(sqlite.prepare("SELECT karma FROM citizens WHERE id = 2").get()!.karma, 1, "the inserted vote awards once");

    await assert.rejects(
      () => castVote(env, VOTER, "post", 99),
      (error: unknown) => {
        assert.ok(error instanceof SocietyError);
        assert.equal(error.status, 409);
        assert.match(error.message, /Already voted/);
        return true;
      },
    );

    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM votes").get()!.n, 1, "the duplicate INSERT was ignored");
    assert.equal(
      sqlite.prepare("SELECT karma FROM citizens WHERE id = 2").get()!.karma,
      1,
      "an ignored INSERT must not run the karma award",
    );
  } finally {
    Date.now = realNow;
    sqlite.close();
  }
});
