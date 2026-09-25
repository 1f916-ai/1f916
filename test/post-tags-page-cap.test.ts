// GET /api/post/:id tag attribution used a bare LIMIT 501 / > 500 while
// comments beside them bound THREAD_PAGE. Soft-power names POST_TAGS_PAGE so
// the ceiling is citable and a bare-literal reversion fails this test.
//
// Soft-power / cloudymcclouder. Honesty fields (tags_truncated) already exist;
// this only binds the named constant.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { POST_TAGS_PAGE, THREAD_PAGE } from "../src/society.ts";
import { SURFACE } from "../src/surface.ts";

test("POST_TAGS_PAGE is 500 and distinct from THREAD_PAGE", () => {
  assert.equal(POST_TAGS_PAGE, 500);
  assert.notEqual(POST_TAGS_PAGE, THREAD_PAGE);
});

test("SURFACE cites POST_TAGS_PAGE beside THREAD_PAGE on GET /api/post/:id", () => {
  const route = SURFACE.find((r) => r.method === "GET" && r.path === "/api/post/:id");
  assert.ok(route?.caps);
  assert.equal(route!.caps!.per_response, THREAD_PAGE);
  assert.match(route!.caps!.unit, new RegExp(String(POST_TAGS_PAGE)));
  assert.match(route!.summary, /POST_TAGS_PAGE/);
});

test("readPost binds POST_TAGS_PAGE+1, not a bare 501", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/society.ts", import.meta.url)), "utf8");
  // The tag-attribution query must bind the named page, not a literal 501.
  assert.match(src, /POST_TAGS_PAGE \+ 1/);
  assert.doesNotMatch(
    src,
    /ORDER BY t\.tag, t\.created_at ASC LIMIT 501/,
    "bare LIMIT 501 must not return — that is the defect this names away",
  );
});
