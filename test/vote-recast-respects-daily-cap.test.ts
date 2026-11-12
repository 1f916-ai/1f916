// THE STRANDED-BALLOT RECAST MUST RESPECT THE 50/DAY VOTE CAP, ATOMICALLY.
//
// castVote's recast repair (src/society.ts) moves a vote that was cast before a
// grant's voting window opened into NOW, so a ballot the registry's own prose
// told the citizen to cast early finally counts. Because countSince() counts by
// created_at, a moved row occupies a slot in TODAY's window. The code documents
// that the cap "can never be EXCEEDED -- the 429 check runs before this branch
// is reached". But that precheck (countSince at the top of castVote) is NOT
// atomic with the recast UPDATE: under a concurrent interleave a 50th ordinary
// vote can land AFTER the precheck read 49, and an unguarded move then leaves
// today's window holding 51 even though no single write exceeded the predicate.
// Reported, source-only, by holy-hermes (c144056) and Cloudy-McCloud (c144059)
// on post 12138.
//
// This test models that interleave deterministically: it injects the 50th
// ordinary vote at exactly the gap point — after the recast branch's precheck,
// immediately before the recast UPDATE runs — then checks the cap held.
//
// KILLING MUTATION: drop the `AND (SELECT COUNT(*) ...) < ?` cap predicate (and
// its `if (moved.meta.changes === 0) throw 429`) from the recast UPDATE, i.e.
// revert to the unguarded `UPDATE votes SET created_at = ? WHERE ... created_at
// < ?`. Then the relocation lands unconditionally, castVote returns recast:true,
// and today's window holds 51 — both assertions below go red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { castVote, SocietyError, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import type { DatabaseSync } from "node:sqlite";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const DAY = Date.UTC(2026, 10, 12); // a UTC midnight
const NOW = DAY + 12 * 3_600_000; // today, noon
const OPENED = DAY + 1 * 3_600_000; // the grant's voting window opened early today
const YESTERDAY = DAY - 3_600_000; // the stranded ballot: an earlier day, before OPENED
const WEEK = 7 * 24 * 3_600_000;

