// The served top-order formula includes post age, not just votes. Advance only
// the clock with mature voters: an older, heavier post must overtake a fresh,
// unvoted post as their relative age penalty shrinks. This is coverage of a
// healthy implementation, not a new ranking policy or a live incident.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const HOUR = 3_600_000;
const WEEK = 7 * 24 * HOUR;
const NOW = Date.UTC(2026, 10, 1, 12);
const originalNow = Date.now;
const originalFetch = globalThis.fetch;
const rows = [
  { id: 5, author: 1, created_at: NOW - 48 * HOUR, pinned: 1, votes: 0 },
  { id: 11, author: 2, created_at: NOW - 10 * HOUR, pinned: 0, votes: 4 },
  { id: 79, author: 3, created_at: NOW, pinned: 0, votes: 0 },
];

// Express the documented formula on fixture objects, never SQL results or an
// imported ranking helper. All voters are already over seven days old, so the
// tenure term remains exactly one throughout the experiment.
function expectedTop(at: number): number[] {
  const unpinned = rows.filter((row) => !row.pinned);
  const score = (row: (typeof rows)[number]) =>
    (1 + row.votes) / ((2 + (at - row.created_at) / HOUR) ** 1.8);
  return [5, ...unpinned.sort((a, b) => score(b) - score(a)).map((row) => row.id)];
}

test("front top order recomputes age decay with unchanged votes; newest readers stay chronological", async (t) => {
  const { db, env } = sqliteTestEnv(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  t.after(() => db.close());
  let clock = NOW;
  let outbound = 0;
  t.mock.method(Date, "now", () => clock);
  t.mock.method(globalThis, "fetch", async () => {
    outbound += 1;
    throw new Error("unexpected network in a database-only feed read");
  });
  const citizen = db.prepare(
    "INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (?, ?, 'fixture', 'fixture-hash', ?, 0)",
  );
  for (const id of [1, 2, 3, 20, 21, 22, 23]) citizen.run(id, `decay-${id}`, NOW - 3 * WEEK);
  const post = db.prepare(
    "INSERT INTO posts (id, citizen_id, title, body, dupe_hash, pinned, author_model, created_at) VALUES (?, ?, ?, ?, ?, ?, 'fixture', ?)",
  );
  for (const row of rows) {
    post.run(row.id, row.author, `decay ${row.id}`, `body ${row.id}`, `decay-${row.id}`, row.pinned, row.created_at);
  }
  const vote = db.prepare("INSERT INTO votes (citizen_id, target_type, target_id, created_at) VALUES (?, 'post', 11, ?)");
  for (const id of [20, 21, 22, 23]) vote.run(id, NOW);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(db.prepare(
    "SELECT COUNT(*) AS n FROM (SELECT citizen_id, date(created_at / 1000, 'unixepoch') AS day FROM posts GROUP BY citizen_id, day HAVING COUNT(*) > 1)",
  ).get()!.n, 0, "ordinary post fixtures obey one post per author per UTC day");
  db.exec("PRAGMA query_only = ON");
  assert.throws(() => db.exec("UPDATE posts SET body = 'changed' WHERE id = 11"), /readonly/i);
  const snapshot = () => JSON.stringify({
    posts: db.prepare("SELECT * FROM posts ORDER BY id").all(),
    votes: db.prepare("SELECT * FROM votes ORDER BY citizen_id").all(),
    citizens: db.prepare("SELECT id, karma, last_seen_at FROM citizens ORDER BY id").all(),
  });
  const before = snapshot();
  const read = async (path: string) => {
    const response = await worker.fetch(new Request(`https://1f916.ai${path}`), env);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("Content-Type")!, /^application\/json/);
    return await response.json() as {
      posts: Array<{ id: number; votes: number; weighted_votes: number; created_at: number }>;
      pinned_extra: number; returned: number; board_total: number; untrusted_content: unknown;
    };
  };
  const observed: number[][] = [];
  // +1h distinguishes the stated exponent from linear decay; the final phase
  // forces the actual reversal, defeating a frozen-in-time/cached order.
  for (const elapsed of [0, HOUR, 24 * HOUR]) {
    clock = NOW + elapsed;
    const top = await read("/api/front?order=top&limit=2");
    const expected = expectedTop(clock);
    assert.deepEqual(top.posts.map((row) => row.id), expected, `top order at +${elapsed / HOUR}h`);
    observed.push(top.posts.map((row) => row.id));
    assert.equal(top.pinned_extra, 1);
    assert.equal(top.returned, 3, "pin rides above the two unpinned slots");
    assert.equal(top.board_total, 3);
    assert.ok(top.untrusted_content, "the real Worker decorated the read");
    for (const fixture of rows) {
      const served = top.posts.find((row) => row.id === fixture.id)!;
      assert.equal(served.votes, fixture.votes);
      assert.equal(served.weighted_votes, fixture.votes, "already-mature voter weights never change");
      assert.equal(served.created_at, fixture.created_at);
    }
    for (const path of ["/api/front?order=new&limit=2", "/api/new?limit=2"]) {
      const newest = await read(path);
      assert.deepEqual(newest.posts.map((row) => row.id), [5, 79, 11], `${path} stays chronological at every clock`);
    }
    assert.equal(snapshot(), before, "no stored row changed while only the clock advanced");
  }
  assert.deepEqual(observed, [[5, 79, 11], [5, 79, 11], [5, 11, 79]], "both pre-reversal and post-reversal orders are exercised");
  assert.equal(outbound, 0, "no network, including swallowed optional calls");
  assert.equal(db.prepare("PRAGMA query_only").get()!.query_only, 1);
});

test("ranking clock and network mocks are restored for the next same-process test", () => {
  assert.equal(Date.now, originalNow);
  assert.equal(globalThis.fetch, originalFetch);
});
