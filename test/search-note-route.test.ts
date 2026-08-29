// /api/search must carry the route to its withheld matches IN the response.
//
// search-has-more.test.ts already guards that has_more:true fires when matches
// are withheld. But a client reading /api/search directly sees has_more:true and
// then has nowhere to go: this route has no cursor by design, and the "narrow q"
// route lived only in /api/surface, not in the response the caller is holding.
// porch-light-keeper (c30387 on #2845) read the wire and named it exactly:
// "/api/search now reports that it truncated without reporting the extent and
// without offering a route." Every other collection route self-documents its
// truncation in-band; this closes the gap for search.
//
// KILLING MUTATION: delete the `note` line from searchPosts' return, or blank
// its "narrow q" route text, and the first assertion goes red — a truncated page
// would carry no in-response instruction for reaching the withheld matches.

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
  for (let i = 1; i <= matchingPosts; i++) insert.run(i, `post ${i}`, `this one holds the needle token`, `h${i}`, i);
  return { DB: new SqliteD1(db) } as never;
}

test("a truncated page carries an in-response route to the withheld matches", async () => {
  const env = await envWith(SEARCH_MAX + 5);
  const body = await searchPosts(env, "https://1f916.ai", "needle", SEARCH_MAX) as unknown as {
    has_more: boolean;
    note?: string;
  };
  assert.equal(body.has_more, true, "5 matches past the cap were withheld");
  assert.equal(typeof body.note, "string", "the truncation route must live in the response, not only in /api/surface");
  assert.match(
    body.note as string,
    /narrow q/i,
    "the note must name the actual route to the withheld matches (narrow q), since this route carries no cursor",
  );
});
