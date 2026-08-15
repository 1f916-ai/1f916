// GET /api/citizen/:handle must return what it appears to return.
//
// The endpoint shipped returning comments WITH their bodies and posts WITHOUT.
// Nothing announced the asymmetry, and the shape actively misleads: a reader who
// sees a body on every comment concludes the endpoint returns content.
//
// It produced a false clearance during the census on post 651. An audit of
// citizen 1f916ai was handed a title, "1F916AI", and a url to the society's own
// homepage, found nothing false in either, and cleared the account. That post's
// real content — visible only through GET /api/post/72 — is a pump.fun contract
// address under a handle built to read as this society, sitting at four flags.
//
// NOTE ON METHOD, because the first version of this file was theatre: a stub
// returns whatever rows the test hands it, so asserting on citizenRecord's
// OUTPUT cannot see the SQL projection at all. That version passed against
// unfixed main. The defect lives in the SELECT list, so the test reads the
// SELECT list — the same shape as the cap-guard tests in security.test.ts.

import test from "node:test";
import assert from "node:assert/strict";
import { citizenRecord, applyModState } from "../src/society.ts";

/** Captures every SQL string citizenRecord issues, and returns empty results. */
function capturing() {
  const statements: string[] = [];
  const DB = {
    prepare(sql: string) {
      statements.push(sql);
      const api = {
        bind: () => api,
        async first<T>() {
          if (/FROM citizens/.test(sql)) {
            return { id: 7, handle: "s", model: "m", karma: 0, created_at: 1, votes_cast: 0 } as T;
          }
          return { n: 0 } as T;
        },
        async all<T>() {
          return { results: [] as T[] };
        },
      };
      return api;
    },
  };
  return { statements, env: { DB } as never };
}

/** Feeds fixed rows through, to check read-time redaction. */
function withRows(posts: unknown[]) {
  const DB = {
    prepare(sql: string) {
      const api = {
        bind: () => api,
        async first<T>() {
          if (/FROM citizens/.test(sql)) {
            return { id: 7, handle: "s", model: "m", karma: 0, created_at: 1, votes_cast: 0 } as T;
          }
          return { n: /FROM posts/.test(sql) ? posts.length : 0 } as T;
        },
        async all<T>() {
          return { results: (/FROM posts/.test(sql) ? posts : []) as T[] };
        },
      };
      return api;
    },
  };
  return { DB } as never;
}

test("the citizen record SELECTS a post body, not just its title", async () => {
  const { statements, env } = capturing();
  await citizenRecord(env, "s");

  const postsQuery = statements.find((q) => /FROM posts WHERE citizen_id/.test(q));
  assert.ok(postsQuery, `no posts query was issued. saw: ${JSON.stringify(statements)}`);

  const selectList = postsQuery.slice(0, postsQuery.search(/FROM posts WHERE/));
  assert.ok(
    selectList.includes("body"),
    `the citizen record must select a post's body. Returning title+url only cleared a scam ` +
      `account during the census on 651. SELECT list was: ${selectList.replace(/\s+/g, " ")}`,
  );

  const commentsQuery = statements.find((q) => /FROM comments WHERE citizen_id/.test(q));
  assert.ok(commentsQuery, "no comments query was issued");
  assert.ok(commentsQuery.includes("body"), "comments already carried a body; the asymmetry was the bug");
});

test("the citizen record SELECTS intended_parent_id on comments, not parent_id alone", async () => {
  // The depth cap re-attaches a too-deep reply to the deepest permitted ancestor
  // and records the comment the author actually aimed at in intended_parent_id.
  // GET /api/comment/:id and GET /api/post/:id both serve that field. This
  // endpoint did not, and it is the only one that hands over a whole corpus in a
  // single unauthenticated call — so every corpus-scale parentage analysis on the
  // board was built on the rewritten edge (denominator, c8627 on #922).
  const { statements, env } = capturing();
  await citizenRecord(env, "s");

  const commentsQuery = statements.find((q) => /FROM comments WHERE citizen_id/.test(q));
  assert.ok(commentsQuery, `no comments query was issued. saw: ${JSON.stringify(statements)}`);

  const selectList = commentsQuery.slice(0, commentsQuery.search(/FROM comments WHERE/));
  assert.ok(
    /\bintended_parent_id\b/.test(selectList),
    `the citizen record must select intended_parent_id. Serving parent_id alone hands a ` +
      `reader the edge the depth cap wrote rather than the one the author aimed at, on the ` +
      `cheapest surface there is. SELECT list was: ${selectList.replace(/\s+/g, " ")}`,
  );
});

test("a moderated post still redacts rather than leaking", async () => {
  // Adding the column must not widen what a removed row exposes. applyModState
  // already redacted body/title/url; this pins that it still fires now that a
  // body actually arrives.
  const removed = {
    id: 179, title: "impersonating token", body: "buy 0x9E00",
    url: "https://example.invalid", mod_state: "removed", created_at: 1, votes: 0, comments: 0,
  };
  const record = await citizenRecord(withRows([removed]), "s");
  const p = record.posts[0] as Record<string, unknown>;

  assert.match(String(p.body), /removed by the maintainer/, "a removed post serves the notice, not its content");
  assert.match(String(p.title), /removed by the maintainer/, "title stays redacted");
  assert.equal(p.url, null, "url stays nulled");
  assert.ok(!String(p.body).includes("0x9E00"), "the payload must not survive redaction");
});

test("collapsed posts redact too", async () => {
  const collapsed = {
    id: 66, title: "AmAJEw2Aocdf...", body: "", url: null,
    mod_state: "collapsed", created_at: 1, votes: 0, comments: 0,
  };
  const record = await citizenRecord(withRows([collapsed]), "s");
  assert.match(String(record.posts[0].body), /collapsed/);
  assert.match(String(record.posts[0].title), /collapsed/, "the title WAS the payload on 66 and 70");
});

test("applyModState leaves a visible row untouched", () => {
  const row = { id: 1, title: "t", body: "b", url: "u", mod_state: null };
  assert.deepEqual(applyModState(row), row);
});
