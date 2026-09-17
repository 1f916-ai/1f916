// A VOTE CAST BEFORE THE WINDOW OPENS IS REFUSED, NOT EATEN.
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

test("voting before the window opens is refused, and no vote row is written", async () => {
  const { env, voter, db } = seeded("open", { openedAt: null });
  const err = await castVote(env, voter, "comment", 900).then(
    () => null,
    (e: unknown) => e as SocietyError,
  );
  assert.ok(err, "the vote must be refused, not accepted");
  assert.equal((err as SocietyError).status, 409);
  const msg = String((err as SocietyError).message);
  assert.match(msg, /has not opened yet/);
  assert.match(msg, /cannot be cast twice/, "the refusal must say WHY waiting matters");
  assert.match(msg, /cannot be withdrawn/, "and that the vote is unrecoverable");
  assert.match(msg, /testgrant/, "and name the grant so the citizen can look up the window");
  // THE POINT: the trap is that the row survives to block a later real vote.
  const row = db.prepare("SELECT COUNT(*) AS n FROM votes WHERE target_type='comment' AND target_id=900").get() as { n: number };
  assert.equal(row.n, 0, "nothing may be written — a written row is exactly what locks the citizen out");
});

test("voting while the window is open is unaffected", async () => {
  const { env, voter, db } = seeded("voting", { openedAt: Date.now() - 1000, closesAtS: Math.floor((Date.now() + 3600_000) / 1000) });
  await castVote(env, voter, "comment", 900);
  const row = db.prepare("SELECT COUNT(*) AS n FROM votes WHERE target_type='comment' AND target_id=900").get() as { n: number };
  assert.equal(row.n, 1, "an in-window vote still lands");
});

test("a comment that is not a ballot at all is unaffected", async () => {
  const { env, voter, db } = seeded("open", { openedAt: null });
  db.exec(`INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, created_at)
             VALUES (901, 700, NULL, 2, 'just a comment', 0, ${Date.now() - 1000});`);
  await castVote(env, voter, "comment", 901);
  const row = db.prepare("SELECT COUNT(*) AS n FROM votes WHERE target_type='comment' AND target_id=901").get() as { n: number };
  assert.equal(row.n, 1, "ordinary comments are not touched by the ballot guard");
});

test("a CLOSED window still accepts the vote — narrow scope, on purpose", async () => {
  // Nothing is recoverable by waiting here, so the old behaviour stands: the
  // vote lands as an ordinary comment vote and the receipt explains it.
  const { env, voter, db } = seeded("voting", { openedAt: Date.now() - 10_000, closesAtS: Math.floor((Date.now() - 5000) / 1000) });
  await castVote(env, voter, "comment", 900);
  const row = db.prepare("SELECT COUNT(*) AS n FROM votes WHERE target_type='comment' AND target_id=900").get() as { n: number };
  assert.equal(row.n, 1, "a closed window is not the case this guard exists for");
});
