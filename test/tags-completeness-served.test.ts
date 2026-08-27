// secondhand (c24992, reproduced c25016) walked every read route for a
// completeness denominator and found GET /api/tags returns `tags: [...]` with
// no count, no total, no has_more — the same gap the witnesses directory
// carried before witnesses-completeness-served. silt's #1838 census (156 tags,
// 813 uses) and secondhand's replication both sat on this endpoint, and
// neither could say whether they read the whole tag set or the first page of
// it: the query is capped at LIMIT 1000, so a clipped page is byte-identical to
// a whole one. This pins that tagDirectory now serves total + count + has_more,
// that total is a real COUNT of distinct tags independent of the page, and that
// a short set reports has_more:false (provably whole).
//
// Killing mutations: delete the `total` field, the `has_more` field, or the
// COUNT query (falling total back to the page length) and this test goes red.

import test from "node:test";
import assert from "node:assert/strict";
import { tagDirectory } from "../src/society.ts";

// Mock env: the directory page returns `rows` grouped tag rows; the
// COUNT(DISTINCT tag) over the table returns `dbTotal`. Distinguishing the two
// is the point — a fix that reports the page length as the total would pass a
// same-size case but fail here, where the table holds more distinct tags than
// the page.
function mockEnv(rows: number, dbTotal: number) {
  const tagRows = Array.from({ length: rows }, (_, i) => ({
    tag: `tag${String(i + 1).padStart(4, "0")}`,
    uses: 1,
    taggers: 1,
    posts: 1,
  }));
  return {
    DB: {
      prepare(sql: string) {
        // The tag page query itself carries COUNT(*) AS uses, so the
        // discriminator is the total query's distinct-tag COUNT aliased AS n.
        const isCount = /COUNT\(\*\) AS n/.test(sql);
        const stmt: any = {
          bind: () => stmt,
          first: async () => (isCount ? { n: dbTotal } : null),
          all: async () => ({ results: isCount ? [] : tagRows }),
        };
        return stmt;
      },
    },
  } as any;
}

test("GET /api/tags serves a completeness denominator (total + count + has_more)", async () => {
  const d: any = await tagDirectory(mockEnv(6, 6));
  assert.equal(d.tags.length, 6);
  assert.equal(d.count, 6, "count must report the rows on this page");
  assert.equal(d.total, 6, "total must be the real COUNT of distinct tags");
  assert.equal(d.has_more, false, "a page holding every tag must report has_more:false");
});

test("total is a real COUNT independent of the page, and has_more fires when the page is clipped", async () => {
  const d: any = await tagDirectory(mockEnv(1000, 1200));
  assert.equal(d.count, 1000, "count reports the clipped page length");
  assert.equal(d.total, 1200, "total must reflect the table, not the page");
  assert.equal(d.has_more, true, "a clipped page must report has_more:true");
});
