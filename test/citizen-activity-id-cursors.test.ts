// Citizen activity uses two exclusive ROW-ID cursors, not created_at cursors.
// Keep row IDs distinct from timestamps: fixtures with id === created_at
// cannot distinguish an ID predicate from a mistaken timestamp predicate.
// Walk the real anonymous Worker and shared reader against an independent
// fixture-object oracle, with epoch timestamps, ties, interleaved authors and
// unequal stream lengths. This is a coverage guard, not a production fix.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.ts";
import { citizenRecord, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const DAY = 86_400_000;
const EPOCH = 1_600_000_000_000;
const originalNow = Date.now;
const originalFetch = globalThis.fetch;
const CAPS = { posts: 200, comments: 500 } as const;
type Stream = keyof typeof CAPS;
type Row = { id: number; citizen_id: number; created_at: number; body: string };

function fixture(postCount: number, commentCount: number) {
  const { env, db } = sqliteTestEnv(schema);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (7, 'walker', 'm', 'fixture-seven', ${EPOCH - DAY}, ${EPOCH - DAY}),
           (8, 'neighbor', 'm', 'fixture-eight', ${EPOCH - DAY}, ${EPOCH - DAY});
    INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at)
    VALUES (1, 8, 'host', 'host body', 'fixture-host', ${EPOCH - DAY});`);
  const rows: Record<Stream, Row[]> = { posts: [], comments: [] };
  for (const stream of ["posts", "comments"] as const) {
    const count = stream === "posts" ? postCount : commentCount;
    for (let i = 0; i < count; i++) {
      // Ordinary posts respect one post per author per UTC day; comments can
      // share a millisecond (two per day here, below their daily cap of 20).
      // Different authors may post at the same instant. IDs need not equal ms.
      for (const citizen_id of [7, 8]) {
        const row = {
          id: (stream === "posts" ? 11 + 5 * i : 13 + 7 * i) + (citizen_id === 8 ? 2 : 0),
          citizen_id,
          created_at: EPOCH + (stream === "posts" ? i : Math.floor(i / 2)) * DAY,
          body: `${stream} body ${citizen_id}:${i}`,
        };
        rows[stream].push(row);
        if (stream === "posts") {
          db.prepare("INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)")
            .run(row.id, citizen_id, `title ${row.id}`, row.body, `fixture-${row.id}`, row.created_at);
        } else {
          db.prepare("INSERT INTO comments (id, post_id, citizen_id, parent_id, intended_parent_id, body, created_at) VALUES (?, 1, ?, NULL, NULL, ?, ?)")
            .run(row.id, citizen_id, row.body, row.created_at);
        }
      }
    }
  }
  // Audit the stored fixture too, not only the independent expected objects.
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  for (const stream of ["posts", "comments"] as const) {
    const stored = db.prepare(`SELECT id, citizen_id, created_at, body FROM ${stream} WHERE id != ? ORDER BY id`)
      .all(stream === "posts" ? 1 : -1);
    assert.deepEqual(JSON.parse(JSON.stringify(stored)), [...rows[stream]].sort((a, b) => a.id - b.id));
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${stream} r JOIN citizens c ON c.id = r.citizen_id WHERE r.created_at < c.created_at`)
      .get()!.n, 0, "authors exist before their speech");
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM (SELECT citizen_id, CAST(created_at / ${DAY} AS INTEGER) AS day FROM ${stream} GROUP BY citizen_id, day HAVING COUNT(*) > ?)`)
      .get(stream === "posts" ? 1 : 20)!.n, 0, "stored UTC-day usage respects ordinary quotas");
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM comments c JOIN posts p ON p.id = c.post_id WHERE c.created_at < p.created_at")
    .get()!.n, 0, "comments follow their host post");
  // Keep supported ordinary daily quotas honest, including the foreign host.
  for (const stream of ["posts", "comments"] as const) {
    const usage = new Map<string, number>();
    const all = stream === "posts"
      ? [...rows.posts, { citizen_id: 8, created_at: EPOCH - DAY }]
      : rows.comments;
    for (const r of all) {
      const key = `${r.citizen_id}:${Math.floor(r.created_at / DAY)}`;
      const used = (usage.get(key) ?? 0) + 1;
      usage.set(key, used);
      assert.ok(used <= (stream === "posts" ? 1 : 20), "fixture respects ordinary daily quota");
    }
  }
  // Enforce read-only behavior only after all isolated fixture writes finish.
  db.exec("PRAGMA query_only = ON");
  const reads: string[] = [];
  const guarded = {
    prepare(sql: string) {
      reads.push(sql);
      return env.DB.prepare(sql);
    },
    batch(statements: Parameters<typeof env.DB.batch>[0]) { return env.DB.batch(statements); },
  };
  // Native enforcement, not a SELECT-prefix facade: harmless CTE reads work,
  // while standalone and batched CTE-prefixed writes reach SQLite and refuse.
  const snapshot = () => db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .all().map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]);
  return { rows, db, reads, snapshot, env: { ...env, DB: guarded } as unknown as Env };
}

// The model consumes only fixture objects and the documented ID/cap contract.
function page(rows: Row[], cap: number, before: number | undefined) {
  const eligible = rows.filter(r => r.citizen_id === 7 && (before === undefined || r.id < before))
    .sort((a, b) => b.id - a.id);
  const selected = eligible.slice(0, cap);
  return { selected, next: eligible.length > cap ? selected.at(-1)!.id : null };
}

for (const [postCount, commentCount] of [[401, 1000], [400, 1001], [0, 0]]) {
  test(`anonymous citizen activity walks row ids independently: ${postCount} posts, ${commentCount} comments`, async t => {
    const f = fixture(postCount, commentCount);
    t.after(() => f.db.close());
    const storedBefore = f.snapshot();
    const changesBefore = f.db.prepare("SELECT total_changes() AS n").get()!.n;
    assert.equal((await f.env.DB.prepare("WITH x(n) AS (SELECT 1) SELECT n FROM x").first<{ n: number }>())!.n, 1);
    const forbiddenWrite = "WITH x(n) AS (SELECT 1) UPDATE citizens SET karma = karma + (SELECT n FROM x) WHERE id = 7";
    await assert.rejects(f.env.DB.prepare(forbiddenWrite).run(), /readonly|read-only/i);
    await assert.rejects(f.env.DB.batch([f.env.DB.prepare(forbiddenWrite)]), /readonly|read-only/i);
    assert.throws(() => f.db.exec("UPDATE citizens SET karma = karma + 1 WHERE id = 7"), /readonly|read-only/i);
    assert.deepEqual(f.snapshot(), storedBefore);
    f.reads.length = 0; // The assertions below concern actual reader calls only.
    t.mock.method(Date, "now", () => EPOCH + 1100 * DAY);
    let networkAttempts = 0;
    t.mock.method(globalThis, "fetch", async () => { networkAttempts++; throw new Error("network denied"); });
    const active = { posts: true, comments: true };
    const cursor: { posts?: number; comments?: number } = {};
    const delivered: Record<Stream, number[]> = { posts: [], comments: [] };
    let requests = 0;
    while (active.posts || active.comments) {
      assert.ok(++requests <= 4, "both streams must terminate without an empty sentinel page");
      const query = new URLSearchParams();
      if (active.posts && cursor.posts !== undefined) query.set("posts_before", String(cursor.posts));
      if (active.comments && cursor.comments !== undefined) query.set("comments_before", String(cursor.comments));
      const request = new Request(`https://record.test/api/citizen/walker?${query}`);
      assert.equal([...request.headers].length, 0, "no auth, conditional, wait or cadence headers");
      assert.ok([...query.keys()].every(k => k === "posts_before" || k === "comments_before"));
      const response = await worker.fetch(request, f.env as never);
      assert.equal(response.status, 200);
      const served = await response.json() as Record<string, any>;
      const direct = await citizenRecord(f.env, "walker", {
        postsBefore: active.posts ? cursor.posts : undefined,
        commentsBefore: active.comments ? cursor.comments : undefined,
      });
      // Route-only clocks are not part of citizenRecord's returned object.
      const { now, now_utc, ...record } = served;
      assert.equal(now, Date.now());
      assert.equal(now_utc, new Date(Date.now()).toISOString());
      assert.deepEqual(record, JSON.parse(JSON.stringify(direct)), "the real route forwards both cursors literally");
      assert.equal(served.post_total, postCount);
      assert.equal(served.comment_total, commentCount);
      assert.equal(served.truncated, postCount > CAPS.posts || commentCount > CAPS.comments);
      for (const stream of ["posts", "comments"] as const) {
        if (!active[stream]) continue; // Omitting a drained cursor restarts that list; never collect it again.
        const expected = page(f.rows[stream], CAPS[stream], cursor[stream]);
        const rows = served[stream] as Record<string, any>[];
        assert.deepEqual(rows.map(r => ({ id: r.id, created_at: r.created_at, body: r.body })),
          expected.selected.map(r => ({ id: r.id, created_at: r.created_at, body: r.body })), `${stream}: exclusive row-id page`);
        if (stream === "comments") for (const r of rows) {
          assert.equal(r.post_id, 1);
          assert.equal(r.parent_id, null);
          assert.equal(r.intended_parent_id, null);
        }
        const meta = served.paging[stream];
        assert.equal(meta.cap, CAPS[stream]);
        assert.equal(meta.returned, expected.selected.length);
        assert.equal(meta[`${stream}_before`], cursor[stream] ?? null);
        assert.equal(meta.truncated, f.rows[stream].filter(r => r.citizen_id === 7).length > CAPS[stream]);
        assert.equal(meta[`next_${stream}_before`], expected.next, `${stream}: terminal exact-cap pages have null tokens`);
        delivered[stream].push(...rows.map(r => r.id));
        if (expected.next === null) active[stream] = false;
        else {
          if (cursor[stream] !== undefined) assert.ok(expected.next < cursor[stream]!);
          cursor[stream] = meta[`next_${stream}_before`];
        }
      }
    }
    for (const stream of ["posts", "comments"] as const) {
      const all = f.rows[stream].filter(r => r.citizen_id === 7).sort((a, b) => b.id - a.id).map(r => r.id);
      assert.deepEqual(delivered[stream], all, `${stream}: every own row once, no foreign or repeated rows`);
      assert.equal(new Set(delivered[stream]).size, all.length);
    }
    assert.ok(f.reads.length > 0);
    assert.deepEqual(f.snapshot(), storedBefore, "anonymous activity reads leave every stored table unchanged");
    assert.equal(f.db.prepare("SELECT total_changes() AS n").get()!.n, changesBefore, "no write, including a write restored before inspection");
    assert.equal(f.db.prepare("PRAGMA query_only").get()!.query_only, 1);
    assert.equal(networkAttempts, 0, "read must not attempt network even if errors are caught");
  });
}

test("citizen activity walk restores its clock and network mocks", () => {
  assert.equal(Date.now, originalNow);
  assert.equal(globalThis.fetch, originalFetch);
});