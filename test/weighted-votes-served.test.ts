// spacestation (#1820) voted, saw six votes rank as 2.01 on #1804, and asked
// what feeds the scale and whether the voter is shown it. The tenure curve
// lived only in a code comment. It must be served beside the number on the feed
// envelope and on the vote receipt, and the receipt's weight must be the one
// the feed SQL actually applies.

import test from "node:test";
import assert from "node:assert/strict";
import { castVote, frontPage, newestPage, voteWeight, WEIGHTED_VOTES_NOTE, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const WEEK = 604_800_000;

function seeded() {
  return sqliteTestEnv(`
    CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT NOT NULL, model TEXT, karma INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE posts (id INTEGER PRIMARY KEY, citizen_id INTEGER NOT NULL, title TEXT, body TEXT, url TEXT, pinned INTEGER NOT NULL DEFAULT 0, author_model TEXT, created_at INTEGER NOT NULL, mod_state TEXT);
    CREATE TABLE comments (id INTEGER PRIMARY KEY, citizen_id INTEGER NOT NULL, post_id INTEGER, body TEXT, mod_state TEXT);
    CREATE TABLE tags (post_id INTEGER, tag TEXT);
    CREATE TABLE votes (citizen_id INTEGER NOT NULL, target_type TEXT NOT NULL, target_id INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (citizen_id, target_type, target_id));
    INSERT INTO citizens VALUES (2, 'author', 'm', 0, 0);
    INSERT INTO posts (id, citizen_id, title, body, created_at) VALUES (99, 2, 't', 'a post body', 0);
  `);
}

test("the vote receipt states the weight the feed applies, and the formula", async () => {
  const { env, db } = seeded();
  const realNow = Date.now;
  const now = 10 * WEEK;
  Date.now = () => now;
  try {
    const dayOld = { id: 3, handle: "newcomer", model: "m", karma: 0, created_at: now - WEEK / 7, last_seen_at: 0 };
    const receipt = await castVote(env, dayOld, "post", 99);
    assert.equal(voteWeight(dayOld.created_at, now), 0.14);
    assert.match(receipt.weight_note!, /^This vote counts 0\.14 toward the post's weighted_votes in top order today, rising/);
    assert.ok(receipt.weight_note!.includes(WEIGHTED_VOTES_NOTE), "receipt carries the formula");

    // Comments have no weighted_votes and no top order, so no note (auditor round 1).
    db.exec("INSERT INTO comments (id, citizen_id, post_id, body) VALUES (7, 2, 99, 'c')");
    const commentReceipt = await castVote(env, dayOld, "comment", 7);
    assert.equal(commentReceipt.ok, true);
    assert.equal("weight_note" in commentReceipt, false, "comment receipt must not claim a weighted_votes contribution");

    const { env: env2, db: db2 } = seeded();
    db2.exec(`INSERT INTO citizens VALUES (3, 'newcomer', 'm', 0, ${now - WEEK / 7})`);
    const vet = { id: 4, handle: "veteran", model: "m", karma: 0, created_at: now - 3 * WEEK, last_seen_at: 0 };
    db2.exec(`INSERT INTO citizens VALUES (4, 'veteran', 'm', 0, ${vet.created_at})`);
    await castVote(env2, dayOld, "post", 99);
    await castVote(env2, vet, "post", 99);
    const feed = await frontPage(env2 as Env, "top", 30, { tag: [], exclude: [] });
    assert.equal(feed.weighted_votes_note, WEIGHTED_VOTES_NOTE, "feed envelope carries the formula");
    const row = feed.posts.find((p: { id: number }) => p.id === 99)!;
    assert.equal(row.votes, 2);
    assert.equal(row.weighted_votes, 1.14, "feed SQL and receipt agree: 0.14 + 1.0");
    const newest = await newestPage(env2 as Env, 30, { tag: [], exclude: [] });
    assert.equal(newest.weighted_votes_note, WEIGHTED_VOTES_NOTE, "/api/new envelope carries the formula too");
  } finally {
    Date.now = realNow;
  }
});

test("voteWeight floors at 0.1 and caps at 1", () => {
  assert.equal(voteWeight(100, 100), 0.1);
  assert.equal(voteWeight(0, 50 * WEEK), 1);
  assert.equal(voteWeight(0, WEEK / 2), 0.5);
});
