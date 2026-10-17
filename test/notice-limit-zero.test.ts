// An explicit ?limit= of 0 (or a JSON-RPC limit: 0 through the MCP tool) was
// silently overridden to the default page: `Number(limit) || 50` treats 0 as
// falsy, so payloadNotices and screenNotices served 50 rows and echoed
// "limit": 50 in the reply, hiding the override from the client. The routes
// refuse an unreadable limit rather than ignoring it, and the record pages
// clamp below-floor values to 1 (record-caps), so a readable 0 belongs to the
// clamp, never the default.
import test from "node:test";
import assert from "node:assert/strict";
import { payloadNotices, screenNotices, type Env } from "../src/society.ts";

const N = 12;
const noticeRows = Array.from({ length: N }, (_, i) => ({
  id: i + 1,
  target_type: "comment",
  target_id: i + 1,
  payload: "0x00",
  created_at: (i + 1) * 1000,
  author: "x",
}));

/** D1 stand-in that honours the LIMIT bind (the last bound value). */
function stubEnv(): Env {
  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const api = {
        bind(...args: unknown[]) {
          bound = args;
          return api;
        },
        async first<T>() {
          if (sql.includes("COUNT(*)")) return { c: N, n: N } as T;
          return null as T;
        },
        async all<T>() {
          if (sql.includes("GROUP BY")) return { results: [] as T[] };
          const limit = Number(bound[bound.length - 1] ?? Number.MAX_SAFE_INTEGER);
          return { results: noticeRows.slice(0, Math.min(limit, N)) as T[] };
        },
      };
      return api;
    },
  };
  return { DB: db } as unknown as Env;
}

test("payloadNotices: an explicit limit of 0 clamps to 1, not the default 50", async () => {
  const r = await payloadNotices(stubEnv(), 0);
  assert.equal(r.limit, 1);
  assert.equal(r.returned, 1);
});

test("payloadNotices: omitted limit still serves the default 50", async () => {
  const r = await payloadNotices(stubEnv());
  assert.equal(r.limit, 50);
  assert.equal(r.returned, N);
});

test("payloadNotices: above the ceiling clamps to the page cap", async () => {
  const r = await payloadNotices(stubEnv(), 5000);
  assert.equal(r.limit, 200);
});

test("screenNotices: an explicit limit of 0 clamps to 1, not the default 50", async () => {
  const r = await screenNotices(stubEnv(), 0);
  assert.equal(r.limit, 1);
});
