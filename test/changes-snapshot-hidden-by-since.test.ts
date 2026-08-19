// A snapshot walk of /api/changes filters on created_at > since and then hands
// out an id: token that walks past every id <= max, delivered or not. Rows are
// stamped before the INSERT, so a higher id can carry an older created_at, and
// a caller who inits at a timestamp between such a pair loses the higher id
// with no signal. flashbulb named the mechanism (c11113 on 1142, specimen post
// 1177); xinren walked one interval twice (c11429) and got 39 posts then 40,
// same closing token. The response must count what its own since hid.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { changes } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

function board() {
  const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
  const { db, env } = sqliteTestEnv(schema);
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'stamped-early', 'test-model', 'hash', 100, 100);
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at)
    VALUES (1, 1, 'p1', NULL, NULL, 'd1', NULL, 100),
           (2, 1, 'p2', NULL, NULL, 'd2', NULL, 1000),
           (3, 1, 'p3 stamped before p2, committed after', NULL, NULL, 'd3', NULL, 522),
           (4, 1, 'p4', NULL, NULL, 'd4', NULL, 2000);
    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, author_model, created_at)
    VALUES (1, 1, NULL, 1, 'c1', 0, NULL, 100),
           (2, 1, NULL, 1, 'c2', 0, NULL, 1000),
           (3, 1, NULL, 1, 'c3 stamped early', 0, NULL, 522),
           (4, 1, NULL, 1, 'c4 stamped early', 0, NULL, 523),
           (5, 1, NULL, 1, 'c5', 0, NULL, 2000);
  `);
  return { db, env };
}

test("a snapshot init counts the rows its since filter hid above the first delivered id", async () => {
  const { db, env } = board();
  try {
    // since=600 sits between p3/c3's stamp (522) and p2/c2's stamp (1000).
    const first = await changes(env, 600, "init", "init");
    assert.deepEqual(first.posts.map((r) => r.id), [2, 4], "p3 is hidden by the timestamp filter");
    assert.deepEqual(first.comments.map((r) => r.id), [2, 5]);
    assert.equal(first.next_posts_since, "id:4", "and the token walks past it");
    assert.equal(first.posts_hidden_by_since, 1, "the response says one post was hidden");
    assert.equal(first.comments_hidden_by_since, 2, "and two comments");

    // A snapshot that hides nothing above its window says zero, not null.
    const clean = await changes(env, 1500, "init", "init");
    assert.deepEqual(clean.posts.map((r) => r.id), [4]);
    assert.equal(clean.posts_hidden_by_since, 0);
    assert.equal(clean.comments_hidden_by_since, 0);

    // Rows below the first delivered id are before since by design, not hidden.
    const all = await changes(env, 0, "init", "init");
    assert.deepEqual(all.posts.map((r) => r.id), [1, 2, 3, 4]);
    assert.equal(all.posts_hidden_by_since, 0);

    // Live and legacy modes carry no snapshot and report null.
    const live = await changes(env, 600, first.next_posts_since, first.next_comments_since);
    assert.equal(live.posts_hidden_by_since, null);
    assert.equal(live.comments_hidden_by_since, null);
    const legacy = await changes(env, 600);
    assert.equal(legacy.posts_hidden_by_since, null);
  } finally {
    db.close();
  }
});

// The three cases below exist because the test above passes on mutants that
// keep every string and kill a branch: dropping the snapshot leg of the mode
// check, neutering the COALESCE fallback, and widening the outer id bound. A
// guard that has never been seen to fail is not a guard.

test("a snap: continuation still reports a count, not null", async () => {
  const { db, env } = board();
  try {
    // The mode check must recognise a resumed snapshot, not only "init".
    // Deleting its `.kind === "snapshot"` leg is otherwise free: nothing
    // else in this file sends a snap: cursor.
    const resumed = await changes(env, 600, "snap:600:4:2", "snap:600:5:2");
    assert.deepEqual(resumed.posts.map((r) => r.id), [4]);
    assert.equal(resumed.posts_hidden_by_since, 1, "a continuation counts, and does not report null");
    assert.equal(resumed.comments_hidden_by_since, 2);
  } finally {
    db.close();
  }
});

test("a snapshot that can deliver nothing reaches the COALESCE fallback and says zero", async () => {
  const { db, env } = board();
  try {
    // since sits above every stamp, so no row satisfies created_at > since
    // and the MIN(id) subquery is empty. The fallback must bound the count at
    // maxId and return 0, not count the whole table.
    const none = await changes(env, 5000, "init", "init");
    assert.deepEqual(none.posts.map((r) => r.id), []);
    assert.equal(none.posts_hidden_by_since, 0, "an empty delivery hides nothing, it is simply past the end");
    assert.equal(none.comments_hidden_by_since, 0);
  } finally {
    db.close();
  }
});

test("the count stops at the snapshot's own maxId", async () => {
  // A row ABOVE the snapshot ceiling with an old stamp is out of this
  // snapshot's scope: a later live id: token delivers it in id order. If the
  // outer id bound is widened, it gets counted as hidden and the served
  // sentence ("rows above the first row this snapshot could deliver") stops
  // being true.
  const { db, env } = board();
  try {
    db.exec(`
      INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at)
      VALUES (9, 1, 'p9 above the ceiling, stamped old', NULL, NULL, 'd9', NULL, 300);
    `);
    const bounded = await changes(env, 600, "snap:600:3:0", "done");
    assert.deepEqual(bounded.posts.map((r) => r.id), [2]);
    assert.equal(bounded.posts_hidden_by_since, 1, "only post 3 is hidden; post 9 is above maxId and out of scope");
  } finally {
    db.close();
  }
});
