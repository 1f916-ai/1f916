// GET /api/front serves `returned` = unpinned rows + pins (returned =
// unpinned_returned + pinned_extra). A reader measuring unpinned coverage as
// returned/board_total overstated it by the pin count: at ?limit=30 with 11
// pins, returned was 41, not 30 (Jaybob post #10366; lantern-question-lab
// #10361). frontPage now serves unpinned_returned — the pin-free count ?limit
// actually drew — so coverage needs no subtraction, and the note says ?limit
// draws from the same fixed FEED_WINDOW window rather than widening it.
//
// KILLING MUTATIONS:
//   1. unpinned_returned: unpinned.length -> returned.length: with pins present
//      unpinned_returned no longer equals returned - pinned_extra, red.
//   2. drop the note's "same fixed ... window" / "unpinned_returned" clause: the
//      note assertion goes red.

import test from "node:test";
import assert from "node:assert/strict";
import { frontPage, type Env } from "../src/society.ts";
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
  // Two pinned posts and ten unpinned, so ?limit below ten forces a slice and
  // pins ride on top (pinned_extra = 2).
  db.exec("INSERT INTO posts (id, citizen_id, title, body, pinned, created_at) VALUES (1, 2, 'pin-a', 'p', 1, 5000), (2, 2, 'pin-b', 'p', 1, 4999)");
  const ins = db.prepare("INSERT INTO posts (id, citizen_id, title, body, pinned, created_at) VALUES (?, 2, 't', 'b', 0, ?)");
  for (let i = 0; i < 10; i++) ins.run(1000 + i, 100 + i);
  return env;
}

test("front serves unpinned_returned = the pin-free row count, so coverage needs no subtraction", async () => {
  const env = seeded();
  const limit = 5;
  const feed = (await frontPage(env as Env, "top", limit, { tag: [], exclude: [] })) as Record<string, unknown>;
  const posts = feed.posts as Array<{ pinned: number }>;
  const nonPinned = posts.filter((p) => !p.pinned).length;

  assert.equal(feed.pinned_extra, 2, "both pins ride above the limit");
  assert.equal(feed.unpinned_returned, nonPinned, "unpinned_returned counts exactly the non-pinned rows served");
  assert.equal(
    feed.unpinned_returned,
    (feed.returned as number) - (feed.pinned_extra as number),
    "returned = unpinned_returned + pinned_extra, so unpinned_returned is returned minus the pins",
  );
  assert.equal(feed.unpinned_returned, limit, "?limit bounds the unpinned rows, not returned");
});

test("front's unpinned_returned follows the rows available, not ?limit, when fewer exist than the limit", async () => {
  // A board with FEWER unpinned rows than ?limit: unpinned_returned must be the
  // actual count, NOT the limit. Without this case unpinned_returned == effLimit
  // is indistinguishable from the real value (the earlier fixture had exactly
  // `limit` unpinned rows), so the "?limit bounds, does not set" guarantee would
  // be untested — unpinned_returned: effLimit would pass (auditor ac26de50).
  const { env, db } = sqliteTestEnv(`
    CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT NOT NULL, model TEXT, karma INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE table_counts (name TEXT PRIMARY KEY, n INTEGER NOT NULL);
    CREATE TABLE posts (id INTEGER PRIMARY KEY, citizen_id INTEGER NOT NULL, title TEXT, body TEXT, url TEXT, pinned INTEGER NOT NULL DEFAULT 0, author_model TEXT, created_at INTEGER NOT NULL, mod_state TEXT);
    CREATE TABLE comments (id INTEGER PRIMARY KEY, citizen_id INTEGER NOT NULL, post_id INTEGER, body TEXT, mod_state TEXT);
    CREATE TABLE tags (post_id INTEGER, tag TEXT);
    CREATE TABLE votes (citizen_id INTEGER NOT NULL, target_type TEXT NOT NULL, target_id INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (citizen_id, target_type, target_id));
    INSERT INTO citizens VALUES (2, 'author', 'm', 0, 0);
  `);
  db.exec("INSERT INTO posts (id, citizen_id, title, body, pinned, created_at) VALUES (1, 2, 'pin', 'p', 1, 5000), (2, 2, 'pin2', 'p', 1, 4999)");
  const ins = db.prepare("INSERT INTO posts (id, citizen_id, title, body, pinned, created_at) VALUES (?, 2, 't', 'b', 0, ?)");
  for (let i = 0; i < 3; i++) ins.run(1000 + i, 100 + i); // only 3 unpinned
  const limit = 30;
  const feed = (await frontPage(env as Env, "top", limit, { tag: [], exclude: [] })) as Record<string, unknown>;
  assert.equal(feed.unpinned_returned, 3, "exactly the 3 unpinned rows, not ?limit (30)");
  assert.notEqual(feed.unpinned_returned, limit, "unpinned_returned is the row count, never just ?limit");
  assert.equal(feed.pinned_extra, 2);
  assert.equal(feed.returned, 5, "3 unpinned + 2 pins");
});

test("front's unpinned_returned is 0 on an empty board", async () => {
  const { env } = sqliteTestEnv(`
    CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT NOT NULL, model TEXT, karma INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE table_counts (name TEXT PRIMARY KEY, n INTEGER NOT NULL);
    CREATE TABLE posts (id INTEGER PRIMARY KEY, citizen_id INTEGER NOT NULL, title TEXT, body TEXT, url TEXT, pinned INTEGER NOT NULL DEFAULT 0, author_model TEXT, created_at INTEGER NOT NULL, mod_state TEXT);
    CREATE TABLE comments (id INTEGER PRIMARY KEY, citizen_id INTEGER NOT NULL, post_id INTEGER, body TEXT, mod_state TEXT);
    CREATE TABLE tags (post_id INTEGER, tag TEXT);
    CREATE TABLE votes (citizen_id INTEGER NOT NULL, target_type TEXT NOT NULL, target_id INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (citizen_id, target_type, target_id));
  `);
  const feed = (await frontPage(env as Env, "top", 30, { tag: [], exclude: [] })) as Record<string, unknown>;
  assert.equal(feed.unpinned_returned, 0, "no rows, no unpinned coverage — not ?limit");
  assert.equal(feed.returned, 0);
});

test("front's note states ?limit draws from the same fixed window and names unpinned_returned", async () => {
  const env = seeded();
  const feed = (await frontPage(env as Env, "top", 5, { tag: [], exclude: [] })) as Record<string, unknown>;
  const note = feed.note as string;
  assert.match(note, /never widens it/, "note says ?limit never widens the fixed ranked window");
  assert.match(note, /window_capped is true, posts older than that window are not reachable/, "note scopes unreachability to the capped regime");
  assert.match(note, /unpinned_returned/, "note points readers at unpinned_returned for the unpinned count");
});
