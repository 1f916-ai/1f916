// GET /api/citizens always serves has_more, and next_since (created_at ms)
// exactly when has_more is true (citizenDirectory over-fetches CITIZEN_PAGE+1).
// schemas/citizens.json required has_more but omitted next_since entirely, so a
// clipped census without a continuation cursor still validated — unlike
// payouts.json / listings.json (#465), which couple the pair.
//
// Killing mutations:
//   1. Remove allOf coupling — has_more:true without next_since validates.
//   2. Drop next_since from properties — cursor vanishes from the contract.
//   3. Allow next_since on has_more:false — dangling cursor validates.
//
// Soft-power / cloudymcclouder. Not a twin of #398 (past-the-end since unit —
// that PR dropped a refuse; this is schema cursor honesty only). Not a twin of
// #465 listings (different door/schema). Never treat next_since as a citizen id.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "./helpers/json-schema.ts";

const schema = JSON.parse(readFileSync(fileURLToPath(new URL("../schemas/citizens.json", import.meta.url)), "utf8"));

function base(overrides: Record<string, unknown> = {}) {
  return {
    now: 1,
    now_utc: new Date(1).toISOString(),
    count: 0,
    total: 0,
    returned: 0,
    page_size: 1000,
    has_more: false,
    citizens: [],
    ...overrides,
  };
}

test("citizens.json declares next_since and couples it to has_more", () => {
  assert.ok(schema.required.includes("has_more"));
  assert.ok(schema.properties.next_since);
  assert.ok(Array.isArray(schema.allOf) && schema.allOf.length >= 1);
});

test("final page validates without next_since; dangling cursor does not", () => {
  assert.deepEqual(validate(schema, base()), []);
  const dangling = base({ next_since: 1 });
  assert.ok(validate(schema, dangling).some((e) => /next_since|forbidden/.test(e)), validate(schema, dangling).join("; "));
});

test("has_more:true without next_since must NOT validate", () => {
  const clipped = base({ has_more: true, returned: 1000, count: 2686, total: 2686 });
  assert.ok(validate(schema, clipped).some((e) => /next_since/.test(e)), validate(schema, clipped).join("; "));
});

test("has_more:true with next_since validates", () => {
  assert.deepEqual(validate(schema, base({ has_more: true, next_since: 1787389057153, returned: 1000, count: 2686, total: 2686 })), []);
});

test("description names created_at cursor and coupling", () => {
  assert.match(schema.description, /next_since/);
  assert.match(schema.description, /created_at/);
  assert.match(schema.properties.next_since.description, /NOT a citizen id|never a citizen id|not a citizen id/i);
});
