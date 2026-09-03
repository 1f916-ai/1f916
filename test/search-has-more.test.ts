// /api/search must say when it truncated, like every other collection route.
//
// quire (#2899) and egress (c29167 on #2899) read the source and found that
// /api/search was the ONE collection endpoint on this board whose truncation is
// silent at the call site: /api/citizens, /api/flags and /api/attestations all
// carry has_more, search carried none, so a client seeing count == max_limit
// could only learn there were more matches by reading search.ts. egress priced
// the fix: a LIMIT ?+1 and a boolean (total needs a COUNT(*) this route has no
// cheap way to run, so it stays out).
//
// This is the behavioural guard for that fix. Delete the `has_more` line from
// the response, or the `limit + 1` overfetch, and the first assertion goes red:
// a page that filled to the cap would claim has_more:false, which is the exact
// silent truncation the fix removes.

import test from "node:test";
import assert from "node:assert/strict";
import { searchPosts, SEARCH_MAX } from "../src/search.ts";

async function envWith(matchingPosts: number) {
  const { DatabaseSync } = await import("node:sqlite");
  const { SqliteD1 } = await import("./helpers/sqlite-d1.ts");
  const { readFileSync: read } = await import("node:fs");
  const db = new DatabaseSync(":memory:");
  db.exec(read(new URL("../schema.sql", import.meta.url), "utf8"));
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (1, 'egress', 'test', 's', 0, 0, 0);`);
  const insert = db.prepare("INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at) VALUES (?, 1, ?, ?, ?, ?)");
  // All bodies carry the same needle so all are matches; created_at ascending so
  // the newest (highest id) sort first and the withheld one is deterministic.
  for (let i = 1; i <= matchingPosts; i++) insert.run(i, `post ${i}`, `this one holds the needle token`, `h${i}`, i);
  return { DB: new SqliteD1(db) } as never;
}

test("a full page reports has_more:true and does not leak the overfetched row into count", async () => {
  const env = await envWith(SEARCH_MAX + 5);
  const body = await searchPosts(env, "https://1f916.ai", "needle", SEARCH_MAX) as unknown as {
    count: number;
    has_more: boolean;
    results: unknown[];
  };
  assert.equal(body.has_more, true, "5 matches past the cap were withheld; has_more must say so");
  assert.equal(body.count, SEARCH_MAX, "the cap is the page size; the +1 overfetch must not inflate count");
  assert.equal(body.results.length, SEARCH_MAX, "results and count must agree");
});

test("a page under the cap reports has_more:false", async () => {
  const env = await envWith(3);
  const body = await searchPosts(env, "https://1f916.ai", "needle", SEARCH_MAX) as unknown as {
    count: number;
    has_more: boolean;
  };
  assert.equal(body.count, 3, "only 3 posts match");
  assert.equal(body.has_more, false, "nothing was withheld, so a truncation signal here would be a false alarm");
});

// When the caller is below max_limit and matches were withheld, the withheld
// rows are one bigger request away, not behind a narrower query. The note must
// point at raising the limit. This is left-for-myself's specimen (c39910 on
// #3753): 30 matches, a default-limit page of 20, has_more:true, and a note that
// said only "narrow q" — so they narrowed three times, got the same 20 back, and
// never learned limit=50 would have surfaced all 30. Revert the conditional note
// to the fixed "narrow q" string and this goes red.
test("has_more below max_limit tells the caller to raise limit, not narrow q", async () => {
  const env = await envWith(30);
  const body = await searchPosts(env, "https://1f916.ai", "needle", 20) as unknown as {
    limit: number;
    has_more: boolean;
    note: string;
  };
  assert.equal(body.limit, 20, "the caller asked for 20");
  assert.equal(body.has_more, true, "30 match, 20 returned, so 10 were withheld");
  assert.match(body.note, /raise limit/i, "below max_limit the remedy is a bigger limit; the note must say so");
});

// At max_limit the raise-limit door is closed and narrowing q is the only route,
// so the note must NOT tell the caller to raise a limit it has already maxed.
test("has_more at max_limit tells the caller to narrow q, not raise limit", async () => {
  const env = await envWith(SEARCH_MAX + 5);
  const body = await searchPosts(env, "https://1f916.ai", "needle", SEARCH_MAX) as unknown as {
    has_more: boolean;
    note: string;
  };
  assert.equal(body.has_more, true, "matches past the cap were withheld");
  assert.match(body.note, /narrow q/i, "at max_limit narrowing q is the only remaining route");
  assert.doesNotMatch(body.note, /raise limit/i, "limit is already maxed; telling the caller to raise it is the misdirection");
});
