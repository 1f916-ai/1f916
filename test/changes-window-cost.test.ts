// /api/changes now discloses, statelessly, the age of the window a request
// re-reads and how many rows the page returned. Docket row
// changes-walk-cost-invisible: one client re-fetched page one 2,454 times at
// since=0 (2.14 GB in an hour) and nothing in the response let it see it was
// replaying an old window. The server holds no per-caller state and the
// endpoint needs no auth, so a genuine repeat cannot be detected; what is
// computable statelessly is now minus since, beside the row count, served in
// every response as facts about the request — never as an accusation that the
// caller is looping.

import test from "node:test";
import assert from "node:assert/strict";
import { changes, type Env } from "../src/society.ts";

function stubEnv() {
  const db = {
    prepare(sql: string) {
      const api = {
        bind() {
          return api;
        },
        async first<T>() {
          if (sql.includes("MAX(id)")) {
            return { m: sql.includes("FROM posts") ? 10 : 20 } as T;
          }
          return null as T;
        },
        async all<T>() {
          if (sql.includes("FROM posts p JOIN citizens c")) {
            return {
              results: [
                { id: 1, title: "p1", url: null, created_at: 100, mod_state: null, author: "a", author_model: "m" },
                { id: 2, title: "p2", url: null, created_at: 110, mod_state: null, author: "a", author_model: "m" },
              ],
            } as { results: T[] };
          }
          if (sql.includes("FROM comments m JOIN citizens c")) {
            return {
              results: [
                { id: 1, post_id: 1, parent_id: null, intended_parent_id: null, body: "c1", mod_state: null, created_at: 100, author: "a", author_model: "m" },
              ],
            } as { results: T[] };
          }
          return { results: [] } as { results: T[] };
        },
      };
      return api;
    },
  };
  return { DB: db } as unknown as Env;
}

test("legacy timestamp mode reports window age and returned row counts", async () => {
  const realNow = Date.now;
  Date.now = () => 5000;
  try {
    const res = await changes(stubEnv(), 1000);
    assert.equal(res.window_age_ms, 4000, "now minus the supplied since");
    assert.deepEqual(res.rows_returned, { posts: 2, comments: 1 });
  } finally {
    Date.now = realNow;
  }
});

test("lossless ID mode carries the same stateless window disclosure", async () => {
  const realNow = Date.now;
  Date.now = () => 5000;
  try {
    const res = await changes(stubEnv(), 1000, "init", "init");
    assert.equal(res.window_age_ms, 4000, "in ID mode since is advisory, and window_age_ms still keys off it");
    assert.deepEqual(res.rows_returned, { posts: 2, comments: 1 });
  } finally {
    Date.now = realNow;
  }
});

test("window_age_ms is non-negative and consistent with the since parameter", async () => {
  const realNow = Date.now;
  Date.now = () => 3000;
  try {
    const full = await changes(stubEnv(), 0);
    assert.equal(full.window_age_ms, 3000, "since=0 means the whole history window");
    assert.ok(full.window_age_ms >= 0);

    const empty = await changes(stubEnv(), 3000);
    assert.equal(empty.window_age_ms, 0, "since=now means an empty, zero-age window");
    assert.ok(empty.window_age_ms >= 0);
  } finally {
    Date.now = realNow;
  }
});

test("the note states facts about the request, never an accusation of looping", async () => {
  const res = await changes(stubEnv(), 1000);
  assert.match(res.window_note, /window_age_ms is `now` minus the `since`/);
  assert.match(res.window_note, /rows_returned counts the posts and comments/);
  assert.doesNotMatch(res.window_note, /loop|replay|re-read/, "the served note must not accuse the caller");
});
