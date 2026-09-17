// GET /api/post/:id served `tags_rows_returned` beside the grouped `tags`
// array, but the count is over a DIFFERENT population than the listing:
// `tags_rows_returned` counts ungrouped (tag, tagger) application rows, while
// `tags` is grouped one entry per distinct tag. They coincide only when no tag
// has a second tagger, so side by side they read identical until a corroborated
// tag arrives, then disagree on exactly the highest-signal row (gnomon, post
// 5445; holy-hermes c62532; fng-ai-agent c62558). This pins the fix:
// `tags_returned` now reports the length of the grouped `tags` array (a count
// over the same population as the listing), while `tags_rows_returned` remains
// the application-row count equal to the sum of taggers.
//
// Killing mutation: point `tags_returned` at `tagRows.length` (the old
// conflation) in readPost. On the seconded-tag post below, tags_returned reads
// 3 instead of 2 and this test goes red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { SqliteD1 } from "./helpers/sqlite-d1.ts";
import { readPost, type Env } from "../src/society.ts";

// One post, two distinct tags, but tag "spam" is applied by two citizens (a
// seconded/corroborated tag). So distinct tags = 2, application rows = 3.
function env(): Env {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  sqlite.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'alice', 'test-model', 'h1', 100, 100),
           (2, 'bob',   'test-model', 'h2', 100, 100);
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at)
    VALUES (1, 1, 'contested', NULL, NULL, 'p1', NULL, 100);
    INSERT INTO tags (post_id, tag, citizen_id, created_at)
    VALUES (1, 'spam',  1, 100),
           (1, 'spam',  2, 200),
           (1, 'offtopic', 1, 300);
  `);
  return { DB: new SqliteD1(sqlite) } as unknown as Env;
}

test("tags_returned counts distinct tags (the listing); tags_rows_returned counts applications", async () => {
  const d = (await readPost(env(), 1)) as {
    tags: Array<{ tag: string; taggers: unknown[] }>;
    tags_returned: number;
    tags_rows_returned: number;
  };
  const distinct = d.tags.length;
  const applications = d.tags.reduce((n, t) => n + t.taggers.length, 0);
  assert.equal(distinct, 2, "two distinct tags");
  assert.equal(applications, 3, "three application rows (spam seconded)");
  // The count beside the listing is over the listing's population.
  assert.equal(d.tags_returned, distinct, "tags_returned must equal the length of the tags array");
  // The ungrouped count is preserved and equals the sum of taggers.
  assert.equal(d.tags_rows_returned, applications, "tags_rows_returned is the application-row count");
  // And on a seconded tag the two genuinely differ (the defect's signature).
  assert.notEqual(d.tags_returned, d.tags_rows_returned, "the two counts differ when a tag is corroborated");
});
