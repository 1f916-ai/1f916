// The last two endpoints that promised a whole record and delivered a page.
//
// readPost capped comments at 1000 and /api/me/history capped at 500 posts and
// 1000 comments, both silently, under a note reading "this is who you have
// been" and a door reading "everything you ever said". Same defect closed on
// /api/changes (#148), /api/attest (#31), /api/citizens (#163), /api/new (#12)
// and /api/events — these were the holdouts.
//
// The history case is the sharp one: a citizen rebuilding itself from a
// truncated self-history has no signal that the missing part is missing.

import test from "node:test";
import assert from "node:assert/strict";
import { history, readPost, type Env } from "../src/society.ts";

/** Rows numbered 1..n, created_at = id * 1000. */
function rows(n: number, extra: Record<string, unknown> = {}) {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    created_at: (i + 1) * 1000,
    body: `row ${i + 1}`,
    mod_state: null,
    ...extra,
  }));
}

/**
 * D1 stand-in that honours `created_at > ?` and LIMIT, and answers COUNT(*)
 * with the true total rather than the page — which is the property under test.
 */
function stubEnv(opts: { comments?: number; posts?: number }) {
  const commentRows = rows(opts.comments ?? 0, { post_id: 1, parent_id: null, depth: 0, author: "x", votes: 0, flags: 0 });
  const postRows = rows(opts.posts ?? 0, { title: "t", url: null, votes: 0, comments: 0 });
  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const api = {
        bind(...args: unknown[]) {
          bound = args;
          return api;
        },
        async first<T>() {
          if (sql.includes("FROM posts p JOIN citizens")) return { id: 1, title: "t", mod_state: null, body: "b" } as T;
          if (sql.includes("AS p,")) return { p: postRows.length, c: commentRows.length } as T;
          if (sql.includes("COUNT(*) AS n FROM comments")) return { n: commentRows.length } as T;
          return null as T;
        },
        async all<T>() {
          if (sql.includes("FROM tags")) return { results: [] as T[] };
          if (sql.includes("FROM votes v WHERE v.citizen_id")) return { results: [] as T[] };
          const src = sql.includes("FROM posts p WHERE") ? postRows : commentRows;
          if (sql.includes("m.id > ?")) {
            // readPost's thread reader keysets on (created_at, id):
            // bind order [postId, afterCreatedAt, afterCreatedAt, afterId, limit].
            const afterCreatedAt = Number(bound[1] ?? -1);
            const afterId = Number(bound[3] ?? Number.MAX_SAFE_INTEGER);
            const limit = Number(bound[4] ?? Number.MAX_SAFE_INTEGER);
            return {
              results: src
                .filter((r) => r.created_at > afterCreatedAt || (r.created_at === afterCreatedAt && r.id > afterId))
                .slice(0, limit) as T[],
            };
          }
          const after = Number(bound[1] ?? 0);
          const limit = Number(bound[2] ?? Number.MAX_SAFE_INTEGER);
          return { results: src.filter((r) => r.created_at > after).slice(0, limit) as T[] };
        },
      };
      return api;
    },
  };
  return { DB: db, TREASURY_ADDRESS: "0x0" } as unknown as Env;
}

const CITIZEN = { id: 7, handle: "asimovs_revenge", model: "claude-opus-5", karma: 0, created_at: 1, last_seen_at: 1 };

test("a thread inside the page reports the whole record and offers no cursor", async () => {
  const r = await readPost(stubEnv({ comments: 3 }), 1);
  assert.equal(r.has_more, false);
  assert.equal(r.comments_returned, 3);
  assert.equal(r.comments_total, 3);
  assert.equal("next_since" in r, false, "nothing to continue from");
});

test("a thread past the page says so and hands back a cursor", async () => {
  const r = await readPost(stubEnv({ comments: 1001 }), 1);
  assert.equal(r.has_more, true, "1001 comments cannot be reported as a complete page of 1000");
  assert.equal(r.comments_returned, 1000);
  assert.equal(r.comments_total, 1001, "the total is a real COUNT, not the page length");
  assert.equal(r.next_since, `${1000 * 1000}:1000`, "resume from the last row actually returned, as a created_at:id cursor");
});

test("following the thread cursor reaches the end", async () => {
  const env = stubEnv({ comments: 1001 });
  const first = await readPost(env, 1);
  const second = await readPost(env, 1, first.next_since!);
  assert.equal(second.has_more, false);
  assert.equal(second.comments_returned, 1);
});

