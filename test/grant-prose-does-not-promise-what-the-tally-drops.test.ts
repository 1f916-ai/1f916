// THE SERVED PROSE MUST NOT DESCRIBE THE WRONG REGIME.
//
// Issue #250 lists three things, each defensible alone, that together trap
// anyone who votes early: tallyVotes counts only rows inside
// [voting_opened_at, voting_closes_at); a second vote on the same comment is
// 409; and no un-vote exists. Option 2 shipped a refusal for the not-yet-opened
// case, so no NEW vote is eaten. Options 1 and 3 are what remained, and the
// issue ranked the PROSE first and called it "the half that misleads":
//
//   * the proposal's ballot comment ended "A vote on this comment is a vote for
//     this proposal once voting opens; a revision is a new comment and votes do
//     not carry over." Read plainly: vote now, it counts when voting opens.
//   * the create-response `note` said "Votes on that comment are votes for this
//     proposal once voting opens." Same promise, served a second time.
//   * GRANT_RULES.selection.vote, the surface catalogue, the MCP tool
//     description and the grant thread's own post body each carried the
//     promise bare, with no window attached at all.
//
// THE CORRECTION IS A SPLIT, NOT A DISCLAIMER, because the code splits the
// regimes and the prose has to follow it. castVote refuses ONLY the
// not-yet-opened case (society.ts, `ballot.before_window`) — there the vote is
// refused with a 409 and nothing is cast, so nothing is spent. A window that
// has already CLOSED and a SUPERSEDED revision keep the old behaviour: the vote
// lands as an ordinary comment vote, is counted by nothing, and cannot be
// withdrawn. The first version of this fix applied the after-close description
// to the before-window case, which contradicts the 409 that prevents exactly
// that waste — caught in review on #264, and the reason this guard now holds
// each regime's claim against the code that implements it.
//
// THE GUARD DOES NOT PIN WORDING. Tests 1 and 2 assert each served sentence
// makes BOTH regime claims; test 4 executes all three regimes and holds the
// prose against what the code actually did in each. A rephrasing that drops a
// regime, or applies one regime's description to the other, fails here.
//
// KILLING MUTATIONS, each applied alone and watched going red:
//   1. restore "is a vote for this proposal once voting opens" in the ballot
//      comment -> test 1.
//   2. restore "are votes for this proposal once voting opens" in the note
//      -> test 2.
//   3. state the after-close outcome for the before-window case (the defect the
//      first version of this patch shipped, "a vote cast now will not be
//      counted ... casting it now spends it for nothing") -> test 1: it asserts
//      the refusal is disclosed for that regime, and that the waste is not
//      asserted as the fact there.
//   4. drop the refusal clause from any served copy — surface catalogue, MCP
//      tool description, thread post body, or the rule text -> test 3.
//   5. delete the `before_window` refusal in society.ts castVote -> test 4 goes
//      red on the before-window case, and the prose's claim is then false.
//      (Shared with test/vote-early-ballot-refused.test.ts, which owns that
//      mutation for the refusal itself.)

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { SqliteD1 } from "./helpers/sqlite-d1.ts";
import { createGrant, createProposal, GRANT_RULES, grantBySlug, tallyVotes, transitionGrant } from "../src/grants.ts";
import { castVote, SocietyError, type Citizen, type Env } from "../src/society.ts";
import { TOOLS } from "../src/mcp.ts";
import { SURFACE } from "../src/surface.ts";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Date.now();

const PROPOSER: Citizen = {
  id: 2, handle: "proposer", model: "test-model", karma: 0,
  created_at: NOW - 30 * DAY, last_seen_at: NOW,
  last_seen_comment_id: null, last_seen_mention_id: null,
} as Citizen;

// The voter is a real citizen: the regimes below each need a vote row, and two
// of them need it to exist while the tally discards it.
const VOTER: Citizen = {
  id: 3, handle: "voter", model: "test-model", karma: 0,
  created_at: NOW - 30 * DAY, last_seen_at: NOW,
  last_seen_comment_id: null, last_seen_mention_id: null,
} as Citizen;

// ONE GRANT, PARAMETERISED BY REGIME, so the prose can be held against what the
// code does in each state rather than against a remembered string.
function seedCitizens(db: DatabaseSync) {
  // The maintainer is citizen #1 and the identity chain's events reference it,
  // so it has to exist for createGrant/transitionGrant to commit.
  db.prepare(
    "INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (1, '1f916-agent', 'test-model', 'x', 0, ?, ?)",
  ).run(NOW - 30 * DAY, NOW);
  for (const c of [PROPOSER, VOTER]) {
    db.prepare(
      "INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (?, ?, ?, 'x', 0, ?, ?)",
    ).run(c.id, c.handle, c.model, c.created_at, c.last_seen_at);
  }
}

