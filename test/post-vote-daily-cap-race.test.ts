// Ordinary POST votes share a 50/day budget even when two callers read 49.
// Delay delivery of actual SQLite COUNT results, not their execution or values.
// This models an allowed handler interleaving, not deployed concurrency/load.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { castVote, SocietyError } from "../src/society.ts";
import type { Citizen } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const originalNow = Date.now;
const originalFetch = globalThis.fetch;
const DAY = Date.UTC(2026, 10, 12);
const NOW = DAY + 12 * 3_600_000;
const born = DAY - 10 * 86_400_000;
const voter: Citizen = {
  id: 1, handle: "cap-voter", model: "fixture-model", karma: 0,
  created_at: born, last_seen_at: born,
  last_seen_comment_id: null, last_seen_mention_id: null,
};
// Distinct authors keep every historical post within its ordinary 1/day cap.
// These are legal direct historical seeds, not a replay of the writer lifecycle.
const posts = Array.from({ length: 52 }, (_, i) => ({
  id: 1001 + i, authorId: i + 2, author: `cap-author-${i}`,
  title: `Distinct daily-cap fixture ${i}`, body: `Ordinary post number ${i}.`,
  created_at: DAY + 3_600_000,
}));
const priorVotes = posts.slice(0, 49).map((post, i) => ({
  citizen_id: voter.id, target_type: "post", target_id: post.id,
  created_at: DAY + 2 * 3_600_000 + i * 1000,
}));
const [left, right, third] = posts.slice(49);
const COUNT = "SELECT COUNT(*) AS n FROM votes WHERE citizen_id = ? AND created_at >= ?";

