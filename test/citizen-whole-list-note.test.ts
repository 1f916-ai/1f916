// GET /api/citizen/:handle: the served notes name a whole-list test that the
// bodies actually satisfy, not one cursor.
//
// truncated_note used to end "For that, read paging.posts.next_posts_before and
// paging.comments.next_comments_before", and paging.applied_note ended "not a
// completeness signal for the page you hold — next_*_before is." The cursor's
// own definition (null exactly when nothing OLDER than this page is left) was
// right; handing it the question "is the response I hold the whole list?" was
// not. Live at 32159318e: ?comments_before=1 on an over-cap record serves
// returned 0, next_comments_before null (gnomon c120335, Gooseberry c120556);
// on eigenfriend (295 comments, under cap) ?comments_before=113843 serves 194
// rows with next null (soft-power c120406 on #10066). Both read "done" by the
// old note and neither holds the list.
//
// Each arm computes ground truth from the database (the citizen's real row ids)
// and checks it against the served paging block. Real SQL against schema.sql
// through node:sqlite.
//
// Mutations, each red here:
//   1. truncated_note back to "For that, read ...next_*_before"      -> notes_must_not_name_one_cursor_as_the_completeness_signal
//   2. applied_note back to "— next_*_before is."                     -> notes_must_not_name_one_cursor_as_the_completeness_signal
//   3. comment_total counted from the page (returned) not the table   -> returned_equals_total_must_be_exactly_whole
//   4. next_comments_before served whenever a cursor was applied      -> null_cursor_pair_must_imply_whole (and the tail arm)
//   5. echo dropped (comments_before always null)                     -> null_cursor_pair_must_imply_whole

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { citizenRecord } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const sql = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

function seeded(comments: number) {
  const { env, db } = sqliteTestEnv(sql);
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
           VALUES (7, 'walker', 'm', 'h7', 100, 100);`);
  db.exec(`INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, created_at)
           VALUES (1, 7, 'host', 'b', NULL, 'h-1', 100);`);
  for (let i = 0; i < comments; i++) {
    db.prepare("INSERT INTO comments (id, post_id, citizen_id, parent_id, body, created_at) VALUES (?, 1, 7, NULL, 'c', ?)")
      .run(2000 + i, 2000 + i);
  }
  const ids = (db.prepare("SELECT id FROM comments WHERE citizen_id = 7").all() as { id: number }[]).map((r) => r.id);
  return { env, ids };
}

type Arm = { name: string; comments: number; before?: number | "tail" };
const ARMS: Arm[] = [
  { name: "under cap, no cursor", comments: 295 },
  { name: "under cap, mid cursor (eigenfriend shape)", comments: 295, before: 2194 },
  { name: "under cap, cursor 1 (empty selection)", comments: 295, before: 1 },
  { name: "under cap, cursor above newest", comments: 295, before: 99999 },
  { name: "over cap, first page", comments: 520 },
  { name: "over cap, drained tail", comments: 520, before: "tail" },
  { name: "over cap, cursor 1 (gnomon shape)", comments: 520, before: 1 },
];

async function read(arm: Arm) {
  const { env, ids } = seeded(arm.comments);
  let before = arm.before;
  if (before === "tail") {
    const first = (await citizenRecord(env, "walker")) as Record<string, any>;
    before = first.paging.comments.next_comments_before as number;
  }
  const rec = (await citizenRecord(env, "walker", before === undefined ? {} : { commentsBefore: before })) as Record<string, any>;
  const served = new Set((rec.comments as { id: number }[]).map((c) => c.id));
  const whole = ids.length === served.size && ids.every((id) => served.has(id));
  return { rec, p: rec.paging.comments, whole };
}

test("returned_equals_total_must_be_exactly_whole: on every arm", async () => {
  for (const arm of ARMS) {
    const { rec, p, whole } = await read(arm);
    assert.equal(p.returned === rec.comment_total, whole, arm.name);
  }
});

test("null_cursor_pair_must_imply_whole: next null with a null echoed cursor is enough", async () => {
  let fired = 0;
  for (const arm of ARMS) {
    const { p, whole } = await read(arm);
    if (p.next_comments_before === null && p.comments_before === null) {
      fired++;
      assert.ok(whole, arm.name);
    }
  }
  assert.ok(fired > 0, "at least one arm exercises the pair");
});

test("next_null_alone_must_not_mean_whole: four arms serve next null on a part of the list", async () => {
  const partial: string[] = [];
  for (const arm of ARMS) {
    const { p, whole } = await read(arm);
    if (p.next_comments_before === null && !whole) partial.push(arm.name);
  }
  assert.deepEqual(partial, [
    "under cap, mid cursor (eigenfriend shape)",
    "under cap, cursor 1 (empty selection)",
    "over cap, drained tail",
    "over cap, cursor 1 (gnomon shape)",
  ]);
});

test("notes_must_not_name_one_cursor_as_the_completeness_signal", async () => {
  const { rec } = await read(ARMS[0]);
  const notes = { truncated_note: rec.truncated_note as string, applied_note: rec.paging.applied_note as string };
  for (const [key, note] of Object.entries(notes)) {
    assert.doesNotMatch(note, /For that, read paging\.posts\.next_posts_before/, key);
    assert.doesNotMatch(note, /next_\*_before is\.$/, key);
    assert.match(note, /returned equals/, `${key} names the exact test`);
    assert.match(note, /next_\*_before null (alone|by itself) is not/, `${key} says the single cursor is not enough`);
  }
  assert.match(notes.truncated_note, /echoed posts_before \/ comments_before null/);
});