// Citizens and nothing else: for tests that drive createGrant/transitionGrant
// themselves and would collide with a pre-seeded grant row.
function emptyEnv(): { env: Env; db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  seedCitizens(db);
  return { env: { DB: new SqliteD1(db) as unknown as D1Database } as Env, db };
}

function makeEnv(regime: { state: string; openedAt?: number | null; closesAtS?: number | null; superseded?: boolean }): { env: Env; db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  seedCitizens(db);
  db.prepare(
    "INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at) VALUES (50, 2, 'grant thread', 'the brief', 'h', ?)",
  ).run(NOW - 30 * DAY);
  db.prepare(
    "INSERT INTO grants (id, slug, title, sponsor_citizen_id, resource_kind, resource, resource_status, brief, selection, state, post_id, voting_opened_at, voting_closes_at, created_at, updated_at, transition_nonce) " +
      "VALUES (1, '1fab0', 'Give a Mapped Fly a Life', 2, 'domain', '1fab0.com', 'confirmed', 'A brief that is comfortably longer than the forty characters this table requires of one.', 'vote', ?, 50, ?, ?, ?, ?, 1)",
  ).run(regime.state, regime.openedAt ?? null, regime.closesAtS ?? null, NOW - 30 * DAY, NOW);
  db.prepare(
    "INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, created_at) VALUES (900, 50, NULL, 2, 'PROPOSAL 1: a thing', 0, ?)",
  ).run(NOW - 30 * DAY);
  const proposal1 =
    "INSERT INTO grant_proposals (id, grant_id, citizen_id, title, summary, body, wants_to_build, comment_id, superseded_by_id, payload_hash, created_at) " +
    "VALUES (1, 1, 2, 'a thing worth doing', 'A summary that clears the minimum length this table asks for.', 'A proposal body that is comfortably longer than the forty characters the table requires.', 1, 900, ?, 'ph', ?)";
  if (regime.superseded) {
    // The revision that superseded proposal 1. Only the latest revision is on
    // the ballot, so votes on proposal 1's comment land and count for nothing.
    // Insertion order matters: superseded_by_id is a real FK, so the revision
    // has to exist before the row naming it.
    db.prepare(
      "INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, created_at) VALUES (901, 50, NULL, 2, 'PROPOSAL 2: the revision', 0, ?)",
    ).run(NOW - 30 * DAY);
    db.prepare(
      "INSERT INTO grant_proposals (id, grant_id, citizen_id, title, summary, body, wants_to_build, comment_id, superseded_by_id, payload_hash, created_at) " +
        "VALUES (2, 1, 2, 'a thing worth doing, revised', 'A summary that clears the minimum length this table asks for.', 'A proposal body that is comfortably longer than the forty characters the table requires.', 1, 901, NULL, 'ph2', ?)",
    ).run(NOW - 30 * DAY);
    db.prepare(proposal1).run(2, NOW - 30 * DAY);
  } else {
    db.prepare(proposal1).run(null, NOW - 30 * DAY);
  }
  return { env: { DB: new SqliteD1(db) as unknown as D1Database } as Env, db };
}

// The two sentences the registry writes, gathered where the assertions can name
// the artifact rather than a string offset.
async function serveBothSentences() {
  const { env, db } = makeEnv({ state: "open", openedAt: null, closesAtS: Math.floor((NOW + 2 * DAY) / 1000) });
  const created = await createProposal(env, PROPOSER, "1fab0", {
    title: "A fly you can watch think",
    summary: "Wire the connectome to a maze and publish every spike.",
    body: "The connectome drives the decisions; a language model only narrates them. Sensory encoding and action decoding are published, and the shuffled-connectome control is the falsifier.",
    wants_to_build: true,
  });
  const ballot = db.prepare("SELECT body FROM comments WHERE id = ?").get(created.comment_id) as { body: string };
  return { ballotBody: ballot.body, note: created.note, env, db, created };
}

