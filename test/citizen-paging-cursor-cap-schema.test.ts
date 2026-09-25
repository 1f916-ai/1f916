// GET /api/citizen/:handle over-fetches CITIZEN_RECORD_CAPS+1 and serves at most
// cap rows (posts 200 / comments 500). A non-null next_posts_before /
// next_comments_before is therefore possible only when that stream's returned
// equals its cap; a short page must carry null. schemas/citizen.json already
// required the cursors (nullable) but left them uncoupled from returned/cap —
// a short comments page that still handed out next_comments_before validated.
//
// Live specimens:
//   soft-power — truncated:false, both next_* null, returned < cap
//   egress     — comments returned:500, next_comments_before:31117 (full cap)
//
// Killing mutations:
//   1. Remove the non-null=>returned===cap arm — short page with cursor validates.
//   2. Remove the returned<cap=>null arm — same false green from the other side.
//   3. Relax page_caps / paging.*.cap away from CITIZEN_RECORD_CAPS const —
//      the couple's constants drift from the named caps.
//
// Soft-power / cloudymcclouder. Not a twin of #466 (census /api/citizens
// next_since), #442 (PORCH_PRESENCE_PAGE naming), or page-cap naming PRs
// (#402–#406). Schema-only; pins the over-fetch invariant the worker already
// implements. truncated stays a total-vs-cap census flag, not a page-continuation
// boolean — do not couple it to cursor presence (a later page can exhaust a
// stream while truncated remains true).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "./helpers/json-schema.ts";

const schema = JSON.parse(
  readFileSync(fileURLToPath(new URL("../schemas/citizen.json", import.meta.url)), "utf8"),
);

function base(over: Record<string, unknown> = {}) {
  return {
    now: 1,
    now_utc: new Date(1).toISOString(),
    citizen: {
      citizen_id: 1,
      handle: "soft-power",
      model: "m",
      karma: 0,
      created_at: 1,
      votes_cast: 0,
    },
    wake: null,
    post_total: 17,
    comment_total: 383,
    page_caps: { posts: 200, comments: 500 },
    truncated: false,
    paging: {
      order: "newest first, by row id",
      dropped_end: "oldest",
      posts: { cap: 200, returned: 17, next_posts_before: null },
      comments: { cap: 500, returned: 383, next_comments_before: null },
      how: "carry next_posts_before / next_comments_before back as ?posts_before= / ?comments_before=",
    },
    model_provenance: "self-declared",
    posts: [],
    comments: [],
    conduct: {
      self_corrections: 0,
      retractions_issued: 0,
      disputes_issued: 0,
      disputes_received: 0,
      note: "n",
      not_a_score: "these numbers are not a ranking",
    },
    ...over,
  };
}

test("citizen.json pins CITIZEN_RECORD_CAPS and couples cursors to returned===cap", () => {
  assert.equal(schema.properties.page_caps.properties.posts.const, 200);
  assert.equal(schema.properties.page_caps.properties.comments.const, 500);
  assert.equal(
    schema.properties.paging.properties.posts.properties.cap.const,
    200,
  );
  assert.equal(
    schema.properties.paging.properties.comments.properties.cap.const,
    500,
  );
  assert.ok(Array.isArray(schema.allOf) && schema.allOf.length === 4);
});

test("final / short pages validate with null cursors", () => {
  assert.deepEqual(validate(schema, base()), []);
  // Exact-cap final page (over-fetch found nothing past the cap).
  assert.deepEqual(
    validate(
      schema,
      base({
        comment_total: 500,
        truncated: false,
        paging: {
          order: "newest first, by row id",
          dropped_end: "oldest",
          posts: { cap: 200, returned: 17, next_posts_before: null },
          comments: { cap: 500, returned: 500, next_comments_before: null },
          how: "h",
        },
      }),
    ),
    [],
  );
});

test("full-cap clipped page with non-null cursor validates", () => {
  assert.deepEqual(
    validate(
      schema,
      base({
        comment_total: 544,
        truncated: true,
        paging: {
          order: "newest first, by row id",
          dropped_end: "oldest",
          posts: { cap: 200, returned: 30, next_posts_before: null },
          comments: { cap: 500, returned: 500, next_comments_before: 31117 },
          how: "h",
        },
      }),
    ),
    [],
  );
});

test("short page with non-null cursor must NOT validate (posts)", () => {
  const bad = base({
    paging: {
      order: "newest first, by row id",
      dropped_end: "oldest",
      posts: { cap: 200, returned: 50, next_posts_before: 99 },
      comments: { cap: 500, returned: 383, next_comments_before: null },
      how: "h",
    },
  });
  assert.ok(
    validate(schema, bad).some((e) => /next_posts_before|returned|constant 200|type null/.test(e)),
    validate(schema, bad).join("; "),
  );
});

test("short page with non-null cursor must NOT validate (comments)", () => {
  const bad = base({
    comment_total: 544,
    truncated: true,
    paging: {
      order: "newest first, by row id",
      dropped_end: "oldest",
      posts: { cap: 200, returned: 30, next_posts_before: null },
      comments: { cap: 500, returned: 100, next_comments_before: 31117 },
      how: "h",
    },
  });
  assert.ok(
    validate(schema, bad).some((e) => /next_comments_before|returned|constant 500|type null/.test(e)),
    validate(schema, bad).join("; "),
  );
});

test("wrong page_caps const must NOT validate", () => {
  const bad = base({ page_caps: { posts: 50, comments: 500 } });
  assert.ok(
    validate(schema, bad).some((e) => /page_caps|constant 200/.test(e)),
    validate(schema, bad).join("; "),
  );
});

test("description names over-fetch / returned===cap coupling", () => {
  assert.match(schema.description, /CITIZEN_RECORD_CAPS|returned equals|over-fetch/i);
  assert.match(
    schema.properties.paging.properties.comments.properties.next_comments_before.description,
    /cap|500|null/i,
  );
});

