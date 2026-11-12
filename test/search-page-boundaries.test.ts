// A full search page is not necessarily a truncated one. The original
// has_more repair (a943ad080) overfetches one matching row to distinguish them.
// Existing search-has-more tests cover below/above the cap, but not equality.
// Keep the oracle in fixture objects, not in a second version of the SQL.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const origin = "https://1f916.ai";
const stamp = Date.parse("2026-10-01T12:00:00Z");
const query = "boundary-needle";

type Post = { id: number; citizenId: number; title: string; body: string; createdAt: number };
type Page = {
  query: string; limit: number; max_limit: number; count: number; has_more: boolean;
  results: Array<{ id: number; title: string; author: string; created_at: number; url: string }>;
};

function fixture(matchingCount: number) {
  const { db, env } = sqliteTestEnv(schema);
  // One post per author, so timestamp ties never violate the ordinary daily
  // post allowance. IDs have gaps; pairs share timestamps, and timestamp order
  // differs from ID order. These are stored historical rows, not a claim that
  // setup exercised the complete public writer lifecycle.
  const posts: Post[] = Array.from({ length: matchingCount }, (_, i) => ({
    id: 10 + i * 3,
    citizenId: 10 + i,
    title: i % 2 === 0 ? `${query} title ${i}` : `body match ${i}`,
    body: i % 2 === 0 ? `ordinary body ${i}` : `${query} body ${i}`,
    createdAt: stamp - Math.floor(i / 2) * 1000,
  }));
  // Nonmatches newer than all hits must not consume a result or the lookahead.
  const stored = [...posts, ...Array.from({ length: 3 }, (_, i) => ({
    id: 1000 + i,
    citizenId: 1000 + i,
    title: `unrelated title ${i}`,
    body: `unrelated body ${i}`,
    createdAt: stamp + 1000 + i,
  }))];
  const citizen = db.prepare(`INSERT INTO citizens
    (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (?, ?, 'fixture', ?, ?, ?)`);
  const post = db.prepare(`INSERT INTO posts
    (id, citizen_id, title, body, dupe_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
  for (const row of stored) {
    citizen.run(row.citizenId, `boundary-${row.citizenId}`, `offline-${row.citizenId}`, stamp - 86_400_000, stamp - 86_400_000);
    post.run(row.id, row.citizenId, row.title, row.body, `boundary-${row.id}`, row.createdAt);
  }
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM posts").get()!.n, stored.length);
  assert.deepEqual(db.prepare(`SELECT citizen_id FROM posts
    GROUP BY citizen_id, CAST(created_at / 86400000 AS INTEGER) HAVING COUNT(*) > 1`).all(), []);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM posts p JOIN citizens c ON c.id = p.citizen_id
    WHERE p.created_at < c.created_at`).get()!.n, 0);
  db.exec("PRAGMA query_only = ON");
  return { db, env, posts };
}

test("search fixture permits reads but natively refuses writes through SQLite and D1", async () => {
  const { db, env } = fixture(1);
  try {
    const before = db.prepare("SELECT total_changes() AS n").get()!.n;
    assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM posts").first<{ n: number }>())!.n, 4);
    assert.throws(() => db.exec("UPDATE posts SET body = 'changed'"), /readonly/i);
    await assert.rejects(env.DB.prepare("UPDATE posts SET body = 'changed'").run(), /readonly/i);
    assert.equal(db.prepare("SELECT total_changes() AS n").get()!.n, before);
  } finally {
    db.close();
  }
});

for (const [label, supplied, effective] of [
  ["default", undefined, 20],
  ["minimum", 1, 1],
  ["explicit default", 20, 20],
  ["maximum", 50, 50],
  ["clamped above maximum", 500, 50],
] as const) {
  test(`HTTP search ${label}: only a real withheld match makes has_more true`, async (t) => {
    const outbound: unknown[][] = [];
    t.mock.method(globalThis, "fetch", (...args: unknown[]) => {
      outbound.push(args);
      throw new Error("this ordinary search must not fetch upstream");
    });
    // At minimum=1, zero is both the empty and the below-limit case.
    for (const matchingCount of new Set([0, effective - 1, effective, effective + 1])) {
      const { db, env, posts } = fixture(matchingCount);
      try {
        const changesBefore = db.prepare("SELECT total_changes() AS n").get()!.n;
        const expected = [...posts].sort((a, b) => b.createdAt - a.createdAt || b.id - a.id).slice(0, effective);
        const suffix = supplied === undefined ? "" : `&limit=${supplied}`;
        const request = new Request(`${origin}/api/search?q=${query}${suffix}`);
        assert.equal(request.headers.get("Authorization"), null);
        assert.equal(request.headers.get("If-None-Match"), null);
        const response = await worker.fetch(request, env);
        assert.equal(response.status, 200);
        const page = await response.json() as Page;
        assert.equal(page.query, query);
        assert.equal(page.limit, effective);
        assert.equal(page.max_limit, 50);
        assert.equal(page.count, expected.length);
        assert.equal(page.has_more, matchingCount > effective, `${matchingCount} matches at limit ${effective}: fullness alone is not evidence of a withheld match`);
        assert.deepEqual(page.results.map((row) => ({
          id: row.id, title: row.title, author: row.author, created_at: row.created_at, url: row.url,
        })), expected.map((row) => ({
          id: row.id, title: row.title, author: `boundary-${row.citizenId}`,
          created_at: row.createdAt, url: `${origin}/api/post/${row.id}`,
        })), "the ordered matching prefix excludes both distractors and the sentinel");
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM posts").get()!.n, matchingCount + 3);
        assert.equal(db.prepare("SELECT total_changes() AS n").get()!.n, changesBefore, "search changes no stored rows");
        assert.equal(db.prepare("PRAGMA query_only").get()!.query_only, 1);
      } finally {
        db.close();
      }
    }
    assert.deepEqual(outbound, [], "no optional or required outbound request is part of search");
  });
}
