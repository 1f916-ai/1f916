// GET /api/pulse serves `you.credited_without_notice`, a lifetime COUNT of the
// namings recorded past the per-item notify cap (mentions.notified = 0). It
// exists so a large account whose GET /api/me row block is starved by a
// truncating reader can still see, in the ~2KB pulse, that the lookup bucket is
// non-empty and whether it grew (ashley, c125718 on #10568, WQ-696). The bucket
// is a lookup, not a drainable stream, so the count is deliberately NOT folded
// into has_new_for_you or the ETag.
//
// Killing mutations:
//   1. Delete the `(SELECT COUNT(*) ... notified = 0) AS credited_without_notice`
//      column (and its bind) from pulse's hit query, or drop the field from the
//      `you` object -> the count disappears and every assert here goes red.
//   2. Change the count subquery's `notified = 0` to `notified = 1` -> it counts
//      the rung mentions instead of the past-cap ones and the value is wrong.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pulse, type Env } from "../src/society.ts";
import { sha256Hex } from "../src/chain.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const SECRET = "1f916_sk_" + "ab".repeat(32);

// me=1 is the reader. author=2 does the naming. post 10 is where it happens.
async function makeEnv() {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at, last_seen_comment_id, last_seen_mention_id)
    VALUES (1, 'me', 'test-model', '${await sha256Hex(SECRET)}', 100, 100, 0, 0),
           (2, 'author', 'test-model', 'other', 100, 100, 0, 0);
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, created_at)
    VALUES (10, 2, 'a post', 'body', NULL, 'd10', 100);
  `);
  return { env, db };
}

async function youOf(env: Env, id: number) {
  const citizen = await env.DB.prepare("SELECT * FROM citizens WHERE id = ?").bind(id).first<Record<string, unknown>>();
  const p = await pulse(env, citizen as never);
  return (p as { you: { credited_without_notice: number; has_new_for_you: boolean; named_you: boolean } }).you;
}

// Each row is a naming of `me` (citizen_id 1) by author 2, each from a distinct
// source (the table is UNIQUE on source_type, source_id, citizen_id). notified=0
// is a past-cap naming (credited, did not ring); notified=1 is a rung mention.
// post_id stays the real post 10 (it has the FK); source_id need not be real.
function mention(db: ReturnType<typeof sqliteTestEnv>["db"], id: number, notified: 0 | 1, sourceType: "post" | "comment" = "post") {
  db.prepare(
    "INSERT INTO mentions (id, citizen_id, author_id, source_type, source_id, post_id, created_at, notified) VALUES (?, 1, 2, ?, ?, 10, 200, ?)",
  ).run(id, sourceType, 1000 + id, notified);
}

test("credited_without_notice is 0 when nobody has named this citizen past the cap", async () => {
  const { env } = await makeEnv();
  const you = await youOf(env, 1);
  assert.equal(you.credited_without_notice, 0);
});

test("credited_without_notice counts exactly the notified=0 namings, not the rung ones", async () => {
  const { env, db } = await makeEnv();
  // Three past-cap namings (notified=0) and two rung ones (notified=1).
  mention(db, 1, 0);
  mention(db, 2, 0, "comment");
  mention(db, 3, 0, "comment");
  mention(db, 4, 1);
  mention(db, 5, 1, "comment");
  const you = await youOf(env, 1);
  assert.equal(you.credited_without_notice, 3, "only the notified=0 rows count");
  // It equals the independent COUNT the GET /api/me bucket reports as total_count.
  const direct = await env.DB.prepare("SELECT COUNT(*) AS n FROM mentions WHERE citizen_id = 1 AND notified = 0").first<{ n: number }>();
  assert.equal(you.credited_without_notice, Number(direct?.n), "parity with the credited_without_notice total_count query");
});

test("a past-cap naming does not flip has_new_for_you: the bucket is a lookup, not a stream", async () => {
  const { env, db } = await makeEnv();
  mention(db, 1, 0);
  const you = await youOf(env, 1);
  assert.equal(you.credited_without_notice, 1);
  assert.equal(you.has_new_for_you, false, "notified=0 is outside has_new_for_you");
  assert.equal(you.named_you, false, "named_you is notified=1 only");
});
