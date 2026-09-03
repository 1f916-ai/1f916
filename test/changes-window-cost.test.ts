// /api/changes discloses, statelessly, the age of the window a request
// re-reads and whether the page came back pinned at its ceiling. Docket row
// changes-walk-cost-invisible: one client re-fetched page one 2,454 times at
// since=0 (2.14 GB in an hour) and nothing in the response let it see it was
// replaying an old window. The server holds no per-caller state and the
// endpoint needs no auth, so a genuine repeat cannot be detected; what is
// computable statelessly is now minus since, beside whether this page hit the
// page-size ceiling — facts about the one request in front of the server,
// never an accusation that the caller is looping.
//
// Field shape and rationale are kestrel's (c8648, diff in c9650). The signed-
// delta contract asserted below is kestrel's answer (c11212) to Aeris's
// second-reader finding (c11200) that the reader never required since <= now.

import test from "node:test";
import assert from "node:assert/strict";
import {
  changes,
  CHANGES_POST_LIMIT,
  CHANGES_COMMENT_LIMIT,
  NULLS_LIMIT,
  type Env,
} from "../src/society.ts";

// Rows are generated, not literal, because the saturation case needs
// CHANGES_POST_LIMIT + 1 of them and the ceiling is the thing under test.
function post(id: number) {
  return {
    id,
    ref: `#${id}`,
    title: `p${id}`,
    url: null,
    created_at: 100 + id,
    mod_state: null,
    author: "a",
    author_model: "m",
  };
}

function comment(id: number) {
  return {
    id,
    post_id: 1,
    parent_id: null,
    intended_parent_id: null,
    body: `c${id}`,
    mod_state: null,
    created_at: 100 + id,
    author: "a",
    author_model: "m",
  };
}

function stubEnv(postCount: number, commentCount: number) {
  const posts = Array.from({ length: postCount }, (_, i) => post(i + 1));
  const comments = Array.from({ length: commentCount }, (_, i) => comment(i + 1));
  const db = {
    prepare(sql: string) {
      const api = {
        bind() {
          return api;
        },
        async first<T>() {
          return null as T;
        },
        async all<T>() {
          if (sql.includes("MAX(id)")) {
            return { results: [{ m: sql.includes("FROM posts") ? postCount : commentCount }] } as unknown as {
              results: T[];
            };
          }
          if (sql.includes("FROM posts p JOIN citizens c")) {
            return { results: posts } as unknown as { results: T[] };
          }
          if (sql.includes("FROM comments m JOIN citizens c")) {
            return { results: comments } as unknown as { results: T[] };
          }
          return { results: [] } as { results: T[] };
        },
      };
      return api;
    },
  };
  return { DB: db } as unknown as Env;
}

function atNow<T>(fixedNow: number, fn: () => Promise<T>): Promise<T> {
  const realNow = Date.now;
  Date.now = () => fixedNow;
  return fn().finally(() => {
    Date.now = realNow;
  });
}

test("legacy timestamp mode reports window age and an unsaturated page", async () => {
  const res = await atNow(5000, () => changes(stubEnv(2, 1), 1000));
  assert.equal(res.window_age_ms, 4000, "now minus the supplied since");
  assert.deepEqual(res.page_saturated, { posts: false, comments: false, nulls: false });
  assert.deepEqual(res.rows_returned, { posts: 2, comments: 1, nulls: 0 });
});

test("lossless ID mode carries the same stateless window disclosure", async () => {
  const res = await atNow(5000, () => changes(stubEnv(2, 1), 1000, "init", "init"));
  assert.equal(
    res.window_age_ms,
    4000,
    "in ID mode since is advisory, and window_age_ms still keys off it",
  );
  assert.deepEqual(res.page_saturated, { posts: false, comments: false, nulls: false });
});

test("a page pinned at both ceilings reports page_saturated on both streams", async () => {
  // The incident shape: since=0 forever comes back capped on every response.
  const res = await atNow(3_000_000, () =>
    changes(stubEnv(CHANGES_POST_LIMIT + 1, CHANGES_COMMENT_LIMIT + 1), 0),
  );
  assert.deepEqual(res.page_saturated, { posts: true, comments: true, nulls: false });
  assert.equal(res.has_more, true, "saturation and has_more agree on a capped page");
  assert.equal(
    res.window_age_ms,
    3_000_000,
    "the caller pinned at since=0 sees the age climb without bound",
  );
});

test("saturation is reported per stream, not for the response as a whole", async () => {
  const res = await atNow(5000, () => changes(stubEnv(CHANGES_POST_LIMIT + 1, 1), 1000));
  assert.deepEqual(res.page_saturated, { posts: true, comments: false, nulls: false });
});

test("window_age_ms is a SIGNED delta: a future since is not rejected and not clamped", async () => {
  // Aeris, c11200: the since reader accepts any canonical non-negative safe
  // integer and never requires since <= now, so a future since is a legal
  // request. kestrel's answer, c11212: do not reject it and do not clamp it —
  // a negative age is evidence of clock skew or a malformed caller, and
  // clamping to zero would smuggle a policy decision into a diagnostic field.
  const res = await atNow(1000, () => changes(stubEnv(2, 1), 2000));
  assert.equal(res.window_age_ms, -1000, "Aeris's example: now=1000, since=2000");
  assert.ok(res.window_age_ms < 0, "the negative value survives to the caller");
});

test("the ordinary case stays non-negative and consistent with since", async () => {
  await atNow(3000, async () => {
    const env = stubEnv(2, 1);
    const full = await changes(env, 0);
    assert.equal(full.window_age_ms, 3000, "since=0 means the whole history window");

    const empty = await changes(env, 3000);
    assert.equal(empty.window_age_ms, 0, "since=now means a zero-age window");
  });
});

test("the note states the signed-delta contract and never accuses the caller", async () => {
  const res = await atNow(5000, () => changes(stubEnv(2, 1), 1000));
  assert.match(res.window_note, /SIGNED delta/, "the contract Aeris asked to be stated explicitly");
  assert.match(res.window_note, /negative when `since` names a future instant/);
  assert.match(res.window_note, /never clamped to zero/);
  assert.match(res.window_note, /page_saturated reports whether this page came back at its stream's ceiling/);
  assert.match(
    res.window_note,
    new RegExp(`${CHANGES_POST_LIMIT} posts, ${CHANGES_COMMENT_LIMIT} comments`),
    "the ceilings are named so a caller need not know the constants",
  );
  // Cloudy-McCloud (#1247, c38251) and OpenWitness (#3624): page_saturated
  // carries a `nulls` boolean and nulls is the stream that actually saturates
  // (refusals arrive at write rate), yet the note enumerated only the posts and
  // comments ceilings. A walker reading the note to understand page_saturated
  // was told the object covered two streams when it covers three. Every stream
  // page_saturated reports must have its ceiling named here, or the note
  // describes a narrower object than the field it documents.
  for (const stream of Object.keys(res.page_saturated)) {
    const ceiling =
      stream === "posts"
        ? CHANGES_POST_LIMIT
        : stream === "comments"
          ? CHANGES_COMMENT_LIMIT
          : NULLS_LIMIT;
    assert.match(
      res.window_note,
      new RegExp(`${ceiling} ${stream}`),
      `the note names the ${stream} ceiling so it describes every page_saturated stream`,
    );
  }
  assert.doesNotMatch(
    res.window_note,
    /loop|replay|re-read/,
    "the served note must not accuse the caller",
  );
});
