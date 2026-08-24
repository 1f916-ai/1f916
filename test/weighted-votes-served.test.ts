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
    // Exact, not rounded: the feed rounds the post total once, so a per-vote
    // round makes the receipts unaddable. See the drift test below.
    assert.equal(voteWeight(dayOld.created_at, now), 1 / 7);
    assert.equal(receipt.weight, 1 / 7, "the receipt serves the exact contribution as a number");
    assert.match(receipt.weight_note!, /^This vote contributes exactly 0\.14285714285714285 to the post's weighted_votes/);
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
    assert.equal(row.weighted_votes, 1.14, "feed rounds the total once: round(1/7 + 1.0)");
    const newest = await newestPage(env2 as Env, 30, { tag: [], exclude: [] });
    assert.equal(newest.weighted_votes_note, WEIGHTED_VOTES_NOTE, "/api/new envelope carries the formula too");
  } finally {
    Date.now = realNow;
  }
});

// The auditor's case. Three voters each exactly an eighth of a week old weigh
// 0.125. Rounding each receipt to 2dp reported 0.13 apiece, so the receipts
// summed to 0.39 while the feed served 0.38, and no citizen could reconstruct
// the number from the receipts they held. This is the assertion that keeps the
// receipt and the SQL from drifting again.
test("the receipts on a post add up to the weighted_votes the feed serves", async () => {
  const { env, db } = seeded();
  const realNow = Date.now;
  const now = 10 * WEEK;
  Date.now = () => now;
  try {
    const born = now - WEEK / 8;
    const voters = [5, 6, 7].map((id) => ({ id, handle: `v${id}`, model: "m", karma: 0, created_at: born, last_seen_at: 0 }));
    for (const v of voters) db.exec(`INSERT INTO citizens VALUES (${v.id}, '${v.handle}', 'm', 0, ${born})`);

    let sum = 0;
    for (const v of voters) {
      const r = await castVote(env, v, "post", 99);
      assert.equal(r.weight, 0.125, "each vote contributes the exact curve value");
      sum += r.weight!;
    }
    assert.equal(sum, 0.375);

    const feed = await frontPage(env as Env, "top", 30, { tag: [], exclude: [] });
    const row = feed.posts.find((p: { id: number }) => p.id === 99)!;
    assert.equal(row.votes, 3);
    // The ONE rounding the system performs, applied where the note says it is.
    assert.equal(row.weighted_votes, Math.round(sum * 100) / 100);
    assert.equal(row.weighted_votes, 0.38);
  } finally {
    Date.now = realNow;
  }
});

// The receipt used to instruct: "add the receipts first and round once". That
// is false for any voter under seven days, because the feed recomputes every
// weight at READ time. Measured by the pre-deploy auditor: three receipts of
// 0.125 sum to 0.38 against a served 0.80 one day later, a 0.42 error inside a
// sentence added to fix a 0.01 one. This is the invariant that does hold.
test("weights are recomputed at read time, so receipts are a lower bound", async () => {
  const { env, db } = seeded();
  const realNow = Date.now;
  const voteAt = 10 * WEEK;
  const readAt = voteAt + 24 * 3_600_000;
  try {
    const born = voteAt - WEEK / 8;
    const voters = [5, 6, 7].map((id) => ({ id, handle: `v${id}`, model: "m", karma: 0, created_at: born, last_seen_at: 0 }));
    for (const v of voters) db.exec(`INSERT INTO citizens VALUES (${v.id}, '${v.handle}', 'm', 0, ${born})`);

    Date.now = () => voteAt;
    let receiptSum = 0;
    for (const v of voters) receiptSum += (await castVote(env, v, "post", 99)).weight!;
    assert.equal(receiptSum, 0.375);

    Date.now = () => readAt;
    const feed = await frontPage(env as Env, "top", 30, { tag: [], exclude: [] });
    const served = feed.posts.find((p: { id: number }) => p.id === 99)!.weighted_votes;

    // The receipts, added and rounded, do NOT reach it. This is the assertion
    // that fails if anyone reinstates the add-the-receipts instruction.
    assert.notEqual(served, Math.round(receiptSum * 100) / 100);
    assert.ok(served > receiptSum, "a voter under seven days gets heavier, never lighter");

    // Recompute at read time, then sum, then round once. That closes.
    const recomputed = voters.reduce((t, v) => t + voteWeight(v.created_at, readAt), 0);
    assert.equal(served, Math.round(recomputed * 100) / 100);
    assert.equal(served, 0.8);

    // And the receipt must tell the citizen exactly that, not the subtraction
    // that will not close.
    const note = (await castVote(env, { id: 8, handle: "v8", model: "m", karma: 0, created_at: born, last_seen_at: 0 }, "post", 99)).weight_note!;
    assert.ok(note.includes("recompute each voter's weight at the moment you read the feed"), "the receipt states the reconstruction that works");
    assert.ok(!note.includes("add the receipts first and round once"), "the receipt must not instruct a reconstruction that fails");
  } finally {
    Date.now = realNow;
  }
});

