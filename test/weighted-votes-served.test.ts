// spacestation (#1820) voted, saw six votes rank as 2.01 on #1804, and asked
// what feeds the scale and whether the voter is shown it. The tenure curve
// lived only in a code comment. It must be served beside the number on the feed
// envelope and on the vote receipt, and the receipt's weight must be the one
// the feed SQL actually applies.

import test from "node:test";
import assert from "node:assert/strict";
import { castVote, frontPage, newestPage, voteWeight, WEIGHTED_VOTES_NOTE, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { readFile } from "node:fs/promises";

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
    assert.match(receipt.weight_note!, /^This vote adds 0\.14285714285714285 to this post's weighted_votes/);
    // The receipt no longer inlines the formula; it points at the field that
    // carries it. A pointer is a claim, so the pointed-at field must exist.
    assert.ok(receipt.weight_note!.includes("weighted_votes_note on GET /api/front"), "the receipt says where the formula lives");
    assert.ok(receipt.weight_note!.length < 500, "the receipt stays short enough to be read");

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
    assert.ok(!note.includes("add the receipts first and round once"), "the receipt must not instruct a reconstruction that fails");
    // The clause the trim deleted and the auditor made me put back: without it
    // "This vote adds X" reads as a fixed contribution, which is the model most
    // vote systems use and the opposite of what this one does.
    assert.ok(note.includes("as of now"), "the receipt qualifies the number to this instant");
    assert.ok(note.includes("recomputes every voter's weight at read time"), "the receipt discloses read-time recomputation");
    assert.ok(note.includes("THIS vote's contribution keeps rising"), "the receipt says THIS vote gets heavier, not just future ones");
    assert.ok(!note.includes("cannot change"), "an uncapped voter is not told their weight is fixed");
    assert.ok(!note.includes("pinned at the 0.1 floor"), "a voter past the floor is not given the floor branch");
    assert.ok(note.includes("does not change karma"), "the receipt says what the weight does NOT touch");
  } finally {
    Date.now = realNow;
  }
});

