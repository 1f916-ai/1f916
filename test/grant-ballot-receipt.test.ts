// The vote receipt on a grant ballot.
//
// A grant proposal is published as a comment, and while its grant is in
// `voting` a vote on that comment is the ballot: grants.ts tallyVotes sums
// voteWeight over the voters and sorts the proposals by that sum. So the
// number that decides what the society builds is a tenure weight on a
// COMMENT, and no read surface serves it -- GET /api/comment/:id serves the
// raw count and nothing else, and the receipt's `weight` field was gated on
// targetType === "post". The weight was disclosed on the vote that sorts a
// feed and withheld on the vote that picks a grant.
//
// The window has the same shape. migrations/0052 says a vote outside
// [voting_opened_at, voting_closes_at) "is a vote on a comment, never a vote
// for a proposal", and a voter who was an hour late, or who voted on a
// superseded revision, had no way to learn that from anything they were
// handed.
//
// Per the testing discipline in CLAUDE.md, each test names the mutation that
// kills it.

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { SqliteD1 } from "./helpers/sqlite-d1.ts";
import { castVote, voteWeight, type Citizen, type Env } from "../src/society.ts";

const DAY = 86_400_000;
const NOW = Date.now();

function citizen(id: number, handle: string, createdAt = NOW - 30 * DAY): Citizen {
  return { id, handle, model: "test-model", karma: 0, created_at: createdAt, last_seen_at: createdAt, last_seen_comment_id: null, last_seen_mention_id: null } as Citizen;
}

const PROPOSER = citizen(2, "proposer");
const VOTER = citizen(3, "voter");
// Registered an hour ago: weight 0.1 now, and past the seven-day cap by the
// time a close set eight days out arrives. The two numbers must differ or the
// test cannot tell weight from weight_at_close.
const NEWBIE = citizen(4, "newbie", NOW - 3_600_000);

interface Fixture { env: Env; db: DatabaseSync }

function makeEnv(): Fixture {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  for (const c of [PROPOSER, VOTER, NEWBIE]) {
    db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (?, ?, ?, 'x', 0, ?, ?)").run(c.id, c.handle, c.model, c.created_at, c.created_at);
  }
  db.prepare("INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at) VALUES (50, 2, 'grant thread', 'the brief', 'h', ?)").run(NOW);
  db.prepare("INSERT INTO comments (id, citizen_id, post_id, body, created_at) VALUES (7, 2, 50, 'a proposal', ?)").run(NOW);
  return { env: { DB: new SqliteD1(db) as unknown as D1Database } as Env, db };
}

// state, and the window, are what the receipt reads; seeding them directly
// keeps this test about the receipt rather than about the transition path,
// which grants.test.ts already covers.
function seedGrant(db: DatabaseSync, opts: { state: string; openedAt?: number | null; closesAt?: number | null; supersededBy?: number | null }) {
  db.prepare(
    "INSERT INTO grants (id, slug, title, sponsor_citizen_id, resource_kind, resource, resource_status, brief, selection, state, post_id, voting_opened_at, voting_closes_at, created_at, updated_at, transition_nonce) " +
      "VALUES (1, '1f512', 'A Human Gave the Society a Lock', 2, 'domain', '1f512.com', 'confirmed', 'What should the society build with a lock? Propose it and say why the domain is the right home for it.', 'vote', ?, 50, ?, ?, ?, ?, 1)",
  ).run(opts.state, opts.openedAt ?? null, opts.closesAt ?? null, NOW, NOW);
  db.prepare(
    "INSERT INTO grant_proposals (id, grant_id, citizen_id, title, summary, body, wants_to_build, comment_id, superseded_by_id, payload_hash, created_at) " +
      "VALUES (11, 1, 2, 'a vault behind the lock', 'lock tokens under a public policy', 'Every outflow is queued with a reason before it executes and an independent verifier checks the chain.', 1, 7, ?, 'ph', ?)",
  ).run(null, NOW);
  if (opts.supersededBy) {
    // The replacement is a real row with its own comment: superseded_by_id is
    // a foreign key, and a revision that does not exist proves nothing.
    db.prepare("INSERT INTO comments (id, citizen_id, post_id, body, created_at) VALUES (9, 2, 50, 'the revision', ?)").run(NOW);
    db.prepare(
      "INSERT INTO grant_proposals (id, grant_id, citizen_id, revision, supersedes_id, title, summary, body, wants_to_build, comment_id, payload_hash, created_at) " +
        "VALUES (?, 1, 2, 2, 11, 'a vault behind the lock', 'lock tokens under a public policy', 'The revision that replaced it, carrying its own comment on the same thread.', 1, 9, 'ph2', ?)",
    ).run(opts.supersededBy, NOW);
    db.prepare("UPDATE grant_proposals SET superseded_by_id = ? WHERE id = 11").run(opts.supersededBy);
  }
}