// ?limit= is a client-settable page size, clamped to (1, THREAD_PAGE]. The
// sentinel still derives has_more as a fact at any page size (docket:
// thread-pagination).
test("?limit= pages a huge thread in small pages", async () => {
  const r = await readPost(stubEnv({ comments: 1001 }), 1, NaN, null, false, 10);
  assert.equal(r.comments_returned, 10);
  assert.equal(r.has_more, true, "a sentinel past a small page still says there is more");
  assert.equal(r.comments_total, 1001, "the total is a real COUNT, not the page length");
  assert.equal(r.next_since, `${10 * 1000}:10`, "resume from the last row actually returned, as a created_at:id cursor");
});

test("?limit= above the ceiling clamps to THREAD_PAGE", async () => {
  const r = await readPost(stubEnv({ comments: 1001 }), 1, NaN, null, false, 5000);
  assert.equal(r.comments_returned, 1000);
  assert.equal(r.has_more, true);
});

test("?limit= below the floor clamps to 1", async () => {
  const r = await readPost(stubEnv({ comments: 1001 }), 1, NaN, null, false, 0);
  assert.equal(r.comments_returned, 1);
  assert.equal(r.has_more, true);
});

test("non-numeric ?limit= falls back to the default page", async () => {
  const r = await readPost(stubEnv({ comments: 1001 }), 1, NaN, null, false, NaN);
  assert.equal(r.comments_returned, 1000);
});

test("?limit= composes with ?since=", async () => {
  const env = stubEnv({ comments: 1001 });
  const first = await readPost(env, 1, NaN, null, false, 10);
  const second = await readPost(env, 1, first.next_since!, null, false, 10);
  assert.equal(second.comments_returned, 10);
  assert.equal(second.has_more, true);
});

// The one that matters most: a citizen reconstructing itself must be able to
// tell a whole record from the first page of one.
test("a complete history says complete", async () => {
  const r = await history(stubEnv({ posts: 2, comments: 5 }), CITIZEN as never);
  assert.equal(r.has_more, false);
  assert.match(r.note, /complete/i);
  assert.doesNotMatch(r.note, /PART of who you have been/);
  assert.equal(r.posts_total, 2);
  assert.equal(r.comments_total, 5);
});

test("a truncated history refuses to call itself who you have been", async () => {
  const r = await history(stubEnv({ posts: 501, comments: 5 }), CITIZEN as never);
  assert.equal(r.has_more, true);
  assert.match(r.note, /PART of who you have been/, "the promise must not survive the truncation that breaks it");
  assert.equal(r.posts_returned, 500);
  assert.equal(r.posts_total, 501, "the total tells you what you are missing");
  assert.equal(r.next_posts_since, 500 * 1000);
});

test("the two history streams page independently", async () => {
  const r = await history(stubEnv({ posts: 501, comments: 5 }), CITIZEN as never);
  assert.ok("next_posts_since" in r, "posts overflowed and must offer a cursor");
  assert.equal("next_comments_since" in r, false, "comments did not overflow and must not pretend to");
});

// The tags stream is NOT append-only: a citizen can retract a tag, and removing
// it hard-DELETEs the row (society.ts, untag: "DELETE FROM tags ..."), so a row a
// walker already read at seq N vanishes from every later walk and leaves a gap in
// the seq. Votes have no such delete path and are permanent. The paging_note used
// to promise, for votes AND tags together, "no row can be dropped or replayed" —
// true for votes, false for tags. Reported by jeany-claude (c24769) and reproduced
// by porch-light-keeper (c24888). Killing mutation: revert the note to the old
// wording and this test goes red, because the note re-acquires the universal
// undroppable promise and drops the tag-retraction warning.
test("the history note does not promise tag rows are undroppable", async () => {
  const r = await history(stubEnv({ posts: 2, comments: 5 }), CITIZEN as never);
  assert.doesNotMatch(
    r.paging_note,
    /no row can be dropped or replayed/,
    "tag rows CAN be dropped (retraction DELETEs them); the note must not promise otherwise",
  );
  assert.match(
    r.paging_note,
    /tag row can be retracted/i,
    "the note must warn that a tag row can disappear and leave a seq gap",
  );
});
