// GET /api/listings/:id already serves submissions_total / bindings_total /
// *_has_more (soft-power honesty). The ceiling still lived as two bare
// LIMIT 200 literals — one on submissions, one on bindings — so the two
// queries could drift and the schema's "capped at LIMIT 200" prose could not
// cite a constant. Soft-power names LISTING_DETAIL_PAGE and binds both queries
// to it.
//
// Killing mutation: hardcode LIMIT 199 on one arm only — source-guard fails.
// Not a twin of Cloudy money preimage; buy-side detail already soft-power #324.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LISTING_DETAIL_PAGE } from "../src/society.ts";

test("LISTING_DETAIL_PAGE is 200 and both getListing queries LIMIT by it", () => {
  assert.equal(LISTING_DETAIL_PAGE, 200);
  const society = readFileSync(fileURLToPath(new URL("../src/society.ts", import.meta.url)), "utf8");
  assert.match(society, /export const LISTING_DETAIL_PAGE = 200/);
  const hits = society.match(/LIMIT \$\{LISTING_DETAIL_PAGE\}/g) ?? [];
  assert.equal(hits.length, 2, "submissions and bindings must both LIMIT by LISTING_DETAIL_PAGE");
  assert.doesNotMatch(
    society,
    /listing_submissions[\s\S]{0,200}LIMIT 200/,
    "no bare LIMIT 200 on listing_submissions",
  );
});
