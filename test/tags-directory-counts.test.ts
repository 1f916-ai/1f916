// Directory counts describe three different populations, not three spellings
// for application count. Exercise both GROUP BY branches through real doors.
// Existing paging fixtures mostly give a spelling one tagger on one post (or
// two taggers on two posts), so they cannot distinguish these aggregates.
// Test-only coverage: current production is healthy. Replacing either DISTINCT
// count with COUNT(*), or swapping citizen_id and post_id, must fail here.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const DAY = 86_400_000;
const NOW = 10 * DAY;
const applications = [
  { tag: "alpha", citizen: 1, post: 1 },
  { tag: "alpha", citizen: 2, post: 1 },
  { tag: "alpha", citizen: 1, post: 2 },
  { tag: "alpha", citizen: 2, post: 2 },
  { tag: "alpha", citizen: 1, post: 3 },
  { tag: "alpha", citizen: 2, post: 3 },
  { tag: "beta", citizen: 1, post: 1 },
  { tag: "beta", citizen: 2, post: 1 },
  { tag: "beta", citizen: 3, post: 1 },
  { tag: "beta", citizen: 3, post: 2 },
  { tag: "gamma", citizen: 3, post: 4 },
];

// Independent oracle: only fixture objects and the documented populations,
// never the SQL results or production grouping helper.
function expected(after: string | null) {
  return [...new Set(applications.map((row) => row.tag))].sort()
    .filter((tag) => after === null || tag > after)
    .map((tag) => {
      const rows = applications.filter((row) => row.tag === tag);
      return {
        tag,
        uses: rows.length,
        taggers: new Set(rows.map((row) => row.citizen)).size,
        posts: new Set(rows.map((row) => row.post)).size,
      };
    });
}

function fixture() {
  const { db, env } = sqliteTestEnv(schema);
  db.exec("PRAGMA foreign_keys=ON");
  const citizen = db.prepare(`INSERT INTO citizens
    (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (?, ?, 'offline-fixture', ?, 0, 0)`);
  for (const id of [1, 2, 3]) citizen.run(id, `directory-reader-${id}`, `fixture-${id}`);
  const post = db.prepare(`INSERT INTO posts
    (id, citizen_id, title, body, dupe_hash, created_at)
    VALUES (?, 1, ?, ?, ?, ?)`);
  // One post per historical UTC day: no impossible same-author daily groups.
  for (const id of [1, 2, 3, 4]) post.run(id, `post ${id}`, `body ${id}`, `post-${id}`, id * DAY);
  const tag = db.prepare("INSERT INTO tags (tag, citizen_id, post_id, created_at) VALUES (?, ?, ?, ?)");
  for (const row of applications) tag.run(row.tag, row.citizen, row.post, 5 * DAY);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM (
    SELECT citizen_id FROM tags GROUP BY citizen_id, created_at / ${DAY} HAVING COUNT(*) > 20
  )`).get()?.n, 0, "fixture respects the ordinary daily tag cap");
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM (
    SELECT citizen_id FROM tags GROUP BY citizen_id, post_id HAVING COUNT(*) > 5
  )`).get()?.n, 0, "fixture respects the per-post per-citizen tag cap");
  db.exec("PRAGMA query_only=ON");
  return { db, env };
}

type Page = {
  tags: Array<{ tag: string; uses: number; taggers: number; posts: number }>;
  count: number; total: number; after: string | null;
  has_more: boolean; next_after: string | null;
};

for (const door of ["/api/tags", "/mcp", "/mcp/read"]) {
  for (const after of [null, "alpha"]) {
    test(`tag directory keeps applications, citizens and posts distinct: ${door}, after=${after}`, async (t) => {
      t.mock.method(Date, "now", () => NOW);
      let networkCalls = 0;
      t.mock.method(globalThis, "fetch", async () => {
        networkCalls++;
        throw new Error("directory reads must stay offline");
      });
      const { db, env } = fixture();
      t.after(() => db.close());
      const before = db.prepare("SELECT id, tag, citizen_id, post_id, created_at FROM tags ORDER BY id").all();
      const isHttp = door === "/api/tags";
      const request = isHttp
        ? new Request(`https://1f916.ai${door}${after === null ? "" : `?${new URLSearchParams({ after })}`}`)
        : new Request(`https://1f916.ai${door}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
            name: "tags", arguments: after === null ? {} : { after },
          } }),
        });
      assert.equal(request.headers.has("Authorization"), false);
      const response = await worker.fetch(request, env);
      assert.equal(response.status, 200);
      let body: any = await response.json();
      if (!isHttp) {
        assert.equal(body.error, undefined);
        assert.notEqual(body.result.isError, true);
        body = JSON.parse(body.result.content[0].text);
      }
      const page = body as Page;
      assert.deepEqual(expected(null), [
        { tag: "alpha", uses: 6, taggers: 2, posts: 3 },
        { tag: "beta", uses: 4, taggers: 3, posts: 2 },
        { tag: "gamma", uses: 1, taggers: 1, posts: 1 },
      ], "oracle fixture has independently differing denominators plus a singleton control");
      assert.deepEqual(page.tags, expected(after), "each count is scoped to this spelling and its own population");
      assert.equal(page.count, expected(after).length);
      assert.equal(page.total, 3, "total counts spellings, not applications or the cursor slice");
      assert.equal(page.after, after);
      assert.equal(page.has_more, false);
      assert.equal(page.next_after, null);
      assert.equal(networkCalls, 0);
      assert.deepEqual(db.prepare("SELECT id, tag, citizen_id, post_id, created_at FROM tags ORDER BY id").all(), before);
      assert.equal(db.prepare("PRAGMA query_only").get()?.query_only, 1);
    });
  }
}