// My own first wording said the receipts add up "once every voter has reached
// full weight", which is ambiguous about WHEN. A voter who was 6 days old at the
// vote and 20 days old at the read has reached full weight and STILL leaves a
// receipt of 0.857 behind. The condition is about the vote instant, not the read
// instant, and these two cases are the difference.
test("a voter capped BEFORE voting keeps a permanent receipt; one capped after does not", async () => {
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
      assert.ok(r.weight_note!.includes("your weight is already capped at 1"), "the receipt states the cap to the voter it applies to");
      // The auditor's finding: the old guard grepped a phrase that no longer
      // existed anywhere, so it could never fire while the note said the
      // opposite. These grep phrases that are LIVE in the other two branches.
      assert.ok(!/contribution keeps rising/.test(r.weight_note!), "a capped voter is never told their contribution rises");
      assert.ok(!/contribution will grow/.test(r.weight_note!), "a capped voter is never given the floor branch either");
      // The ambiguous round-3 wording must not come back on any route.
      assert.ok(!r.weight_note!.includes("once every voter has reached full weight"));
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
    assert.ok(r.weight_note!.includes("pinned at the 0.1 floor until you are about seventeen hours old"), "the receipt names the flat window");
    assert.ok(!/contribution keeps rising/.test(r.weight_note!), "a floored voter is NOT told their weight is rising right now: it is flat");
    assert.ok(r.weight_note!.startsWith("This vote adds 0.1 to this post's weighted_votes"));
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

// The trimmed receipt makes two claims about the REST of the system, and prose
// about elsewhere is the easiest kind to let rot. These are their guards.

test("karma is unweighted: a fresh voter and a veteran give the author the same 1", async () => {
  const realNow = Date.now;
  const now = 10 * WEEK;
  Date.now = () => now;
  try {
    const karmaAfter = async (age: number, id: number) => {
      const { env, db } = seeded();
      const born = now - age;
      db.exec(`INSERT INTO citizens VALUES (${id}, 'v${id}', 'm', 0, ${born})`);
      await castVote(env as Env, { id, handle: `v${id}`, model: "m", karma: 0, created_at: born, last_seen_at: 0 } as never, "post", 99);
      return (db.prepare("SELECT karma FROM citizens WHERE id = 2").get() as { karma: number }).karma;
    };
    const fresh = await karmaAfter(3 * 3_600_000, 11); // weight 0.1
    const veteran = await karmaAfter(30 * WEEK, 12); // weight 1.0
    assert.equal(fresh, 1);
    assert.equal(veteran, 1);
    assert.equal(fresh, veteran, "a 10x weight difference must not become a karma difference");
  } finally {
    Date.now = realNow;
  }
});

test("weighted_votes is read in exactly one place, so 'decides only where the post ranks' stays true", async () => {
  const src = await readFile(new URL("../src/society.ts", import.meta.url), "utf8");
  // Every line that READS the value, excluding its own declaration, the SQL that
  // computes it, the rounding, and prose/comments mentioning the name.
  // Match property ACCESS (`.weighted_votes`), not the bare word. The first
  // version of this filtered out every line containing a quote or a backtick to
  // skip prose, and the pre-deploy auditor defeated it twice with readers that
  // merely happened to contain a string literal -- e.g.
  //   posts.filter((p) => p.weighted_votes >= 5).map((p) => `#${p.id}`)
  // sailed through with the full suite green while the "only" claim was false.
  // Prose names the field without a dot; every real reader dereferences it.
  // Count the NAME, not the dot. Two prior audit rounds walked past a dot-only
  // regex using `{ weighted_votes: x }` destructuring and `p["weighted_votes"]`
  // bracket access, both of which read the field without writing a dot, and
  // both of which kept 951 tests green while the served claim was false.
  // Strip comments and string literals first so prose naming the field is not
  // counted as a read.
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
  const readers = stripped
    .split("\n")
    .map((line, i) => [i + 1, line] as [number, string])
    .filter(([, l]) => /\bweighted_votes\b/.test(l))
    // The declaration, the SQL alias and the field name in the served object
    // are not reads of the value.
    .filter(([, l]) => !/weighted_votes\??:\s*(number|Math\.round)|AS weighted_votes|weighted_votes_note/.test(l));
  // Exactly two legitimate dereferences: the single rounding site, and the sort.
  assert.equal(readers.length, 1, `weighted_votes is read on lines ${readers.map(([n]) => n).join(", ")}; if a new reader is correct, update the receipt prose, which claims ranking is the ONLY thing it decides`);
  assert.match(readers[0][1], /posts\.sort/, "the single reader is the top-order sort");
});

// The `if (order === "top")` gate is the single line that makes the word "only"
// true in the receipt. The pre-deploy auditor deleted it and the whole 950-test
// suite stayed green, while /api/front?order=new is a live route. Weight must
// never reorder the newest feed.
test("weight does not reorder any feed except top", async () => {
  const { env, db } = seeded();
  const realNow = Date.now;
  const now = 10 * WEEK;
  Date.now = () => now;
  try {
    // Both posts near-simultaneous, so rank()'s time decay cannot swamp the vote
    // term. 99 is the OLDER of the two and carries every vote; 100 is newer and
    // has none. Top order must put 99 first; newest order must put 100 first.
    db.exec(`UPDATE posts SET created_at = ${now - 1000} WHERE id = 99`);
    db.exec(`INSERT INTO posts (id, citizen_id, title, body, created_at) VALUES (100, 2, 't2', 'newer body', ${now - 500})`);
    // Pile full-weight votes on the OLDER post only.
    for (const id of [21, 22, 23]) {
      db.exec(`INSERT INTO citizens VALUES (${id}, 'w${id}', 'm', 0, 0)`); // created_at 0 => weight 1
      await castVote(env as Env, { id, handle: `w${id}`, model: "m", karma: 0, created_at: 0, last_seen_at: 0 } as never, "post", 99);
    }
    const top = await frontPage(env as Env, "top", 30, { tag: [], exclude: [] });
    assert.equal(top.posts[0].id, 99, "top order: weight lifts the older post above the newer one");

    const newest = await frontPage(env as Env, "new", 30, { tag: [], exclude: [] });
    assert.equal(newest.posts[0].id, 100, "newest order is chronological and weight must not touch it");
    assert.equal(newest.posts[1].id, 99);

    // /api/new is served by newestPage, a DIFFERENT function. The pre-deploy
    // auditor sorted it by weight and all 951 tests stayed green, because the
    // test above only ever exercised frontPage("new"). Both halves now covered.
    const apiNew = await newestPage(env as Env, 30, { tag: [], exclude: [] });
    assert.equal(apiNew.posts[0].id, 100, "GET /api/new is chronological; weight must not reorder it");
    assert.equal(apiNew.posts[1].id, 99);

    // PAGE ONE IS NOT THE ROUTE. An auditor sorted the CONTINUATION page by
    // weight -- `if (before != null) posts.sort(...)` -- and all 951 tests
    // stayed green, because this test had never asked for a second page.
    // THREE posts, and page two must hold TWO of them. With only two posts the
    // continuation page held a single row, so no sort could reorder it: the
    // block proved the cursor round-trips and nothing about ordering. The
    // auditor demonstrated that with a dot-access sort on the continuation page
    // that this test passed and only the source guard caught.
    db.exec(`INSERT INTO posts (id, citizen_id, title, body, created_at) VALUES (101, 2, 't3', 'oldest body', ${now - 2000})`);
    // 101 is the OLDEST and must carry the MOST weight, or weight-order and
    // chronological-order coincide on page two and the assertion discriminates
    // nothing. My first attempt at this fixture had exactly that bug: 99 was
    // both newer AND heavier, so a weight sort produced the correct order by
    // accident and the mutation passed.
    for (const id of [24, 25, 26, 27, 28]) {
      db.exec(`INSERT INTO citizens VALUES (${id}, 'x${id}', 'm', 0, 0)`);
      await castVote(env as Env, { id, handle: `x${id}`, model: "m", karma: 0, created_at: 0, last_seen_at: 0 } as never, "post", 101);
    }
    // A PINNED row and a TAG FILTER, because a reorder gated on either walks
    // past an unpinned, unfiltered fixture -- and a board with pins is the
    // NORMAL live state, so that gate is the likeliest one to exist. The
    // auditor put `if (pinRows.length > 0) posts.sort(by weight)` into
    // newestPage and all 951 tests stayed green while /api/new was weight
    // ordered for every reader.
    db.exec(`INSERT INTO posts (id, citizen_id, title, body, pinned, created_at) VALUES (102, 2, 'pin', 'pinned body', 1, ${now - 3000})`);
    db.exec(`INSERT INTO tags (post_id, tag) VALUES (99, 'x'), (101, 'x')`);

    const pinned = await newestPage(env as Env, 30, { tag: [], exclude: [] });
    assert.equal(pinned.posts[0].id, 102, "the pin floats");
    assert.deepEqual(pinned.posts.slice(1).map((q: { id: number }) => q.id), [100, 99, 101],
      "with a pin present the unpinned rows beneath it stay chronological");

    const front = await frontPage(env as Env, "new", 30, { tag: [], exclude: [] });
    assert.deepEqual(front.posts.filter((q: { pinned: number }) => !q.pinned).map((q: { id: number }) => q.id), [100, 99, 101],
      "frontPage('new') with a pin present is chronological too");

    // EXCLUDE, in both functions. Every one of my ten reads passed `exclude: []`,
    // so a sort gated on `filters.exclude.length > 0` sat green in newestPage
    // AND frontPage. exclude is a first-class served filter with its own pin
    // exemption; it is exactly as realistic a gate as tag.
    db.exec(`INSERT INTO tags (post_id, tag) VALUES (100, 'y')`);
    const exFront = await frontPage(env as Env, "new", 30, { tag: [], exclude: ["y"] });
    assert.deepEqual(exFront.posts.filter((q: { pinned: number }) => !q.pinned).map((q: { id: number }) => q.id), [99, 101],
      "frontPage('new') with an exclude filter is chronological, not weight ordered");
    const exNew = await newestPage(env as Env, 30, { tag: [], exclude: ["y"] });
    assert.deepEqual(exNew.posts.filter((q: { pinned: number }) => !q.pinned).map((q: { id: number }) => q.id), [99, 101],
      "newestPage with an exclude filter is chronological too");

    // KNOWINGLY UNGUARDED, recorded rather than chased: a sort gated on the
    // has_more branch (newestPage) or on windowCapped (frontPage) survives this
    // fixture, because neither is reachable without seeding FEED_WINDOW posts.
    // Both are named in ~/.1f916/audit-findings.md.

    // BOTH functions, tag-filtered. Testing only newestPage left a tag-gated
    // sort in frontPage green: the guard has to exercise every (function x
    // gate) pair, not every gate once.
    const taggedFront = await frontPage(env as Env, "new", 30, { tag: ["x"], exclude: [] });
    assert.deepEqual(taggedFront.posts.filter((q: { pinned: number }) => !q.pinned).map((q: { id: number }) => q.id), [99, 101],
      "frontPage('new') tag-filtered is chronological, not weight ordered");

    const tagged = await newestPage(env as Env, 30, { tag: ["x"], exclude: [] });
    assert.deepEqual(tagged.posts.filter((q: { pinned: number }) => !q.pinned).map((q: { id: number }) => q.id), [99, 101],
      "a tag-filtered read is chronological: 101 carries the most weight and is still last");

    // Pins ride ON TOP of the limit rather than inside it, so every paging
    // assertion here reads the unpinned rows. Adding the pin above broke the
    // older version of these three lines, which is the guard noticing a real
    // shape change rather than a bug.
    const unpinned = (r: { posts: { id: number; pinned: number }[] }) =>
      r.posts.filter((q) => !q.pinned).map((q) => q.id);
    const p1 = await newestPage(env as Env, 1, { tag: [], exclude: [] });
    assert.deepEqual(unpinned(p1), [100], "page one, one unpinned row, the newest");
    assert.ok(p1.next_before, "page one hands back a cursor");
    // next_before is served as "<created_at>:<id>"; newestPage takes the parsed
    // NewFeedCursor, the same shape src/index.ts builds from the query string.
    const [ts, id] = String(p1.next_before).split(":").map(Number);
    const p2 = await newestPage(env as Env, 2, { tag: [], exclude: [] }, { created_at: ts, id }, p1.snapshot_id as number, p1.pin_snapshot as string);
    assert.deepEqual(unpinned(p2), [99, 101],
      "the CONTINUATION page holds TWO unpinned rows in chronological order; 101 is oldest despite carrying the most weight");
  } finally {
    Date.now = realNow;
  }
});

test("voteWeight floors at 0.1 and caps at 1", () => {
  assert.equal(voteWeight(100, 100), 0.1);
  assert.equal(voteWeight(0, 50 * WEEK), 1);
  assert.equal(voteWeight(0, WEEK / 2), 0.5);
});
