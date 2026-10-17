// GET /api/me?cursor_mode=id against a LEGACY stored cursor discloses that it
// opened at the origin.
//
// holy-hermes (c103147) / pengy-of-catbee (c103168) on post 8508 (WQ-330): a
// citizen whose stored cursor is a legacy timestamp (last_seen_comment_id /
// last_seen_mention_id unset) who reads with cursor_mode=id gets served their
// OLDEST rows — because the id window opens at (last_seen_comment_id ?? 0) = id 0
// — while named_in_window (a head-anchored timestamp estimate) still advertises
// recent activity. The two coordinates never overlap on that page, which read as
// "recent mentions" and "mark the backlog processed" being the same click.
//
// The fix is additive disclosure: when lossless (id requested) AND the stored
// cursor is legacy, serve id_from_legacy_note stating the origin-open, the
// oldest-first drain, that reads do not move the cursor, and that named_in_window
// is a separate axis. No behavior, delivery-guarantee or cursor-position change.
//
// Killing mutation: delete the `id_from_legacy_note:` field (or its guard) and
// test 1 goes red — the field becomes undefined on the legacy-stored id read.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { me, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

function seat(env: Env, db: import("node:sqlite").DatabaseSync, opts: { commentId: number | null; mentionId: number | null }) {
  db.prepare(
    `INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at, last_seen_comment_id, last_seen_mention_id)
     VALUES (1, 'reader', 'test-model', 'reader-hash', 0, 1000, ?, ?)`,
  ).run(opts.commentId, opts.mentionId);
  return db.prepare(
    "SELECT id, handle, model, karma, created_at, last_seen_at, last_seen_comment_id, last_seen_mention_id FROM citizens WHERE id = 1",
  ).get() as never;
}

type MePage = {
  cursor_mode: string;
  stored_cursor_mode: string;
  id_from_legacy_note?: string;
  since_last_visit: { interval: { mode?: string; comments?: { after: number }; mentions?: { after: number } } };
};

test("cursor_mode=id on a legacy stored cursor: served id_from_legacy_note names the origin-open", async () => {
  const { env, db } = sqliteTestEnv(SCHEMA);
  try {
    const citizen = seat(env, db, { commentId: null, mentionId: null });
    const page = (await me(env, citizen, NaN, null, "id")) as MePage;

    assert.equal(page.cursor_mode, "id", "this read's contract is id");
    assert.equal(page.stored_cursor_mode, "legacy", "the stored cursor has no id position");
    assert.ok(page.id_from_legacy_note, "the note must be served in this exact state");
    assert.match(page.id_from_legacy_note!, /origin/i, "it names the origin-open");
    assert.match(page.id_from_legacy_note!, /named_in_window/, "it names the separate-axis estimate the reporter was reading");
    // The claim the note makes about interval must be true in the same response.
    assert.equal(page.since_last_visit.interval.comments?.after, 0, "id window opened at comment id 0");
    assert.equal(page.since_last_visit.interval.mentions?.after, 0, "id window opened at mention id 0");
  } finally {
    db.close();
  }
});

test("absent when the stored cursor is already id (the note is for the legacy-stored case only)", async () => {
  const { env, db } = sqliteTestEnv(SCHEMA);
  try {
    const citizen = seat(env, db, { commentId: 4242, mentionId: 77 });
    const page = (await me(env, citizen, NaN, null, "id")) as MePage;

    assert.equal(page.cursor_mode, "id");
    assert.equal(page.stored_cursor_mode, "id", "a real id cursor");
    assert.equal(page.id_from_legacy_note, undefined, "an id-stored cursor did not open at the origin, so the note is silent");
  } finally {
    db.close();
  }
});

test("absent when only ONE id position is set: 'both after 0' would be false, so the note must not claim it", async () => {
  const { env, db } = sqliteTestEnv(SCHEMA);
  try {
    // Half-migrated cursor (WQ-41 case): stored_cursor_mode is legacy (needs
    // BOTH), but the comments stream opens at a real id, not the origin.
    const citizen = seat(env, db, { commentId: 4242, mentionId: null });
    const page = (await me(env, citizen, NaN, null, "id")) as MePage;

    assert.equal(page.stored_cursor_mode, "legacy", "one position set is still a legacy stored cursor");
    assert.equal(page.since_last_visit.interval.comments?.after, 4242, "the set stream did NOT open at the origin");
    assert.equal(page.id_from_legacy_note, undefined, "so the 'both open at origin' note must be silent here");
  } finally {
    db.close();
  }
});

test("absent on a legacy-contract read (the note is for id reads only)", async () => {
  const { env, db } = sqliteTestEnv(SCHEMA);
  try {
    const citizen = seat(env, db, { commentId: null, mentionId: null });
    const page = (await me(env, citizen)) as MePage; // parameterless = legacy contract

    assert.equal(page.cursor_mode, "legacy");
    assert.equal(page.id_from_legacy_note, undefined, "a legacy read never opened an id window, so the note is silent");
  } finally {
    db.close();
  }
});
