// GET /api/listings always serves has_more, and next_since_id exactly when
// has_more is true (listListings over-fetches LISTING_PAGE+1). schemas/listings.json
// left has_more optional and omitted next_since_id entirely, so a clipped page
// without a cursor still validated — unlike payouts.json, which already couples
// the pair. Soft-power closes that honesty gap.
//
// Killing mutations:
//   1. Drop has_more from required — incomplete fixture starts validating.
//   2. Remove allOf coupling — has_more:true without next_since_id validates.
//   3. Drop next_since_id from properties — cursor field vanishes from contract.
//
// Soft-power / cloudymcclouder. Not a twin of listing-detail page-cap (#403),
// listings-guide (#329), or cloudy money/preimage work.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "./helpers/json-schema.ts";

const schema = JSON.parse(readFileSync(fileURLToPath(new URL("../schemas/listings.json", import.meta.url)), "utf8"));

function base(overrides: Record<string, unknown> = {}) {
  return {
    now: 1,
    now_utc: new Date(1).toISOString(),
    listings: [],
    returned: 0,
    has_more: false,
    ...overrides,
  };
}

test("listings.json requires has_more", () => {
  assert.ok(schema.required.includes("has_more"));
  assert.ok(schema.properties.next_since_id, "next_since_id must be a named property");
});

test("a final page validates without next_since_id and rejects a dangling cursor", () => {
  assert.deepEqual(validate(schema, base()), []);
  const dangling = base({ next_since_id: 1 });
  assert.ok(
    validate(schema, dangling).some((e) => /next_since_id|forbidden/.test(e)),
    validate(schema, dangling).join("; "),
  );
});

test("has_more:true without next_since_id must NOT validate", () => {
  const clipped = base({ has_more: true, returned: 50, listings: [] });
  const errors = validate(schema, clipped);
  assert.ok(errors.some((e) => /next_since_id/.test(e)), errors.join("; "));
});

test("has_more:true with next_since_id validates", () => {
  assert.deepEqual(validate(schema, base({ has_more: true, next_since_id: 42, returned: 50 })), []);
});

test("dropping has_more must NOT validate", () => {
  const incomplete = base();
  delete (incomplete as { has_more?: boolean }).has_more;
  assert.ok(validate(schema, incomplete).some((e) => /has_more/.test(e)));
});

test("description names the has_more / next_since_id coupling", () => {
  assert.match(schema.description, /has_more/);
  assert.match(schema.description, /next_since_id/);
});