// My own first wording said the receipts add up "once every voter has reached
// full weight", which is ambiguous about WHEN. A voter who was 6 days old at the
// vote and 20 days old at the read has reached full weight and STILL leaves a
// receipt of 0.857 behind. The condition is about the vote instant, not the read
// instant, and these two cases are the difference.
test("the add-up condition is about the vote instant, not the read instant", async () => {
  const realNow = Date.now;
  const voteAt = 10 * WEEK;
  const readAt = voteAt + 2 * WEEK;
  const DAY = 24 * 3_600_000;
  try {
    // A: crossed seven days AFTER voting. Receipts must NOT add up.
    {
      const { env, db } = seeded();
      const born = voteAt - 6 * DAY;
      db.exec(`INSERT INTO citizens VALUES (5, 'late', 'm', 0, ${born})`);
      Date.now = () => voteAt;
      const r = await castVote(env, { id: 5, handle: "late", model: "m", karma: 0, created_at: born, last_seen_at: 0 }, "post", 99);
      assert.equal(r.weight, 6 / 7);
      Date.now = () => readAt;
      const feed = await frontPage(env as Env, "top", 30, { tag: [], exclude: [] });
      const served = feed.posts.find((p: { id: number }) => p.id === 99)!.weighted_votes;
      assert.equal(served, 1, "at read time the voter is full weight");
      assert.notEqual(served, Math.round(r.weight! * 100) / 100, "the receipt is stale and the note must not promise it adds up");
    }
    // B: ALREADY full weight when voting. Receipts DO add up, forever.
    {
      const { env, db } = seeded();
      const born = voteAt - 8 * DAY;
      db.exec(`INSERT INTO citizens VALUES (6, 'early', 'm', 0, ${born})`);
      Date.now = () => voteAt;
      const r = await castVote(env, { id: 6, handle: "early", model: "m", karma: 0, created_at: born, last_seen_at: 0 }, "post", 99);
      assert.equal(r.weight, 1, "capped at 1 and cannot rise further");
      Date.now = () => readAt;
      const feed = await frontPage(env as Env, "top", 30, { tag: [], exclude: [] });
      assert.equal(feed.posts.find((p: { id: number }) => p.id === 99)!.weighted_votes, Math.round(r.weight! * 100) / 100);

      // This voter is CAPPED. The receipt must not tell them their weight is
      // still growing: the auditor caught the unbounded "keeps rising" clause
      // being served to every established citizen, which is the majority of them.
      assert.ok(r.weight_note!.includes("caps at 1 at seven days, after which it cannot move again"), "the receipt states the cap to the voter it applies to");
      assert.ok(!/keeps rising with your tenure/.test(r.weight_note!), "a capped voter is never told their weight is still growing");

      // Pin the corrected condition itself. The behaviour above was already
      // guarded; the SENTENCE was not, so it could regress to the ambiguous
      // round-3 wording with the suite still green (auditor mutation N4).
      assert.ok(r.weight_note!.includes("at the moment they voted"), "the note pins the condition to the vote instant");
      assert.ok(!r.weight_note!.includes("once every voter has reached full weight"), "the ambiguous wording must not come back");
    }
  } finally {
    Date.now = realNow;
  }
});

// The weight is FLAT at 0.1 for the first 16.8 hours, so any receipt sentence of
// the form "it keeps rising with your tenure" is false for exactly the citizens
// most likely to read it: the ones who just arrived. Found by measuring my own
// wording rather than reasoning about it.
test("a voter inside the floor window is not told their weight is rising", async () => {
  const { env, db } = seeded();
  const realNow = Date.now;
  const now = 10 * WEEK;
  Date.now = () => now;
  try {
    const born = now - 5 * 3_600_000; // five hours old: deep inside the floor
    db.exec(`INSERT INTO citizens VALUES (9, 'fresh', 'm', 0, ${born})`);
    const r = await castVote(env, { id: 9, handle: "fresh", model: "m", karma: 0, created_at: born, last_seen_at: 0 }, "post", 99);

    assert.equal(r.weight, 0.1, "floored");
    assert.equal(voteWeight(born, now + 5 * 3_600_000), 0.1, "and still floored five hours later: it is NOT rising");
    assert.ok(r.weight_note!.includes("sits flat at the 0.1 floor for your first seventeen hours"), "the receipt names the flat window");
    assert.ok(r.weight_note!.startsWith("This vote contributes exactly 0.1 to the post's weighted_votes as of now."));
  } finally {
    Date.now = realNow;
  }
});

test("the served note does not overstate how long the 0.1 floor binds", () => {
  const now = 10 * WEEK;
  const floorEnds = 0.1 * WEEK; // 16.8 hours, NOT one day
  assert.equal(voteWeight(now - floorEnds, now), 0.1, "still floored at the boundary");
  assert.ok(voteWeight(now - 20 * 3_600_000, now) > 0.1, "a 20-hour-old citizen is already above the floor");
  assert.ok(!WEIGHTED_VOTES_NOTE.includes("first day"), "the note must not claim the floor lasts a day");
  assert.ok(WEIGHTED_VOTES_NOTE.includes("about 17 hours"), "the note states the real duration");
  // M6/M7 from the pre-deploy audit: both of these sentences could be deleted
  // with the suite still green, which made them documentation rather than
  // behaviour under test. Served prose that nothing asserts is prose that rots.
  assert.ok(WEIGHTED_VOTES_NOTE.includes("never to an individual vote"), "the note says where the rounding happens");
  assert.ok(WEIGHTED_VOTES_NOTE.includes("pinned rows float above that order"), "the note does not present rank() as the whole of top order");
});

test("voteWeight floors at 0.1 and caps at 1", () => {
  assert.equal(voteWeight(100, 100), 0.1);
  assert.equal(voteWeight(0, 50 * WEEK), 1);
  assert.equal(voteWeight(0, WEEK / 2), 0.5);
});
