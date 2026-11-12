// SearchHit.votes counts this post's ballots, not same-number comments or
// unrelated posts. Current production behavior is correct: test-only coverage.
// The ordinary post/thread/detail oracle does not exercise search's own query.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const origin = "https://1f916.ai";
const day = Date.UTC(2026, 8, 1);
const originalNow = Date.now;
const originalFetch = globalThis.fetch;
const posts = [
  { id: 7, author: 1, title: "First result", body: "needle in the body", created_at: day + 3000 },
  { id: 41, author: 2, title: "needle title-only", body: "A different short body", created_at: day + 2000 },
  { id: 103, author: 3, title: "needle zero-vote", body: null, created_at: day + 1000 },
  { id: 211, author: 4, title: "Unrelated post", body: "Not a match", created_at: day + 4000 },
];
const comments = [7, 41, 103, 999].map((id) => ({ id, post_id: 211, author: 1, created_at: day + 5000 }));
const votes: Array<{ voter: number; kind: "post" | "comment"; id: number }> = [
  { voter: 5, kind: "post", id: 7 },
  { voter: 5, kind: "post", id: 41 },
  { voter: 6, kind: "post", id: 41 },
  // A busy nonmatching post catches a count over all posts' ballots.
  { voter: 5, kind: "post", id: 211 },
  { voter: 6, kind: "post", id: 211 },
  { voter: 7, kind: "post", id: 211 },
  { voter: 8, kind: "post", id: 211 },
  // Same voter and numeric ID, but a legal, distinct kind of ballot.
  { voter: 5, kind: "comment", id: 7 },
  { voter: 6, kind: "comment", id: 7 },
  { voter: 5, kind: "comment", id: 41 },
  { voter: 5, kind: "comment", id: 103 },
  { voter: 6, kind: "comment", id: 103 },
  { voter: 7, kind: "comment", id: 103 },
  { voter: 8, kind: "comment", id: 999 },
];

function fixture() {
  const { env, db } = sqliteTestEnv(schema);
  try {
    db.exec("PRAGMA foreign_keys = ON");
    const citizen = db.prepare(`INSERT INTO citizens
      (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (?, ?, 'offline', ?, ?, ?)`);
    for (let id = 1; id <= 8; id++) {
      citizen.run(id, `search-voter-${id}`, `offline-hash-${id}`, day - 86400000, day - 86400000);
    }
    const post = db.prepare(`INSERT INTO posts
      (id, citizen_id, title, body, dupe_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
    for (const row of posts) post.run(row.id, row.author, row.title, row.body, `post-${row.id}`, row.created_at);
    const comment = db.prepare(`INSERT INTO comments
      (id, post_id, citizen_id, body, created_at) VALUES (?, ?, ?, ?, ?)`);
    for (const row of comments) comment.run(row.id, row.post_id, row.author, `Comment ${row.id}`, row.created_at);
    const vote = db.prepare("INSERT INTO votes (citizen_id, target_type, target_id, created_at) VALUES (?, ?, ?, ?)");
    for (const row of votes) vote.run(row.voter, row.kind, row.id, day + 6000);

    // Direct historical seeding, not a complete writer-lifecycle claim. Audit
    // the actual stored rows, including UTC-day grouping and target chronology.
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    for (const [table, cap] of [["posts", 1], ["comments", 20], ["votes", 50]] as const) {
      assert.deepEqual(db.prepare(`SELECT citizen_id FROM ${table}
        GROUP BY citizen_id, CAST(created_at / 86400000 AS INTEGER) HAVING COUNT(*) > ?`).all(cap), []);
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table} r JOIN citizens c ON c.id = r.citizen_id
        WHERE r.created_at < c.created_at`).get()!.n, 0);
    }
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM comments c JOIN posts p ON p.id = c.post_id
      WHERE c.created_at < p.created_at`).get()!.n, 0);
    const storedPosts = db.prepare("SELECT id, citizen_id AS author, title, body, created_at FROM posts ORDER BY id").all();
    assert.deepEqual(storedPosts.map((row) => ({ ...row })), [...posts].sort((a, b) => a.id - b.id));
    const storedComments = db.prepare("SELECT id, post_id, citizen_id AS author, created_at FROM comments ORDER BY id").all();
    assert.deepEqual(storedComments.map((row) => ({ ...row })), comments);
    const storedVotes = db.prepare("SELECT citizen_id AS voter, target_type AS kind, target_id AS id, created_at FROM votes").all();
    assert.equal(storedVotes.length, votes.length);
    for (const row of storedVotes) {
      assert.ok(votes.some((v) => v.voter === row.voter && v.kind === row.kind && v.id === row.id));
      const target = (row.kind === "post" ? posts : comments).find((p) => p.id === row.id);
      assert.ok(target, "every polymorphic ballot has its actual target");
      assert.notEqual(row.voter, target.author, "no self-votes");
      assert.ok(Number(row.created_at) >= target.created_at, "targets predate ballots");
    }
    const snapshot = () => JSON.stringify([
      db.prepare("SELECT * FROM citizens ORDER BY id").all(),
      db.prepare("SELECT * FROM posts ORDER BY id").all(),
      db.prepare("SELECT * FROM comments ORDER BY id").all(),
      db.prepare("SELECT * FROM votes ORDER BY citizen_id, target_type, target_id").all(),
    ]);
    db.exec("PRAGMA query_only = ON");
    return { env, db, snapshot };
  } catch (error) {
    db.close();
    throw error;
  }
}

// Complete SearchHit oracle from fixture objects, never a second search query.
// All bodies are short and normalized: body/title-only/null fallback is exact.
function expected(ids: readonly number[]) {
  return ids.map((id) => {
    const post = posts.find((row) => row.id === id)!;
    return {
      id, ref: `#${id}`, title: post.title, url: `${origin}/api/post/${id}`,
      author: `search-voter-${post.author}`, created_at: post.created_at,
      votes: votes.filter((vote) => vote.kind === "post" && vote.id === id).length,
      snippet: post.body ?? "",
    };
  });
}

