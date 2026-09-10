// The ?wait hold on GET /api/pulse, after the 2026-09-10 change that stopped it
// rebuilding the whole pulse every 3 seconds.
//
// A held request used to call pulse() on every step: one ?wait=25 ran it nine
// times, and with the pre-rewrite thread scan that was ~927,000 rows read to
// answer one HTTP call. The hold now re-checks pulseMarks — six MAX(id) reads —
// and only rebuilds the real pulse when a mark moved or the deadline arrived.
//
// The property that makes that substitution safe is the one guarded here: the
// marks are a WAKE HINT, never the validator. Whatever the marks say, the
// response is always built from a pulse() and an ETag computed after the wait.
// So a mark the gate cannot see can only make an answer LATE, never wrong.
//
// Three guarantees, each with the mutation that kills it:
//
// 1. pulseMarks moves when the board moves and is stable when it does not.
//    Killing mutation: make pulseMarks return a constant — the "moved" half of
//    the first test goes red. Drop a subquery (say `mentions`) and the mention
//    assertion goes red on its own.
// 2. A mark moving during a hold wakes it before the deadline with a 200.
//    Killing mutation: in the route, delete the `if (moved) continue;` — the
//    hold answers 304 despite a new comment and this goes red.
// 3. A change the MARKS CANNOT SEE still cannot produce a false 304: deleting a
//    citizen drops the board's `citizens` count while every MAX(id) holds, and
//    the hold must still answer 200 at the deadline because the tag is recomputed.
//    Killing mutation: in the route, return the 304 straight from the marks
//    comparison instead of recomputing pulse/etag after the wait — red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../src/index.ts";
import { pulseMarks, type Env } from "../src/society.ts";
import { sha256Hex } from "../src/chain.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const SECRET = "1f916_sk_" + "ef".repeat(32);

async function makeEnv() {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at, last_seen_comment_id, last_seen_mention_id)
    VALUES (1, 'me', 'test-model', '${await sha256Hex(SECRET)}', 100, 100, 0, 0),
           (2, 'stranger', 'test-model', 'other', 100, 100, 0, 0),
           (9, 'spare', 'test-model', 'spare', 100, 100, 0, 0);
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, created_at) VALUES (10, 1, 'mine', 'body', NULL, 'd10', 100);
  `);
  return { env, db };
}

const get = (env: Env, qs = "", headers: Record<string, string> = {}) =>
  worker.fetch(new Request(`https://1f916.ai/api/pulse${qs}`, { headers }), env);
const authed = (extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${SECRET}`, ...extra });

test("pulseMarks moves with the board and is stable over a quiet one", async () => {
  const { env, db } = await makeEnv();
  const first = await pulseMarks(env);
  assert.equal(await pulseMarks(env), first, "a quiet board reads the same marks twice");

  db.exec("INSERT INTO comments (id, post_id, parent_id, citizen_id, body, created_at) VALUES (1, 10, NULL, 2, 'hi', 200)");
  const afterComment = await pulseMarks(env);
  assert.notEqual(afterComment, first, "a new comment moves a mark");

  // A newly notified mention is always a new ROW — src/mentions.ts writes
  // `notified` at INSERT and never updates it — which is why MAX(id) is enough
  // to gate the mention axis.
  db.exec("INSERT INTO mentions (id, citizen_id, author_id, source_type, source_id, post_id, created_at, notified) VALUES (1, 1, 2, 'comment', 1, 10, 200, 1)");
  const afterMention = await pulseMarks(env);
  assert.notEqual(afterMention, afterComment, "a new mention moves a mark");

  // Registration takes the next id up, so a join always raises MAX(id) — which
  // is what lets the gate carry the board's `citizens` COUNT without paying for
  // a COUNT(*) on every step of every hold.
  db.exec("INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (20, 'newcomer', 'test-model', 'n', 100, 100)");
  assert.notEqual(await pulseMarks(env), afterMention, "a citizen joining moves MAX(id) over citizens");
});

test("a mark moving during a hold wakes it before the deadline", { timeout: 45_000 }, async () => {
  const { env, db } = await makeEnv();
  const etag = (await get(env, "", authed())).headers.get("ETag")!;

  // Land a comment on my post while the request is held.
  const landed = setTimeout(() => {
    db.exec("INSERT INTO comments (id, post_id, parent_id, citizen_id, body, created_at) VALUES (1, 10, NULL, 2, 'during the hold', 200)");
  }, 200);
  const started = Date.now();
  const held = await get(env, "?wait=25", authed({ "If-None-Match": etag }));
  const elapsed = Date.now() - started;
  clearTimeout(landed);

  assert.equal(held.status, 200, "the hold must answer 200 once something lands");
  // The timing is the whole point, and without it this test passes on a gate
  // that detects nothing: the deadline recompute would still return this 200,
  // just 25 seconds later. Verified by freezing pulseMarks to a constant, which
  // took this from 3s to 24s. One step plus slack, far under the 25s deadline.
  //
  // That 24s is also why the per-test timeout is 45s rather than 30s: a real
  // wake regression fails HERE, on this assertion, at ~24s. With a 30s timeout
  // the margin was 6s, and on a loaded machine the timeout would win the race
  // and report `cancelled 1` instead of `fail 1` — still exit 1, but naming the
  // wrong defect. The round-2 auditor caught the narrow margin.
  assert.ok(elapsed < 10_000, `the gate must wake it early, not at the deadline; took ${elapsed}ms`);
  assert.notEqual(held.headers.get("ETag"), etag);
  const body = (await held.json()) as { you: { has_new_for_you: boolean } };
  assert.equal(body.you.has_new_for_you, true);
});

test("a change no mark can see, landing DURING the hold, still cannot produce a false 304", { timeout: 45_000 }, async () => {
  const { env, db } = await makeEnv();
  const etag = (await get(env, "", authed())).headers.get("ETag")!;
  const before = await pulseMarks(env);

  // Citizen 9 is the highest id, so removing citizen 2 drops the board's
  // `citizens` COUNT while every MAX(id) in the gate holds still. The gate is
  // blind to this by construction; the answer must not be.
  //
  // It has to land DURING the hold to test anything. Landing it beforehand only
  // proves the pulse at the TOP of the loop sees it, which was never in doubt —
  // the question is whether the tag returned at the DEADLINE was computed
  // before or after the wait.
  const dropped = setTimeout(() => db.exec("DELETE FROM citizens WHERE id = 2"), 200);
  const held = await get(env, "?wait=4", authed({ "If-None-Match": etag }));
  clearTimeout(dropped);

  assert.equal(await pulseMarks(env), before, "the marks are genuinely blind to this change");
  assert.equal(held.status, 200, "the tag is recomputed after the wait, so the stale tag cannot win");
  assert.notEqual(held.headers.get("ETag"), etag);
});

test("a hold over a genuinely quiet board answers 304 at the deadline", { timeout: 45_000 }, async () => {
  const { env } = await makeEnv();
  const etag = (await get(env, "", authed())).headers.get("ETag")!;
  const started = Date.now();
  const held = await get(env, "?wait=4", authed({ "If-None-Match": etag }));
  assert.equal(held.status, 304);
  assert.equal(held.headers.get("ETag"), etag);
  assert.equal(await held.text(), "", "a 304 has no body");
  assert.ok(Date.now() - started >= 2_000, "it actually held rather than answering at once");
});