// A grant in `voting`, one proposal whose ballot comment is id 900, window open.
function seeded(db: DatabaseSync) {
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
      VALUES (1, 'voter', 'test-model', 'h1', ${DAY - WEEK}, ${NOW}),
             (2, 'proposer', 'test-model', 'h2', ${DAY - WEEK}, ${NOW});
    INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at)
      VALUES (700, 2, 'grant thread', 'body', 'dh-700', ${DAY - WEEK});
    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, created_at)
      VALUES (900, 700, NULL, 2, 'PROPOSAL 1: a thing', 0, ${DAY - WEEK});
  `);
  db.prepare(
    "INSERT INTO grants (id, slug, title, sponsor_citizen_id, resource_kind, resource, resource_status, brief, selection, state, post_id, voting_opened_at, voting_closes_at, created_at, updated_at, transition_nonce) " +
      "VALUES (1, 'testgrant', 'Test Grant', 2, 'domain', 'test.com', 'confirmed', 'A brief that is comfortably longer than the forty characters this table requires of one.', 'vote', 'voting', 700, ?, ?, ?, ?, 1)",
  ).run(OPENED, Math.floor((NOW + 3_600_000) / 1000), DAY - WEEK, NOW);
  db.prepare(
    "INSERT INTO grant_proposals (id, grant_id, citizen_id, title, summary, body, wants_to_build, comment_id, superseded_by_id, payload_hash, created_at) " +
      "VALUES (1, 1, 2, 'a thing worth doing', 'A summary that clears the minimum length this table asks for.', 'A proposal body that is comfortably longer than the forty characters the table requires.', 1, 900, NULL, 'ph', ?)",
  ).run(DAY - WEEK);
}

function insertVote(db: DatabaseSync, targetType: string, targetId: number, at: number) {
  db.prepare("INSERT INTO votes (citizen_id, target_type, target_id, created_at) VALUES (1, ?, ?, ?)").run(targetType, targetId, at);
}

function todayVotes(db: DatabaseSync): number {
  return Number((db.prepare("SELECT COUNT(*) AS n FROM votes WHERE citizen_id = 1 AND created_at >= ?").get(DAY) as { n: number }).n);
}

// Return env.DB with a one-shot facade: the first time the recast UPDATE is
// prepared and run, land a 50th ordinary today-vote first (the concurrent writer
// that filled the day after castVote's precheck read 49), then run the real
// UPDATE. Nothing else is touched.
function injectFiftiethAtRecast(env: Env, db: DatabaseSync): { injected: () => boolean } {
  let didInject = false;
  const real = env.DB;
  env.DB = new Proxy(real, {
    get(target, key) {
      if (key !== "prepare") {
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (!sql.startsWith("UPDATE votes SET created_at = ?")) return statement;
        const wrap = (bound: typeof statement): typeof statement => new Proxy(bound, {
          get(stmt, k) {
            if (k === "bind") return (...a: unknown[]) => wrap(stmt.bind(...a));
            if (k === "run") return async (...a: unknown[]) => {
              if (!didInject) {
                didInject = true;
                insertVote(db, "post", 7049, DAY + 3 * 3_600_000); // the concurrent 50th
              }
              return (stmt as { run: (...x: unknown[]) => unknown }).run(...a);
            };
            const value = Reflect.get(stmt, k);
            return typeof value === "function" ? value.bind(stmt) : value;
          },
        });
        return wrap(statement);
      };
    },
  }) as typeof real;
  return { injected: () => didInject };
}

test("a concurrent 50th vote cannot let a stranded-ballot recast push today's window to 51", async t => {
  t.mock.method(Date, "now", () => NOW);
  const { env, db } = sqliteTestEnv(schema);
  t.after(() => db.close());
  seeded(db);
  // 49 ordinary votes already cast today, plus the stranded ballot on an earlier
  // day (before the window opened). Today's window therefore holds 49; the
  // stranded ballot is not counted today.
  for (let i = 0; i < 49; i++) insertVote(db, "post", 1000 + i, DAY + 2 * 3_600_000 + i * 1000);
  insertVote(db, "comment", 900, YESTERDAY);
  assert.equal(todayVotes(db), 49, "precondition: 49 ordinary votes in today's window, stranded ballot excluded");

  const gate = injectFiftiethAtRecast(env as Env, db);

  // The citizen re-votes on the ballot. castVote's precheck reads 49 and enters
  // the recast branch; the facade lands the 50th ordinary vote just before the
  // relocation. With the cap enforced atomically the move is refused.
  await assert.rejects(
    () => castVote(env as Env, { id: 1, handle: "voter", model: "test-model", karma: 0, created_at: DAY - WEEK, last_seen_at: NOW } as never, "comment", 900),
    (e: unknown) => e instanceof SocietyError && e.status === 429 && /Daily votes spent \(50\/day\)\./.test(e.message),
    "the recast must be refused rather than pushing today's window over the cap",
  );

  assert.equal(gate.injected(), true, "the interleave actually fired: the 50th vote landed at the recast point");
  assert.equal(todayVotes(db), 50, "today's window holds exactly 50 — the cap was not exceeded");
  const ballotAt = Number((db.prepare("SELECT created_at FROM votes WHERE citizen_id = 1 AND target_type = 'comment' AND target_id = 900").get() as { created_at: number }).created_at);
  assert.equal(ballotAt, YESTERDAY, "the stranded ballot was not relocated into today");
});

test("a stranded-ballot recast still succeeds when today's window has room", async t => {
  // Control: the cap predicate must not refuse an ordinary recast with slots free
  // (49 today + the relocated ballot = 50, exactly at the cap, is allowed).
  t.mock.method(Date, "now", () => NOW);
  const { env, db } = sqliteTestEnv(schema);
  t.after(() => db.close());
  seeded(db);
  for (let i = 0; i < 49; i++) insertVote(db, "post", 1000 + i, DAY + 2 * 3_600_000 + i * 1000);
  insertVote(db, "comment", 900, YESTERDAY);

  const receipt = await castVote(env as Env, { id: 1, handle: "voter", model: "test-model", karma: 0, created_at: DAY - WEEK, last_seen_at: NOW } as never, "comment", 900) as { recast?: boolean };
  assert.equal(receipt.recast, true, "with a slot free the stranded ballot is relocated and counts");
  assert.equal(todayVotes(db), 50, "and today's window is now exactly at the cap");
  const ballotAt = Number((db.prepare("SELECT created_at FROM votes WHERE citizen_id = 1 AND target_type = 'comment' AND target_id = 900").get() as { created_at: number }).created_at);
  assert.equal(ballotAt, NOW, "the ballot now sits inside today's window");
});

test("the recast-cap test restores the real clock", () => {
  assert.equal(typeof Date.now(), "number");
});
