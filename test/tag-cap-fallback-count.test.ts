// WQ-679 reconciliation: fixing scan-guard's tokenizer made the per-post tag
// cap's FALLBACK count visible —
//   SELECT COUNT(*) AS n FROM tags WHERE citizen_id = ? AND post_id = ?
// (src/society.ts, inside applyCommunityTag). It runs only when an OR IGNORE
// insert produced no row AND the tag is not already the citizen's: the count
// then distinguishes the per-post cap (429 "tags per post per citizen") from the
// daily cap. No existing test drove a 6th distinct tag onto one post, so the
// branch was never executed. This covers it against the real database.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { applyCommunityTag, type Citizen, type Env } from "../src/society.ts";
import { TAGS_PER_POST_PER_CITIZEN } from "../src/tags.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const CITIZEN = { id: 7, handle: "tagger" } as Citizen;

function seed(): Env {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (7, 'tagger', 'test', 's7', 0, 0, 0)").run();
  db.prepare("INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at) VALUES (1, 7, 'a post', 'b', 'h', 1000)").run();
  return env;
}

test("a 6th distinct tag on one post is refused with the per-post 429, via the fallback count", async () => {
  const env = seed();
  // Fill the per-post cap with distinct tags (well under the 20/day daily cap).
  for (let i = 1; i <= TAGS_PER_POST_PER_CITIZEN; i++) {
    const r = await applyCommunityTag(env, CITIZEN, 1, `tag-${i}`, false);
    assert.equal((r as { tag: string }).tag, `tag-${i}`, `tag ${i} applied`);
  }
  // The (cap+1)th DISTINCT tag: the OR IGNORE insert finds the per-post cap
  // already met, writes no row, the tag is not already this citizen's, so the
  // fallback COUNT runs and returns TAGS_PER_POST_PER_CITIZEN -> per-post 429.
  await assert.rejects(
    () => applyCommunityTag(env, CITIZEN, 1, "tag-over", false),
    (e: unknown) => {
      const err = e as { status?: number; message?: string };
      assert.equal(err.status, 429, "the per-post cap is a 429");
      assert.match(err.message ?? "", /tags per post per citizen/, "and it names the per-post cap, not the daily one");
      return true;
    },
  );
  // Re-applying one of the EXISTING tags is idempotent, not a 429 (the fallback
  // count branch is skipped because the tag is already the citizen's).
  const again = await applyCommunityTag(env, CITIZEN, 1, "tag-1", false);
  assert.equal((again as { tag: string }).tag, "tag-1");
});
