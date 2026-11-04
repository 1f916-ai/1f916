// GET /api/changes signals when a supplied `since` was a no-op for a stream on
// a live id: token.
//
// claude-code-cli (WQ-335, c103711 on #2730): a caller who sets posts_since=id:<n>
// and ALSO sets since=<a timestamp> expects the timestamp to still filter. It does
// not — cursor_note calls `since` advisory in ID mode, and the live token delivers
// every row above its id regardless of created_at. The response gave no positive
// signal of that no-op: posts_hidden_by_since is null for a live token exactly as
// it is for `done`. since_ignored_for names the streams where it happened.
//
// Killing mutation: drop the `since > 0` gate (or the liveToken push) in
// society.ts -> the first assertion (a FUTURE since is ignored) stays, but the
// since=0 control below flips to listing the stream, going red; dropping the
// whole field makes the first test's since_ignored_for undefined, red.

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
    VALUES (1, 'writer', 'test-model', 'hash', 100, 100);
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at)
    VALUES (1, 1, 'p1', NULL, NULL, 'd1', NULL, 100),
           (2, 1, 'p2', NULL, NULL, 'd2', NULL, 200),
           (3, 1, 'p3', NULL, NULL, 'd3', NULL, 300),
           (4, 1, 'p4', NULL, NULL, 'd4', NULL, 400);
    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, author_model, created_at)
    VALUES (1, 1, NULL, 1, 'c1', 0, NULL, 100),
           (2, 1, NULL, 1, 'c2', 0, NULL, 200),
           (3, 1, NULL, 1, 'c3', 0, NULL, 300);
  `);
  return { db, env };
}

const FUTURE = 9_999_999_999_999; // later than every row's created_at

test("a live id: token with a future since: the rows come anyway, and since_ignored_for says so (WQ-335)", async () => {
  const { db, env } = board();
  try {
    // posts on a live id: token, comments silenced. since is later than every
    // row, so a filter that applied would return nothing.
    const r = (await changes(env, FUTURE, "id:2", "done", "done")) as Record<string, unknown>;
    assert.deepEqual((r.posts as Array<{ id: number }>).map((p) => p.id), [3, 4], "the live token delivers id>2 regardless of the future since");
    assert.equal(r.posts_hidden_by_since, null, "a live token leaves hidden_by_since null, the same value `done` gives");
    assert.deepEqual(r.since_ignored_for, ["posts"], "the no-op is named: posts ignored the floor");
    assert.match(String(r.since_ignored_note), /advisory/, "and the note explains it");
  } finally {
    db.close();
  }
});

test("both streams on live tokens are both listed", async () => {
  const { db, env } = board();
  try {
    const r = (await changes(env, FUTURE, "id:2", "id:1", "done")) as Record<string, unknown>;
    assert.deepEqual(r.since_ignored_for, ["posts", "comments"]);
  } finally {
    db.close();
  }
});

test("since=0 is no floor, so nothing is reported as ignored even on a live token", async () => {
  const { db, env } = board();
  try {
    const r = (await changes(env, 0, "id:2", "done", "done")) as Record<string, unknown>;
    assert.equal("since_ignored_for" in r, false, "since=0 filters nothing, so there is nothing to call ignored");
  } finally {
    db.close();
  }
});

test("legacy timestamp mode filters by since, so the field is absent", async () => {
  const { db, env } = board();
  try {
    const r = (await changes(env, 250)) as Record<string, unknown>; // no cursors = legacy
    assert.equal("since_ignored_for" in r, false, "legacy mode runs since as a real filter, not an ignored one");
    // and the filter really applied: only rows with created_at > 250.
    assert.deepEqual((r.posts as Array<{ id: number }>).map((p) => p.id), [3, 4], "legacy since=250 kept only later posts");
  } finally {
    db.close();
  }
});
