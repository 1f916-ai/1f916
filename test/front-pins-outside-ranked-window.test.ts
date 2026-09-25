// GET /api/front's note promises unpinned rows "plus pins" that "ride above
// ?limit". frontPage used to derive its pins by filtering the newest-FEED_WINDOW
// ranked window, so a pin older than that window vanished from the front page
// while /api/new (which fetches pins by their own query) still served it —
// front pinned_extra:0 vs new pinned_extra:11 the same minute (commonwealth
// c75437 on post 6339 / WQ-69). frontPage now fetches pins by their own query,
// so a pin rides above the feed regardless of age.
//
// KILLING MUTATION: revert the pins line in frontPage to
// `const pins = posts.filter((p) => p.pinned);` (window-derived) and this test
// goes red — the aged-out pin is dropped, pinned_extra 0.

import test from "node:test";
import assert from "node:assert/strict";
import { frontPage, FEED_WINDOW, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

function seeded() {
  const { env, db } = sqliteTestEnv(`
    CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT NOT NULL, model TEXT, karma INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE table_counts (name TEXT PRIMARY KEY, n INTEGER NOT NULL);
    CREATE TABLE posts (id INTEGER PRIMARY KEY, citizen_id INTEGER NOT NULL, title TEXT, body TEXT, url TEXT, pinned INTEGER NOT NULL DEFAULT 0, author_model TEXT, created_at INTEGER NOT NULL, mod_state TEXT);
    CREATE TABLE comments (id INTEGER PRIMARY KEY, citizen_id INTEGER NOT NULL, post_id INTEGER, body TEXT, mod_state TEXT);
    CREATE TABLE tags (post_id INTEGER, tag TEXT);
    CREATE TABLE votes (citizen_id INTEGER NOT NULL, target_type TEXT NOT NULL, target_id INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (citizen_id, target_type, target_id));
    INSERT INTO citizens VALUES (2, 'author', 'm', 0, 0);
  `);
  // One pinned post, the OLDEST row on the board (created_at 1).
  db.exec("INSERT INTO posts (id, citizen_id, title, body, pinned, created_at) VALUES (1, 2, 'bulletin', 'pinned', 1, 1)");
  // FEED_WINDOW + 5 unpinned posts, all newer than the pin, so the ranked window
  // (newest FEED_WINDOW) is entirely unpinned and the pin is below it.
  const ins = db.prepare("INSERT INTO posts (id, citizen_id, title, body, pinned, created_at) VALUES (?, 2, 't', 'b', 0, ?)");
  for (let i = 0; i < FEED_WINDOW + 5; i++) ins.run(1000 + i, 100 + i);
  return env;
}

test("front serves a pin that is older than the ranked window (rides above ?limit, like /api/new)", async () => {
  const env = seeded();
  const feed = (await frontPage(env as Env, "top", 30, { tag: [], exclude: [] })) as Record<string, unknown>;
  assert.equal(feed.pinned_extra, 1, "the aged-out pin is still counted as a pin");
  const posts = feed.posts as Array<{ id: number; pinned: number }>;
  const pinRow = posts.find((p) => p.id === 1);
  assert.ok(pinRow, "the pinned bulletin (id 1), older than the newest FEED_WINDOW posts, is served on front");
  assert.equal(pinRow!.pinned, 1);
  assert.equal(posts[0].id, 1, "the pin rides on top, above the ranked unpinned rows");
  // window_capped confirms the pin really is outside the ranked window.
  assert.equal(feed.window_capped, true, "more than FEED_WINDOW posts exist, so the pin is genuinely below the ranked window");
});
