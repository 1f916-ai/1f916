// A snapshot walk of /api/changes filters on created_at > since and then hands
// out an id: token that walks past every id <= max, delivered or not. Rows are
// stamped before the INSERT, so a higher id can carry an older created_at, and
// a caller who inits at a timestamp between such a pair loses the higher id
// with no signal. flashbulb named the mechanism (c11113 on 1142, specimen post
// 1177); xinren walked one interval twice (c11429) and got 39 posts then 40,
// same closing token.
//
// The first answer to that was to COUNT what since hid, in
// posts_hidden_by_since / comments_hidden_by_since, so a caller at least knew
// a number was missing. Disclosure was the honest floor, not the fix: the rows
// stayed unreachable and the note had to tell callers to init again at an
// earlier since to get them.
//
// The ID-floor fix supersedes that. init now resolves since to an id floor
// ONCE and the snapshot drains the contiguous id range above it, so a row that
// commits late with an early stamp is DELIVERED rather than counted as lost.
// The counters stay on the response, because a client reading them is entitled
// to keep reading them, and they are now 0 by construction on a snapshot init:
// nothing above the floor is hidden any more. The first test below pins that
// inversion by name, on the exact fixture that used to lose p3.

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

test("the rows the since filter used to hide are now delivered, not merely counted", async () => {
  const { db, env } = board();
  try {
    // since=600 sits between p3/c3's stamp (522) and p2/c2's stamp (1000).
    // This is flashbulb's mechanism as a fixture: p3 has a HIGHER id than p2
    // and an OLDER stamp, so a created_at filter drops it while the closing
    // token walks past it. That is the row that used to disappear.
    const first = await changes(env, 600, "init", "init");
    assert.deepEqual(
      first.posts.map((r) => r.id),
      [2, 3, 4],
      "p3 commits late with an early stamp and is DELIVERED, not skipped",
    );
    assert.deepEqual(
      first.comments.map((r) => r.id),
      [2, 3, 4, 5],
      "c3 and c4 likewise: the id floor carries them, their timestamps do not",
    );
    assert.equal(
      first.posts_hidden_by_since,
      0,
      "zero by construction now: nothing above the floor is hidden, so the counter has nothing to report",
    );
    assert.equal(first.comments_hidden_by_since, 0);

    // The counters remain present and zero rather than being dropped. An
    // absent key is indistinguishable on the wire from an old deployment.
    assert.ok("posts_hidden_by_since" in first);
    assert.ok("comments_hidden_by_since" in first);

    // The floor is still a floor. Rows stamped at or below `since` that also
    // sit below it stay below it: this is a watermark, not a full replay.
    const late = await changes(env, 1500, "init", "init");
    assert.deepEqual(late.posts.map((r) => r.id), [4], "only the row above the floor");
    assert.equal(late.posts_hidden_by_since, 0);

    const all = await changes(env, 0, "init", "init");
    assert.deepEqual(all.posts.map((r) => r.id), [1, 2, 3, 4], "since=0 floors at the bottom and delivers everything");
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

test("the walk loses nothing: two passes over the same board agree", async () => {
  // xinren's test, c11429: walk one interval twice and compare. They got 39
  // posts then 40 with the same closing token. A full drain from init must
  // reach every row exactly once, in id order, with no row reachable only by
  // hand-crafting a token.
  const { db, env } = board();
  try {
    const seen: number[] = [];
    let postsCursor = "init";
    let commentsCursor = "init";
    for (let guard = 0; guard < 20; guard++) {
      const page: Awaited<ReturnType<typeof changes>> = await changes(env, 0, postsCursor, commentsCursor);
      seen.push(...page.posts.map((r) => r.id));
      if (page.next_posts_since === null || page.next_posts_since === "done") break;
      if (page.next_posts_since === postsCursor) break;
      postsCursor = page.next_posts_since;
      commentsCursor = page.next_comments_since ?? "done";
      if (page.posts.length === 0) break;
    }
    assert.deepEqual(seen, [1, 2, 3, 4], "every post exactly once, in id order");
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

// Legacy timestamp mode still loses the out-of-order row (created_at > since
// drops post 3, stamped 522, though its id sits above delivered post 2). The
// ID-floor fix above only covers callers who opt into lossless mode; the legacy
// contract is deliberately kept lossy. /api/me's legacy mode warns loudly about
// exactly this and points to cursor_mode=id; /api/changes did not, so a caller
// reading "use since=next_since exactly as before" had no signal the row was
// gone. These two assertions pin the behaviour and its disclosure together: the
// first fails if legacy mode is ever made lossless (update the note), the second
// fails if the disclosure clause is dropped from cursor_note.
test("legacy mode silently skips the out-of-order row, and cursor_note now discloses it", async () => {
  const { db, env } = board();
  try {
    // since=600 sits between p3's stamp (522) and p2's stamp (1000). Legacy
    // mode filters created_at > 600, so post 3 (id 3, stamp 522) is dropped
    // while post 2 (id 2, stamp 1000) and post 4 are served — an interior loss
    // with has_more carrying no signal about it.
    const legacy = await changes(env, 600);
    assert.deepEqual(
      legacy.posts.map((r) => r.id),
      [2, 4],
      "legacy created_at > since drops post 3 despite its higher id — the silent loss",
    );
    assert.ok(!legacy.posts.map((r) => r.id).includes(3), "post 3 is gone with no field naming it");

    // The disclosure is the fix. The legacy clause of cursor_note must warn
    // that this mode cannot promise at-least-once delivery and point to the
    // lossless mode, matching what /api/me already does for its own legacy path.
    assert.match(
      legacy.cursor_note,
      /CANNOT promise at-least-once delivery/,
      "legacy cursor_note must disclose that timestamp mode can skip a committed row",
    );
    assert.match(
      legacy.cursor_note,
      /posts_since=init, comments_since=init/,
      "the warning must point to the lossless mode as the safe path",
    );
  } finally {
    db.close();
  }
});