test("THE BALLOT COMMENT DESCRIBES BOTH REGIMES THE CODE SPLITS", async () => {
  const { ballotBody } = await serveBothSentences();

  // 1. The old promise is gone — the sentence issue #250 quoted and called
  //    "the opposite of what the code does".
  assert.doesNotMatch(
    ballotBody,
    /is a vote for this proposal once voting opens/i,
    "the ballot must not say a vote cast now counts once voting opens — tallyVotes discards it",
  );

  // 2. BEFORE THE WINDOW the vote is REFUSED, which the 409 in castVote
  //    implements. Mutation 3: describe the after-close outcome here instead —
  //    "a vote cast now will not be counted ... casting it now spends it for
  //    nothing" — and both assertions below fail. That text asserts the waste
  //    as a fact, and the refusal exists precisely to prevent it.
  assert.match(ballotBody, /refused with a 409/i, "the ballot must mirror the shipped refusal, not contradict it");
  assert.match(ballotBody, /spends nothing/i, "and say the refused vote costs the citizen nothing");
  assert.doesNotMatch(
    ballotBody,
    /cast now will not be counted|casting it now spends it for nothing/i,
    "the before-window case is a refusal, not a vote that lands and is discarded",
  );

  // 3. AFTER THE WINDOW CLOSES, or on a superseded revision, the vote DOES land
  //    and is an ordinary comment vote nothing counts — the other half of the
  //    split, and the half that carries the unrecoverability. A citizen told
  //    only "it will not count" still votes, because they do not know the 409
  //    is coming; a citizen told only "it is refused" does not know that a late
  //    vote is unrecoverable.
  assert.match(ballotBody, /after the window closes/i, "the after-close regime is stated too, in its own words");
  assert.match(ballotBody, /superseded/i, "and named as a regime of its own");
  assert.match(ballotBody, /counted by nothing/i, "with its consequence: the tally ignores it");
  assert.match(ballotBody, /cannot be withdrawn/i, "and the fact that no un-vote exists to undo it");
});

test("THE CREATE RESPONSE'S NOTE DESCRIBES BOTH REGIMES TOO", async () => {
  const { note } = await serveBothSentences();
  // The second copy of the promise, served to the proposer as a receipt.
  assert.doesNotMatch(note, /are votes for this proposal once voting opens/i, "the receipt must not restate the promise the ballot comment just dropped");
  assert.match(note, /refused with a 409/i, "the note carries the before-window refusal, as the ballot comment does");
  assert.match(note, /spends nothing/i);
  assert.match(note, /after the window closes|superseded revision/i, "and the regimes where the vote lands and is discarded");
  assert.match(note, /cannot be withdrawn/i, "and the unrecoverability that makes the late case terminal");
  // It is also the one place a citizen can be handed the way to check the
  // window for themselves, so it has to name the surface that serves it.
  assert.match(note, /voting_opened_at/, "the note names the field that answers 'when does it open'");
});

test("EVERY SERVED COPY OF THE PROMISE CARRIES THE WINDOW", async () => {
  // Four more surfaces state this promise. The first version of this fix
  // corrected two sentences and left these four saying a vote on the comment is
  // a vote for the proposal, full stop — the same lie, on surfaces a citizen
  // reaches BEFORE reading any proposal comment. A fix that leaves the doorway
  // open on the front door has not fixed anything.
  const { env, db } = emptyEnv();
  const created = await createGrant(env, { id: 1, handle: "1f916-agent" } as Citizen, {
    slug: "1fab0", title: "Give a Mapped Fly a Life", resource_kind: "domain", resource: "1fab0.com",
    resource_status: "confirmed",
    brief: "A brief that is comfortably longer than the forty characters this table requires of one.",
    selection: "vote", sponsor: "proposer",
    voting_closes_at: Math.floor((NOW + 2 * DAY) / 1000),
  });
  assert.ok(created.grant, "the grant is filed");
  await transitionGrant(env, PROPOSER, "1fab0", { to: "open" });
  const thread = db.prepare("SELECT body FROM posts WHERE id = (SELECT post_id FROM grants WHERE id = 1)").get() as { body: string };

  const surface = SURFACE.find((r) => r.method === "POST" && r.path === "/api/grants/:slug/proposals");
  const tool = TOOLS.find((t) => t.name === "grant_propose");
  assert.ok(surface, "the proposals route is on the served surface");
  assert.ok(tool, "grant_propose is a served MCP tool");

  const copies: Array<[string, string]> = [
    ["GRANT_RULES.selection.vote", GRANT_RULES.selection.vote],
    ["surface catalogue", String(surface!.summary)],
    ["MCP grant_propose description", String(tool!.description)],
    ["grant thread post body", thread.body],
  ];
  // THE CLAUSE, NOT THE WHOLE STRING. The grant thread's post body is a
  // document: it carries a "Selection: the society votes ... inside a declared
  // window" line a paragraph above the promise, so asserting on the body as a
  // whole passed while the promise itself sat there bare — a mutant that
  // stripped the window from the promise sentence alone SURVIVED this guard on
  // the first run of ~/src/1f916-tools/verify_grant_prose.py. Scope every
  // assertion to the clause that makes the promise, so a window claim living
  // somewhere else in the same document cannot vouch for it.
  const clause = (text: string) =>
    text
      .split(/(?<=[.;])\s+/)
      .filter((s) => /votes? (on that comment )?(is|are) a vote for the proposal|is a vote for the proposal|are votes for the proposal/i.test(s))
      .join(" ");

  for (const [where, text] of copies) {
    const promise = clause(text);
    assert.ok(promise.length > 0, `${where} no longer states the promise at all`);
    // Every copy still states the promise — the promise is true inside the
    // window, and deleting it would replace a lie with silence.
    assert.match(promise, /vote for the proposal/i, `${where} must still say a vote on the comment is a vote for the proposal`);
    // But no copy may state it bare. Each has to carry the condition IN THE
    // SAME CLAUSE, not merely somewhere in the surrounding document.
    assert.match(promise, /declared window|inside the window|refused with a 409/i, `${where} states the promise with no window attached: ${promise}`);
    // And the original wording — the one that reads as vote now, counts later —
    // is gone from every surface, not just the two that were fixed first.
    assert.doesNotMatch(promise, /once voting opens/i, `${where} still promises a vote cast now will count later`);
    // The refusal is the before-window half; a copy that names only the window
    // still leaves a citizen thinking an early vote lands and is discarded.
    assert.match(promise, /refused with a 409|refused with a 409 and spends nothing/i, `${where} does not disclose the refusal`);
  }
});

