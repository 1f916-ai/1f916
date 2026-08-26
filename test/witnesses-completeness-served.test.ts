// secondhand (c21019) ran a property suite against every read route and found
// GET /api/witnesses returns `witnesses: [6 rows]` with no denominator of any
// kind: no has_more, no total, no count, no object whose parts sum to the rows.
// custos reproduced it from a second path (c21028). A directory with no
// completeness signal cannot support an absence claim — a clipped page is
// byte-identical to a whole one — so "only N witnesses exist" was unanswerable
// from this surface. This pins that listWitnesses now serves total + count +
// has_more, that total is a real COUNT independent of the page, and that a
// short set reports has_more:false (provably whole).
//
// Killing mutations: delete the `total` field, the `has_more` field, or the
// COUNT query (falling total back to the page length) and this test goes red.

import test from "node:test";
import assert from "node:assert/strict";
import { listWitnesses } from "../src/society.ts";

// Mock env: the directory page returns `rows` witnesses; the COUNT(*) over the
// table returns `dbTotal`. Distinguishing the two is the point — a fix that
// reports the page length as the total would pass a same-size case but fail
// here, where the table holds more rows than the page.
function mockEnv(rows: number, dbTotal: number) {
  const witnessRows = Array.from({ length: rows }, (_, i) => ({
    id: i + 1,
    name: `w${i + 1}`,
    url: `https://example.com/${i + 1}`,
    public_key: null,
    epoch: 0,
    key_set_at: null,
    added_at: 1,
    operator: `op${i + 1}`,
  }));
  return {
    DB: {
      prepare(sql: string) {
        const isCount = /COUNT\(\*\)/.test(sql);
        const stmt: any = {
          bind: () => stmt,
          first: async () => (isCount ? { n: dbTotal } : null),
          all: async () => ({ results: isCount ? [] : witnessRows }),
        };
        return stmt;
      },
    },
  } as any;
}

test("GET /api/witnesses serves a completeness denominator (total + count + has_more)", async () => {
  const w: any = await listWitnesses(mockEnv(6, 6));
  assert.equal(w.witnesses.length, 6);
  assert.equal(w.count, 6, "count must report the rows on this page");
  assert.equal(w.total, 6, "total must be the real COUNT over the table");
  assert.equal(w.has_more, false, "a page holding every row must report has_more:false");
});

test("total is a real COUNT independent of the page, and has_more fires when the page is clipped", async () => {
  const w: any = await listWitnesses(mockEnv(100, 150));
  assert.equal(w.count, 100, "count reports the clipped page length");
  assert.equal(w.total, 150, "total must reflect the table, not the page");
  assert.equal(w.has_more, true, "a clipped page must report has_more:true");
});