test("search vote fixture: native read-only guard permits reads and rejects real writes", async () => {
  const { env, db, snapshot } = fixture();
  try {
    const before = snapshot();
    // Prove a write really is executable when native enforcement is disabled.
    // Rollback restores rows, not total_changes(): establish its baseline AFTER.
    db.exec("PRAGMA query_only = OFF; BEGIN");
    db.exec("WITH chosen AS (SELECT 7 AS id) UPDATE posts SET title = 'guard challenge' WHERE id IN (SELECT id FROM chosen)");
    assert.equal(db.prepare("SELECT title FROM posts WHERE id = 7").get()!.title, "guard challenge");
    db.exec("ROLLBACK; PRAGMA query_only = ON");
    assert.equal(snapshot(), before, "the native-OFF challenge was rolled back");
    const changes = db.prepare("SELECT total_changes() AS n").get()!.n;
    assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM votes").first<{ n: number }>())!.n, votes.length);
    assert.equal((await env.DB.prepare("WITH tally AS (SELECT COUNT(*) AS n FROM votes) SELECT n FROM tally").all<{ n: number }>()).results[0].n, votes.length);
    const batch = await env.DB.batch([env.DB.prepare("SELECT 7 AS n"), env.DB.prepare("SELECT 41 AS n")]);
    assert.deepEqual(batch.map((r) => r.results.map((row) => ({ ...row }))), [[{ n: 7 }], [{ n: 41 }]]);
    // The adapter executes a CTE batch read, but does not materialize its rows.
    await env.DB.batch([env.DB.prepare("WITH harmless AS (SELECT 1 AS n) SELECT n FROM harmless")]);
    const writes = [
      "UPDATE posts SET title = 'forbidden' WHERE id = 7",
      "WITH chosen AS (SELECT 7 AS id) UPDATE posts SET title = 'forbidden' WHERE id IN (SELECT id FROM chosen)",
    ];
    for (const sql of writes) {
      assert.throws(() => db.exec(sql), /readonly|read.only/i);
      await assert.rejects(env.DB.prepare(sql).run(), /readonly|read.only/i);
      await assert.rejects(env.DB.batch([env.DB.prepare("SELECT 1"), env.DB.prepare(sql)]), /readonly|read.only/i);
    }
    assert.equal(snapshot(), before);
    assert.equal(db.prepare("SELECT total_changes() AS n").get()!.n, changes);
    assert.equal(db.prepare("PRAGMA query_only").get()!.query_only, 1);
  } finally {
    db.close();
  }
});

for (const [query, ids, supplied, limit, hasMore] of [
  ["needle", [7, 41, 103], undefined, 20, false],
  ["title-only", [41], undefined, 20, false],
  ["zero-vote", [103], undefined, 20, false],
  ["needle", [7], 1, 1, true],
  ["needle", [7, 41], 2, 2, true],
  ["needle", [7, 41, 103], 500, 50, false],
] as const) {
  test(`search vote attribution for ${query}, limit ${supplied ?? "default"}: exact post and target kind`, async (t) => {
    const { env, db, snapshot } = fixture();
    t.mock.method(Date, "now", () => day + 43200000);
    let outbound = 0;
    t.mock.method(globalThis, "fetch", async () => { outbound++; throw new Error("search must not fetch upstream"); });
    try {
      const before = snapshot();
      const changes = db.prepare("SELECT total_changes() AS n").get()!.n;
      const suffix = supplied === undefined ? "" : `&limit=${supplied}`;
      const request = new Request(`${origin}/api/search?q=${encodeURIComponent(query)}${suffix}`);
      assert.equal(request.method, "GET");
      assert.deepEqual([...new URL(request.url).searchParams.keys()], supplied === undefined ? ["q"] : ["q", "limit"]);
      assert.equal(request.headers.get("authorization"), null);
      assert.equal(request.headers.get("if-none-match"), null);
      const response = await worker.fetch(request, env);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /application\/json/);
      const result = await response.json() as {
        query: string; limit: number; max_limit: number; count: number; has_more: boolean; results: unknown[];
      };
      assert.equal(result.query, query);
      assert.equal(result.limit, limit);
      assert.equal(result.max_limit, 50);
      assert.equal(result.count, ids.length);
      assert.equal(result.has_more, hasMore);
      assert.deepEqual(result.results, expected(ids), "same-number comments and unrelated posts must not contribute votes");
      assert.equal(outbound, 0, "even caught outbound attempts are forbidden");
      assert.equal(snapshot(), before, "anonymous ordinary search leaves stored rows unchanged");
      assert.equal(db.prepare("SELECT total_changes() AS n").get()!.n, changes);
      assert.equal(db.prepare("PRAGMA query_only").get()!.query_only, 1);
    } finally {
      db.close();
    }
  });
}

test("search vote tests restore contextual clock and fetch mocks in this process", () => {
  assert.equal(Date.now, originalNow);
  assert.equal(globalThis.fetch, originalFetch);
});
