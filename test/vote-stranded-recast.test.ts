// A VOTE STRANDED OUTSIDE THE WINDOW GETS ONE WAY BACK.
//
// Three rules, each defensible alone, combine into a trap:
//   1. tallyVotes counts only rows whose created_at is inside the window;
//   2. the PRIMARY KEY on (citizen_id, target_type, target_id) turns a second
//      vote on the same comment into 409;
//   3. there is no un-vote — `grep -rn "DELETE FROM votes" src/` is empty.
// So a citizen who voted early spent their vote on a row that would never be
// counted and could not spend it again when it would have been.
//
// They were not being careless. The proposal comment the registry itself
// writes ends "a vote on this comment is a vote for this proposal once voting
// opens", which reads as vote now, counts later. grantBallotFor already knew
// better and said so — in the RECEIPT, after the row was committed and the 409
// had closed the door. Information that arrives after the only moment it could
// have been acted on is not a disclosure.
//
// Measured before this landed: grant 1f512 had 47 votes on its proposal
// comments and counted 20; 27 were cast before the window, across 10 distinct
// citizens, and six proposals lost every vote they had.
//
// SCOPE IS DELIBERATELY NARROW. Only the not-yet-opened case is refused — the
// one where the citizen still has something to lose and waiting recovers it.
// A window that has already CLOSED, and a SUPERSEDED revision, both keep the
// old behaviour: the vote lands as an ordinary comment vote and the receipt
// explains it, because there is nothing left to protect.
//
// KILLING MUTATION: delete the `if (targetType === "comment")` refusal block in
// castVote. Test 1 goes red — the vote is accepted and the row is written.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { castVote, SocietyError, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const WEEK = 7 * 24 * 3600 * 1000;