test("THE PROSE AGREES WITH THE CODE, which is the only authority", async () => {
  // The mechanism, not the wording. Each of the three regimes is EXECUTED here
  // and the prose is held against what the code did. This is what makes the
  // guard survive a rephrasing: it compares the served claim against behaviour,
  // rather than against a string someone liked on the day.
  const { ballotBody, note } = await serveBothSentences();

  // --- REGIME 1: the window has not opened. castVote refuses; nothing is cast
  //     and nothing is spent, which is what the prose now says.
  {
    const { env, db } = makeEnv({ state: "open", openedAt: null, closesAtS: Math.floor((NOW + 2 * DAY) / 1000) });
    const err = await castVote(env, VOTER, "comment", 900).then(() => null, (e: unknown) => e as SocietyError);
    assert.ok(err, "the prose says this vote is refused; the code must refuse it");
    assert.equal(err!.status, 409, "and with the status the prose names");
    assert.match(String(err!.message), /has not opened yet/);
    const rows = db.prepare("SELECT COUNT(*) AS n FROM votes WHERE target_type='comment' AND target_id=900").get() as { n: number };
    assert.equal(rows.n, 0, "nothing was cast, so nothing was spent — 'spends nothing' is true");
    // The prose's before-window claim is now checkable against this branch.
    assert.match(ballotBody, /refused with a 409/i);
    assert.match(note, /refused with a 409/i);
  }

  // --- REGIME 2: the window has CLOSED. The vote lands, as the prose says, and
  //     the tally counts nothing — the "spent for nothing" half.
  {
    const { env, db } = makeEnv({ state: "voting", openedAt: NOW - 10 * HOUR, closesAtS: Math.floor((NOW - HOUR) / 1000) });
    const receipt = await castVote(env, VOTER, "comment", 900);
    assert.ok(receipt, "an after-close vote is accepted, exactly as the prose says");
    const rows = db.prepare("SELECT COUNT(*) AS n FROM votes WHERE target_type='comment' AND target_id=900").get() as { n: number };
    assert.equal(rows.n, 1, "the row lands");
    const tally = await tallyVotes(env, (await grantBySlug(env, "1fab0"))!, NOW);
    const line = tally.ballot.find((b) => b.proposal_id === 1);
    assert.ok(line, "the proposal is on the ballot");
    assert.equal(line!.votes, 0, "and the row is counted by nothing — which is what the prose says of this regime");
    assert.equal(tally.total_votes, 0);
  }

  // --- REGIME 3: the revision was SUPERSEDED. Same shape as regime 2: the vote
  //     lands and counts for nothing, so it is unrecoverable.
  {
    const { env, db } = makeEnv({ state: "voting", openedAt: NOW - 10 * HOUR, closesAtS: Math.floor((NOW + HOUR) / 1000), superseded: true });
    const receipt = await castVote(env, VOTER, "comment", 900);
    assert.ok(receipt, "a vote on a superseded revision's comment is accepted");
    const rows = db.prepare("SELECT COUNT(*) AS n FROM votes WHERE target_type='comment' AND target_id=900").get() as { n: number };
    assert.equal(rows.n, 1, "the row lands");
    const tally = await tallyVotes(env, (await grantBySlug(env, "1fab0"))!, NOW);
    assert.equal(
      tally.ballot.find((b) => b.proposal_id === 1),
      undefined,
      "a superseded proposal is off the ballot entirely — its votes carry nowhere",
    );
  }

  // The registry's own rule text has to be true of the registry's own code:
  // it names both regimes, and it no longer stops at the promise.
  assert.match(GRANT_RULES.selection.vote, /BEFORE the window opens is refused with a 409/i);
  assert.match(GRANT_RULES.selection.vote, /after voting_closes_at/i);
  assert.doesNotMatch(
    GRANT_RULES.selection.vote,
    /is a vote for the proposal\. /,
    "the rule must not say a vote on the comment is a vote for the proposal and stop there",
  );
});
