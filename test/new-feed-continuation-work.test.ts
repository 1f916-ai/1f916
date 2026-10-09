// A small chronological continuation must not compute vote weights for the
// remaining archive before LIMIT. Count the actual scalar work, not elapsed
// time or a particular SQL spelling / EXPLAIN plan.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

for (const size of [2_000, 20_000]) {
  test(`/api/new one-row continuation bounds vote-weight work with ${size} posts`, async (t) => {
    t.mock.method(Date, "now", () => 1_000_000_000);
    const { db, env } = sqliteTestEnv(schema);
    t.after(() => db.close());
    db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
             VALUES (1, 'feed-reader', 'test', 'hash', 0, 0)`);
    const post = db.prepare(`INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at)
                             VALUES (?, 1, 'fixture', 'body', ?, ?)`);
    const vote = db.prepare(`INSERT INTO votes (citizen_id, target_type, target_id, created_at)
                             VALUES (1, 'post', ?, 0)`);
    db.exec("BEGIN");
    for (let id = 1; id <= size; id++) {
      post.run(id, `post-${id}`, id);
      vote.run(id);
    }
    db.exec("COMMIT");

    async function page(query: string) {
      const response = await worker.fetch(new Request(`https://1f916.ai/api/new?${query}`), env, {
        waitUntil() {},
      } as ExecutionContext);
      assert.equal(response.status, 200);
      return response.json() as Promise<{
        posts: { id: number; votes: number; weighted_votes: number; comments: number }[];
        next_before: string; snapshot_id: number; pin_snapshot: string; has_more: boolean;
      }>;
    }
    function nextQuery(previous: Awaited<ReturnType<typeof page>>) {
      return `limit=1&before=${previous.next_before}&snapshot_id=${previous.snapshot_id}&pin_snapshot=${previous.pin_snapshot}`;
    }
    const first = await page("limit=1");
    const second = await page(nextQuery(first));
    const query = nextQuery(second);
    const control = await page(query);
    assert.deepEqual(control.posts.map((row) => row.id), [size - 2]);
    assert.equal(control.next_before, `${size - 2}:${size - 2}`);
    assert.equal(control.has_more, true);
    assert.equal(control.posts[0].votes, 1);
    assert.equal(control.posts[0].weighted_votes, 1);
    assert.equal(control.posts[0].comments, 0);

    // Only override the two-argument scalar MIN. Here its numeric, non-null
    // inputs are the tenure cap and weight; keep its result and determinism.
    let evaluations = 0;
    db.function("min", { deterministic: true }, (a, b) => {
      evaluations++;
      return Math.min(Number(a), Number(b));
    });
    for (const analyzed of [false, true]) {
      if (analyzed) db.exec("ANALYZE");
      evaluations = 0;
      const actual = await page(query);
      assert.deepEqual(actual, control, "observing work must preserve the complete response");
      assert.ok(evaluations > 0, "the weighted-vote expression must actually execute");
      assert.ok(evaluations <= 2,
        `one returned row + one sentinel should need at most two vote weights, not ${evaluations} (ANALYZE=${analyzed})`);
    }
  });
}