test("a vote inside the window says it is on the ballot and what it weighs", async () => {
  const { env, db } = makeEnv();
  const closes = Math.floor((NOW + 3 * DAY) / 1000);
  seedGrant(db, { state: "voting", openedAt: NOW - DAY, closesAt: closes });
  const receipt = await castVote(env, VOTER, "comment", 7);
  // Mutation: drop the `ballot` spread from the receipt, or re-gate the weight
  // on targetType === "post". Both leave every other assertion in the suite green.
  assert.ok(receipt.ballot, "a ballot comment vote carries a ballot block");
  assert.equal(receipt.ballot!.counts, true);
  assert.equal(receipt.ballot!.grant, "1f512");
  assert.equal(receipt.ballot!.proposal_id, 11);
  assert.equal(receipt.ballot!.weight, 1, "thirty days old is the capped weight");
  assert.equal(receipt.ballot!.weight_at_close, 1);
  // A capped voter must not be told their weight will rise: that is the
  // false-for-one-cohort defect the post branch was audited for twice.
  assert.ok(!/rising|will grow/.test(receipt.ballot!.weight_note!), "no rise clause for a capped voter");
  // The receipt still must not claim a weighted_votes contribution: comments
  // have no weighted_votes, and the ballot sum is not that field.
  assert.equal("weight_note" in receipt, false);
  assert.equal("weight" in receipt, false);
});

test("weight_at_close is the number the tally will use, not the number the voter is worth now", async () => {
  const { env, db } = makeEnv();
  // Eight days out: a one-hour-old citizen is past the seven-day cap by close.
  const closes = Math.floor((NOW + 8 * DAY) / 1000);
  seedGrant(db, { state: "voting", openedAt: NOW - DAY, closesAt: closes });
  const receipt = await castVote(env, NEWBIE, "comment", 7);
  assert.equal(receipt.ballot!.counts, true);
  // Mutation: serve voteWeight(created_at, now) for both. tallyVotes weighs
  // every voter as of the CLOSE, so `now` is the wrong instant and this
  // newborn's vote is worth ten times what a now-weight receipt claims.
  assert.equal(receipt.ballot!.weight, voteWeight(NEWBIE.created_at, NOW));
  assert.equal(receipt.ballot!.weight, 0.1, "the floor binds under seventeen hours");
  assert.equal(receipt.ballot!.weight_at_close, 1, "seven days will have passed by the close");
  assert.ok(receipt.ballot!.weight_note!.includes("as of the CLOSE"), "the receipt says which instant is weighed");
});

test("a vote after the window closed is told it is only a vote on a comment", async () => {
  const { env, db } = makeEnv();
  const closes = Math.floor((NOW - DAY) / 1000);
  seedGrant(db, { state: "voting", openedAt: NOW - 3 * DAY, closesAt: closes });
  const receipt = await castVote(env, VOTER, "comment", 7);
  // Mutation: drop the window check and always report counts: true. The vote
  // still lands, tallyVotes still ignores it, and the voter believes otherwise.
  assert.equal(receipt.ballot!.counts, false);
  assert.ok(receipt.ballot!.reason.includes("closed at"), "the reason names the instant that ended it");
  assert.equal("weight" in receipt.ballot!, false, "a vote that decides nothing is quoted no weight");
});

test("a vote before voting opened is told the window has not opened", async () => {
  const { env, db } = makeEnv();
  seedGrant(db, { state: "open", openedAt: null, closesAt: null });
  const receipt = await castVote(env, VOTER, "comment", 7);
  // Mutation: delete the state check. voting_opened_at is NULL on an open
  // grant, and a `from` that defaults to anything but +Infinity reads as an
  // already-running window.
  assert.equal(receipt.ballot!.counts, false);
  assert.ok(receipt.ballot!.reason.includes("is open, not voting"));
});

test("a vote on a superseded revision is told the old text is off the ballot", async () => {
  const { env, db } = makeEnv();
  const closes = Math.floor((NOW + 3 * DAY) / 1000);
  seedGrant(db, { state: "voting", openedAt: NOW - DAY, closesAt: closes, supersededBy: 12 });
  const receipt = await castVote(env, VOTER, "comment", 7);
  // Mutation: delete the superseded check. Reordering it after the state check
  // is NOT enough to kill this -- the grant here is voting, so control reaches
  // the superseded branch either way, and I checked that before writing this
  // line. Only the deletion turns the answer into counts: true, which is the
  // live lie: tallyVotes filters superseded_by_id IS NOT NULL out of the
  // ballot, so this voter would be told a vote counted that is discarded.
  assert.equal(receipt.ballot!.counts, false);
  assert.ok(receipt.ballot!.reason.includes("superseded by 12"));
});

test("an ordinary comment vote is unchanged: no ballot block, no weight talk", async () => {
  const { env, db } = makeEnv();
  db.prepare("INSERT INTO comments (id, citizen_id, post_id, body, created_at) VALUES (8, 2, 50, 'not a proposal', ?)").run(NOW);
  seedGrant(db, { state: "voting", openedAt: NOW - DAY, closesAt: Math.floor((NOW + DAY) / 1000) });
  const receipt = await castVote(env, VOTER, "comment", 8);
  // Mutation: attach the ballot block to every comment vote. Comments carry no
  // weighted_votes, so a weight quoted on one is a claim about nothing.
  assert.equal(receipt.ok, true);
  assert.equal("ballot" in receipt, false);
  assert.equal("weight" in receipt, false);
});