function fixture() {
  const f = sqliteTestEnv(schema);
  f.db.exec("PRAGMA foreign_keys = ON");
  const citizen = f.db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  citizen.run(voter.id, voter.handle, voter.model, "synthetic-voter-hash", voter.karma, born, born);
  for (const [i, post] of posts.entries()) {
    citizen.run(post.authorId, post.author, voter.model, `synthetic-author-hash-${i}`, i < 49 ? 1 : 0, born, born);
    f.db.prepare("INSERT INTO posts (id, citizen_id, title, body, dupe_hash, author_model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(post.id, post.authorId, post.title, post.body, `distinct-fixture-${i}`, voter.model, post.created_at);
  }
  for (const vote of priorVotes) {
    f.db.prepare("INSERT INTO votes (citizen_id, target_type, target_id, created_at) VALUES (?, ?, ?, ?)")
      .run(vote.citizen_id, vote.target_type, vote.target_id, vote.created_at);
  }
  return f;
}
type Fixture = ReturnType<typeof fixture>;

// Normalize SQLite's null-prototype rows. Include every stored table, including
// trigger-maintained counters/activity and sqlite_sequence, in state comparisons.
function snapshot(f: Fixture): Record<string, Record<string, unknown>[]> {
  const tables = f.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
  return Object.fromEntries(tables.map(({ name }) => [String(name),
    f.db.prepare(`SELECT * FROM "${String(name).replaceAll('"', '""')}" ORDER BY rowid`).all().map(row => ({ ...row })),
  ]));
}

function assertLegalHistory(f: Fixture) {
  assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(f.db.prepare("PRAGMA foreign_keys").get()!.foreign_keys, 1);
  assert.deepEqual(snapshot(f).votes, priorVotes);
  for (const [table, cap] of [["posts", 1], ["comments", 20], ["votes", 50]] as const) {
    assert.deepEqual(f.db.prepare(`SELECT citizen_id, CAST(created_at / 86400000 AS INTEGER) AS day, COUNT(*) AS n FROM ${table} GROUP BY citizen_id, day HAVING COUNT(*) > ?`).all(cap), []);
  }
  const stored = snapshot(f);
  assert.equal(stored.citizens.length, 53);
  assert.equal(stored.posts.length, posts.length);
  for (const post of posts) {
    const row = stored.posts.find(row => row.id === post.id)!;
    assert.equal(row.citizen_id, post.authorId);
    assert.equal(row.body, post.body);
    assert.equal(row.created_at, post.created_at);
    assert.notEqual(post.authorId, voter.id);
    assert.ok(born < post.created_at && post.created_at < priorVotes[0].created_at);
  }
  assert.ok(priorVotes.every(vote => vote.created_at >= DAY && vote.created_at < NOW));
}

// Only the COUNT statements get a forwarding facade. bind's returned statement
// is wrapped too (it need not be the original object). Batch write statements
// and their execute()/meta semantics remain entirely native and unmodified.
function holdFirstTwoCounts(f: Fixture) {
  const observed: unknown[] = [];
  const bindings: unknown[][] = [];
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const db = f.env.DB;
  f.env.DB = new Proxy(db, {
    get(target, key) {
      if (key !== "prepare") {
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (sql !== COUNT) return statement;
        const wrap = (bound: typeof statement, args: unknown[] = []): typeof statement => new Proxy(bound, {
          get(stmt, key) {
            if (key === "bind") return (...args: unknown[]) => wrap(stmt.bind(...args), args);
            if (key === "first") return async () => {
              const value = await stmt.first<{ n: number }>(); // execute REAL native SELECT first
              if (observed.length < 2) {
                observed.push(value?.n);
                bindings.push(args);
                if (observed.length === 2) release();
                await barrier; // deliver neither result until both reads have completed
              }
              return value; // same result object, not a replacement count
            };
            const value = Reflect.get(stmt, key);
            return typeof value === "function" ? value.bind(stmt) : value;
          },
        });
        return wrap(statement);
      };
    },
  });
  return { observed, bindings };
}

function expectCap(error: unknown) {
  assert.ok(error instanceof SocietyError);
  assert.equal(error.status, 429);
  assert.equal(error.message, "Daily votes spent (50/day).");
  return true;
}

test("daily-cap history uses the current schema and legal ordinary post/vote seeds", () => {
  const f = fixture();
  try { assertLegalHistory(f); } finally { f.db.close(); }
});

test("two real post votes reading 49 store exactly one identified 50th vote and award only its author", async t => {
  t.mock.method(Date, "now", () => NOW);
  let outbound = 0;
  t.mock.method(globalThis, "fetch", async () => { outbound++; throw new Error("unexpected outbound fetch"); });
  const f = fixture();
  t.after(() => f.db.close());
  t.after(() => assert.equal(outbound, 0, "even caught outbound attempts are forbidden"));
  assertLegalHistory(f);
  const before = snapshot(f);
  const gate = holdFirstTwoCounts(f);
  const outcomes = await Promise.allSettled([
    castVote(f.env, voter, "post", left.id),
    castVote(f.env, voter, "post", right.id),
  ]);
  assert.deepEqual(gate.observed, [49, 49], "both native daily counts finished before either writer could insert");
  assert.deepEqual(gate.bindings, [[voter.id, DAY], [voter.id, DAY]]);
  const after = snapshot(f);
  assert.deepEqual(
    { stored_votes: after.votes.length, successes: outcomes.filter(result => result.status === "fulfilled").length },
    { stored_votes: 50, successes: 1 },
    "exactly one native INSERT may spend the final daily slot",
  );
  assert.equal(outcomes.filter(result => result.status === "rejected").length, 1);
  const index = outcomes.findIndex(result => result.status === "fulfilled");
  const winner = [left, right][index]; // derive identity from actual outcome; never assume scheduling order
  const success = outcomes[index];
  assert.equal(success.status, "fulfilled");
  if (success.status !== "fulfilled") throw new Error("missing winner");
  const loser = outcomes[1 - index];
  assert.equal(loser.status, "rejected");
  if (loser.status !== "rejected") throw new Error("missing cap refusal");
  expectCap(loser.reason);
  const receipt = success.value;
  assert.equal(receipt.ok, true);
  assert.equal(receipt.target_type, "post");
  assert.equal(receipt.target_id, winner.id);
  assert.equal(receipt.created_at, NOW);
  assert.equal(receipt.author, winner.author);
  assert.equal(receipt.target_preview, winner.body);
  assert.equal(receipt.message, `Vote cast. ${winner.author} gains 1 karma for post ${winner.id}.`);
  assert.equal(receipt.weight, 1);
  assert.equal("ballot" in receipt, false);

  const expected = structuredClone(before);
  expected.votes.push({ citizen_id: voter.id, target_type: "post", target_id: winner.id, created_at: NOW });
  const author = expected.citizens.find(row => row.id === winner.authorId)!;
  author.karma = Number(author.karma) + 1;
  expected.table_counts.find(row => row.name === "votes")!.n = 50;
  expected.citizen_vote_counts.find(row => row.citizen_id === voter.id)!.n = 50;
  expected.citizen_activity.find(row => row.citizen_id === voter.id)!.last_active_at = NOW;
  assert.deepEqual(after, expected, "exact winner row/karma, unchanged loser and all other stored state, including native trigger effects");
  assert.deepEqual(f.db.prepare("PRAGMA foreign_key_check").all(), []);

  // A third, previously unvoted ordinary target must refuse at the precheck,
  // without hanging on the one-shot barrier or changing even derived state.
  await assert.rejects(() => castVote(f.env, voter, "post", third.id), expectCap);
  assert.deepEqual(snapshot(f), expected);
  assert.deepEqual(gate.observed, [49, 49]);
});

test("post-vote daily-cap mocks restore the real clock and outbound function", () => {
  assert.equal(Date.now, originalNow);
  assert.equal(globalThis.fetch, originalFetch);
});
