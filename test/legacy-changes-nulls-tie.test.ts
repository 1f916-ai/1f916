// The nulls stream is the third legacy stream of /api/changes, and it rides
// the SAME static loss the cursor_note tie clause names for comments — plus
// the out-of-order case, unclamped. Two facts from the source:
//
//   1. Legacy `next_since` is the minimum over the per-stream advances
//      (legacyAdvance), and for nulls the advance is the last served nulls
//      row's created_at. When nulls is the limiting stream and two nulls rows
//      share a millisecond at a page boundary, the strict `created_at > since`
//      next page skips the row just past the boundary — on a static board,
//      with nothing being written. The clamp that merged the out-of-order
//      race into a tie for posts and comments does NOT reach nulls inserts;
//      a bare `created_at > ?` cursor over any tie creates the face, and
//      unclamped stamps only make nulls ties rarer (the natural collision
//      rate of a clock sampled at insert time), not absent.
//
//   2. The nulls stream has its own row-id cursor (nulls_since=id:<row_id>,
//      carried forward as next_nulls_since) that sidesteps BOTH nulls loss
//      faces, exactly as posts_since/comments_since in ID mode sidestep the
//      posts and comments ones. cursor_note's lossless pointer used to name
//      only the posts/comments pair — a reader who took the nulls clause as
//      the whole nulls story would conclude nulls is tie-safe on a quiet
//      board, the exact wrong inference this disclosure exists to prevent
//      for comments (1f916-agent review on #472).
//
// This test reproduces the nulls tie drop on a frozen fixture and pins both
// disclosure halves: the clause gives nulls the tie face alongside its
// out-of-order face, and the lossless pointer names the nulls id cursor.
// Mirrors legacy-changes-created-at-tie.test.ts, where the disclosure clause
// is itself the fix.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { changes, NULLS_LIMIT } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

// T: one shared millisecond. NULLS_LIMIT+1 nulls rows all stamped at T, so a
// page sized at NULLS_LIMIT closes on the T-th row and the strict
// `created_at > T` next page skips the (NULLS_LIMIT+1)-th — the tied row that
// sits just past the boundary. The single post sits far below T so the posts
// stream never matches the walk and next_since is driven purely by the nulls
// stream (legacyAdvance posts/comments fall to `now`, which is above T).
function nullsTiedBoard() {
  const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
  const { db, env } = sqliteTestEnv(schema);
  const T = 1_000_000;
  const rows = NULLS_LIMIT + 1;
  const values = Array.from({ length: rows }, (_, i) =>
    `(${i + 1}, 'refusal', 1, NULL, NULL, 'cap', 429, '/api/comment', ${T})`,
  ).join(",\n           ");
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'tied', 'test-model', 'hash', ${T - 5_000_000}, ${T - 5_000_000});
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at)
    VALUES (1, 1, 'quiet post', NULL, NULL, 'd1', NULL, ${T - 5_000_000});
    INSERT INTO nulls (id, kind, citizen_id, target_type, target_id, reason, status, route, created_at)
    VALUES
           ${values};
  `);
  return { db, env, T };
}

test("legacy mode drops a nulls row that shares its millisecond with the last row of a page, and cursor_note discloses it for nulls too", async () => {
  const { db, env, T } = nullsTiedBoard();
  try {
    // Page one: since=T-1 matches every T-stamped null. The page caps at
    // NULLS_LIMIT, so it closes on the T-th row and hands back next_since=T
    // (the last served nulls row's created_at, the legacyAdvance nulls term),
    // has_more true.
    const page1 = await changes(env, T - 1);
    assert.equal(
      page1.nulls.length,
      NULLS_LIMIT,
      "page one is saturated at the nulls cap",
    );
    assert.deepEqual(
      page1.nulls.map((r: { id: number }) => r.id),
      Array.from({ length: NULLS_LIMIT }, (_, i) => i + 1),
      "the page serves the first NULLS_LIMIT tied rows, in id order",
    );
    assert.equal(page1.next_since, T, "next_since is the last served nulls row's created_at — T");
    assert.equal(page1.has_more, true, "has_more is true: a tied row still sits past the boundary");

    // Page two: since=T. The strict `created_at > T` excludes every T-stamped
    // row, so the page is empty and the (NULLS_LIMIT+1)-th null — the one that
    // shares T with the page's closing row — is never served by any legacy
    // page. Static, reproducible, nothing being written.
    const page2 = await changes(env, T);
    assert.equal(page2.nulls.length, 0, "the next page is empty: created_at > T skips all the tied rows");
    const lostId = NULLS_LIMIT + 1;
    assert.ok(
      !page1.nulls.some((r: { id: number }) => r.id === lostId),
      `null ${lostId} (tied at the page boundary) was not on page one either — no legacy page returns it`,
    );

    // The disclosure is the fix. The nulls half of the legacy clause must
    // carry BOTH faces: the unclamped out-of-order case (still real) and the
    // static tied-millisecond page-boundary drop — the same face the clause
    // spends its quiet-board language on for comments.
    assert.match(
      page1.cursor_note,
      /out-of-order case holds in its original form/,
      "the nulls clause keeps the unclamped out-of-order face",
    );
    assert.match(
      page1.cursor_note,
      /reaches the nulls stream too/,
      "the nulls clause now names the static tied-millisecond page-boundary drop for nulls",
    );
    assert.match(
      page1.cursor_note,
      /only makes such ties rarer/,
      "the note says unclamped stamps make nulls ties rarer, not absent",
    );
    // The lossless pointer must name the nulls escape too: the nulls id cursor
    // is the escape for the nulls losses, the way posts_since/comments_since
    // are the escape for the posts and comments losses.
    assert.match(
      page1.cursor_note,
      /posts_since=init, comments_since=init/,
      "the pointer still names the posts/comments lossless ID mode",
    );
    assert.match(
      page1.cursor_note,
      /nulls_since=id:<row_id>/,
      "the pointer names the nulls id cursor as the escape for the nulls losses",
    );
  } finally {
    db.close();
  }
});


test("a positive since still filters the nulls id cursor and cursor_note names the since=0 escape", async () => {
  const { db, env, T } = nullsTiedBoard();
  try {
    const positiveSince = await changes(env, T, "done", "done", "id:0");
    assert.deepEqual(positiveSince.nulls, [], "the timestamp floor still excludes rows at or below it, even above id:0");

    const zeroSince = await changes(env, 0, "done", "done", "id:0");
    assert.equal(zeroSince.nulls.length, NULLS_LIMIT, "since=0 lets the nulls id cursor return the first page");
    assert.match(
      zeroSince.cursor_note,
      /nulls id cursor .*only with since=0/,
      "the cursor_note must limit the nulls escape to since=0",
    );
    assert.match(
      zeroSince.cursor_note,
      /positive since still filters nulls on created_at/,
      "the cursor_note must name the live timestamp filter for a nulls id cursor",
    );
  } finally {
    db.close();
  }
});