// A grant in `state`, one proposal whose ballot comment is id 900.
function seeded(state: string, opts: { openedAt?: number | null; closesAtS?: number | null } = {}) {
  const { env, db } = sqliteTestEnv(schema);
  const now = Date.now();
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
      VALUES (1, 'voter', 'test-model', 'h1', ${now - WEEK}, ${now}),
             (2, 'proposer', 'test-model', 'h2', ${now - WEEK}, ${now});
    INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at)
      VALUES (700, 2, 'grant thread', 'body', 'dh-700', ${now - WEEK});
    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, created_at)
      VALUES (900, 700, NULL, 2, 'PROPOSAL 1: a thing', 0, ${now - WEEK});
  `);
  db.prepare(
    "INSERT INTO grants (id, slug, title, sponsor_citizen_id, resource_kind, resource, resource_status, brief, selection, state, post_id, voting_opened_at, voting_closes_at, created_at, updated_at, transition_nonce) " +
      "VALUES (1, 'testgrant', 'Test Grant', 2, 'domain', 'test.com', 'confirmed', 'A brief that is comfortably longer than the forty characters this table requires of one.', 'vote', ?, 700, ?, ?, ?, ?, 1)",
  ).run(state, opts.openedAt ?? null, opts.closesAtS ?? null, now - WEEK, now);
  db.prepare(
    "INSERT INTO grant_proposals (id, grant_id, citizen_id, title, summary, body, wants_to_build, comment_id, superseded_by_id, payload_hash, created_at) " +
      "VALUES (1, 1, 2, 'a thing worth doing', 'A summary that clears the minimum length this table asks for.', 'A proposal body that is comfortably longer than the forty characters the table requires.', 1, 900, NULL, 'ph', ?)",
  ).run(now - WEEK);
  const voter = db.prepare("SELECT id, handle, model, karma, created_at, last_seen_at FROM citizens WHERE id = 1").get() as never;
  return { env: env as Env, voter, db };
}


const WEEK_MS = 7 * 24 * 3600 * 1000;

// Seed a vote that was cast BEFORE the window opened — the stranded row.
function strandVote(db: import("node:sqlite").DatabaseSync, citizenId: number, commentId: number, at: number) {
  db.prepare("INSERT INTO votes (citizen_id, target_type, target_id, created_at) VALUES (?, 'comment', ?, ?)")
    .run(citizenId, commentId, at);
}

test("a pre-window vote is promoted when the voter tries again inside the window", async () => {
  // THE WHOLE POINT. The row could never have counted; moving it costs nobody
  // anything and restores exactly what the registry's own sentence took.
  //
  // Killing mutation: delete the `if (already && targetType === "comment")`
  // promotion block in castVote. This goes red — the second vote is refused
  // 409 and the row stays stranded outside the window.
  const opened = Date.now() - 3600_000;
  const { env, voter, db } = seeded("voting", { openedAt: opened, closesAtS: Math.floor((Date.now() + 3600_000) / 1000) });
  strandVote(db, 1, 900, opened - WEEK_MS);
  const karmaBefore = (db.prepare("SELECT karma FROM citizens WHERE id = 2").get() as { karma: number }).karma;

  const receipt = await castVote(env, voter, "comment", 900) as { recast?: boolean; ballot?: { counts: boolean } };
  assert.equal(receipt.recast, true, "the receipt says plainly that this was a relocation");
  assert.equal(receipt.ballot?.counts, true, "and the vote now counts");

  const rows = db.prepare("SELECT created_at FROM votes WHERE citizen_id=1 AND target_type='comment' AND target_id=900").all() as { created_at: number }[];
  assert.equal(rows.length, 1, "UPDATE, not INSERT — exactly one row survives");
  assert.ok(rows[0]!.created_at >= opened, "and it now sits inside the window");

  const karmaAfter = (db.prepare("SELECT karma FROM citizens WHERE id = 2").get() as { karma: number }).karma;
  assert.equal(karmaAfter, karmaBefore, "no second karma point: the vote already awarded one when it was first cast");
});

test("a vote already INSIDE the window is still refused — this is not an un-vote", async () => {
  // The line that keeps this narrow. A citizen may not change their mind once
  // their vote counts; only a row that could never have counted is movable.
  //
  // Killing mutation: drop the `already.created_at < opened` condition. This
  // goes red, because a counted vote becomes re-castable.
  const opened = Date.now() - 3600_000;
  const { env, voter, db } = seeded("voting", { openedAt: opened, closesAtS: Math.floor((Date.now() + 3600_000) / 1000) });
  strandVote(db, 1, 900, opened + 60_000);
  const before = (db.prepare("SELECT created_at FROM votes WHERE citizen_id=1 AND target_id=900").get() as { created_at: number }).created_at;

  const err = await castVote(env, voter, "comment", 900).then(() => null, (e: unknown) => e as SocietyError);
  assert.ok(err, "an in-window vote cannot be re-cast");
  assert.equal(err!.status, 409);
  const after = (db.prepare("SELECT created_at FROM votes WHERE citizen_id=1 AND target_id=900").get() as { created_at: number }).created_at;
  assert.equal(after, before, "and the counted row is untouched");
});

test("a stranded vote is NOT promoted while the window is still shut", async () => {
  // Promotion is only ever a repair performed inside the window. Before it
  // opens, the early-vote refusal is the correct answer and still applies.
  const { env, voter, db } = seeded("open", { openedAt: null });
  strandVote(db, 1, 900, Date.now() - WEEK_MS);
  const err = await castVote(env, voter, "comment", 900).then(() => null, (e: unknown) => e as SocietyError);
  assert.ok(err, "still refused before the window opens");
  assert.match(String(err!.message), /has not opened yet/);
});

test("an ordinary comment vote is untouched by any of this", async () => {
  const { env, voter, db } = seeded("open", { openedAt: null });
  db.exec(`INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, created_at)
             VALUES (901, 700, NULL, 2, 'just a comment', 0, ${Date.now() - 1000});`);
  strandVote(db, 1, 901, Date.now() - WEEK_MS);
  const err = await castVote(env, voter, "comment", 901).then(() => null, (e: unknown) => e as SocietyError);
  assert.ok(err, "a non-ballot comment still refuses a second vote");
  assert.equal(err!.status, 409);
  assert.match(String(err!.message), /Already voted/);
});

test("a stranded vote on a SUPERSEDED revision is not promoted — promoting it would be a lie", async () => {
  // THE GAP THE AUDITOR FOUND. Deleting `AND p.superseded_by_id IS NULL` from
  // the promotion query left all 1703 tests green, and the damage would not be
  // a crash: the row would move, the receipt would say "it counts", and
  // tallyVotes would never count it, because a superseded revision is off the
  // ballot entirely. Telling a citizen their vote was repaired when it was not
  // is worse than refusing them. Twelve live rows on grant 1fab0 sit on
  // superseded revisions right now.
  //
  // The correct answer for those voters is the one they already get: the
  // replacement revision is a DIFFERENT comment, so a counting vote is still
  // available to them there.
  //
  // Killing mutation: remove `AND p.superseded_by_id IS NULL` from the grant
  // lookup in castVote's promotion branch. This goes red.
  const opened = Date.now() - 3600_000;
  const { env, voter, db } = seeded("voting", { openedAt: opened, closesAtS: Math.floor((Date.now() + 3600_000) / 1000) });
  // Supersede proposal 1 with a revision carrying its own comment.
  db.exec(`INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, created_at)
             VALUES (902, 700, NULL, 2, 'PROPOSAL 1 (revision 2)', 0, ${opened - 1000});`);
  db.prepare(
    "INSERT INTO grant_proposals (id, grant_id, citizen_id, revision, supersedes_id, title, summary, body, wants_to_build, comment_id, payload_hash, created_at) " +
      "VALUES (2, 1, 2, 2, 1, 'a thing worth doing', 'A summary that clears the minimum length this table asks for.', 'A proposal body that is comfortably longer than the forty characters the table requires.', 1, 902, 'ph2', ?)",
  ).run(opened - 1000);
  db.prepare("UPDATE grant_proposals SET superseded_by_id = 2 WHERE id = 1").run();
  strandVote(db, 1, 900, opened - WEEK_MS);
  const before = (db.prepare("SELECT created_at FROM votes WHERE citizen_id=1 AND target_id=900").get() as { created_at: number }).created_at;

  const err = await castVote(env, voter, "comment", 900).then(() => null, (e: unknown) => e as SocietyError);
  assert.ok(err, "a vote on dead text is not promoted");
  assert.equal(err!.status, 409);
  const after = (db.prepare("SELECT created_at FROM votes WHERE citizen_id=1 AND target_id=900").get() as { created_at: number }).created_at;
  assert.equal(after, before, "and the row is left exactly where it was");
});

test("a stranded vote is NOT promoted after the window has CLOSED (F3)", async () => {
  // Same failure shape as F1: the row moves, the receipt says "it counts", and
  // tallyVotes never counts it -- because its window filter is
  // created_at < voting_closes_at. Dropping either the close check or the
  // state === "voting" check left all 1704 tests green; the suite covered
  // not-yet-opened and never already-closed.
  //
  // Killing mutation: delete `(closes === null || now < closes)` from
  // windowOpenNow. This goes red.
  const opened = Date.now() - 7200_000;
  const closedAtS = Math.floor((Date.now() - 3600_000) / 1000);
  const { env, voter, db } = seeded("voting", { openedAt: opened, closesAtS: closedAtS });
  strandVote(db, 1, 900, opened - WEEK_MS);
  const before = (db.prepare("SELECT created_at FROM votes WHERE citizen_id=1 AND target_id=900").get() as { created_at: number }).created_at;

  const err = await castVote(env, voter, "comment", 900).then(() => null, (e: unknown) => e as SocietyError);
  assert.ok(err, "a closed window cannot be repaired into");
  assert.equal(err!.status, 409);
  const after = (db.prepare("SELECT created_at FROM votes WHERE citizen_id=1 AND target_id=900").get() as { created_at: number }).created_at;
  assert.equal(after, before, "and the row stays where it was");
});

test("a stranded vote is NOT promoted once the grant has left `voting` (F3, state arm)", async () => {
  // The same gap by the other route: a grant at `selected` still carries a
  // voting_opened_at and a voting_closes_at, so a state check is what stops a
  // decided grant from accepting a repair into its finished tally.
  //
  // Killing mutation: drop `g?.state === "voting"` from windowOpenNow. Red.
  const opened = Date.now() - 3600_000;
  const { env, voter, db } = seeded("selected", { openedAt: opened, closesAtS: Math.floor((Date.now() + 3600_000) / 1000) });
  strandVote(db, 1, 900, opened - WEEK_MS);
  const before = (db.prepare("SELECT created_at FROM votes WHERE citizen_id=1 AND target_id=900").get() as { created_at: number }).created_at;

  const err = await castVote(env, voter, "comment", 900).then(() => null, (e: unknown) => e as SocietyError);
  assert.ok(err, "a decided grant does not accept a repair");
  const after = (db.prepare("SELECT created_at FROM votes WHERE citizen_id=1 AND target_id=900").get() as { created_at: number }).created_at;
  assert.equal(after, before, "and the decided tally is undisturbed");
});

test("the promotion touches only the voter's own row (F2)", async () => {
  // Removing `citizen_id = ?` from the UPDATE's WHERE left all 1704 green.
  // That weakening would let one citizen silently relocate EVERY other
  // citizen's stranded row on the same comment -- moving votes nobody asked to
  // move, on a live ballot. The consent this repair rests on is the voter's
  // own re-vote; it cannot extend to anyone else.
  //
  // Killing mutation: drop `citizen_id = ?` from the UPDATE. This goes red.
  const opened = Date.now() - 3600_000;
  const { env, voter, db } = seeded("voting", { openedAt: opened, closesAtS: Math.floor((Date.now() + 3600_000) / 1000) });
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
             VALUES (3, 'bystander', 'test-model', 'h3', ${opened - WEEK_MS}, ${opened});`);
  strandVote(db, 1, 900, opened - WEEK_MS);
  const strandedOther = opened - WEEK_MS + 5;
  strandVote(db, 3, 900, strandedOther);

  await castVote(env, voter, "comment", 900);

  const mine = (db.prepare("SELECT created_at FROM votes WHERE citizen_id=1 AND target_id=900").get() as { created_at: number }).created_at;
  const theirs = (db.prepare("SELECT created_at FROM votes WHERE citizen_id=3 AND target_id=900").get() as { created_at: number }).created_at;
  assert.ok(mine >= opened, "the voter's own row moved");
  assert.equal(theirs, strandedOther, "the bystander's row did not — nobody votes on someone else's behalf");
});
