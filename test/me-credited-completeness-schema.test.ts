// GET /api/me always serves credited_without_notice with count / total_count /
// rows_returned / truncated (quire #5065; worker test
// credited-without-notice-total.test.ts). schemas/me.json typed the bucket as
// a bare {"type":"object"}, so a regression that dropped total_count (or set
// it equal to the page length again) still validated against the published
// contract — false green.
//
// Soft-power pins the completeness fields. Same class as post.json tags/
// has_more honesty (#462). Not a twin of cloudy ack-envelope work.
//
// Killing mutations:
//   1. Drop total_count from required — incomplete fixture starts validating.
//   2. Drop truncated from required — same.
//   3. Restore credited_without_notice to {"type":"object"} — all incompletes pass.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "./helpers/json-schema.ts";

const schema = JSON.parse(readFileSync(fileURLToPath(new URL("../schemas/me.json", import.meta.url)), "utf8"));
const credited = schema.properties.credited_without_notice;
const answered = schema.properties.answered_before_intent_routing;

function bucket(overrides: Record<string, unknown> = {}) {
  return {
    count: 3,
    total_count: 3,
    rows_returned: 3,
    truncated: false,
    items: [{ id: 1 }],
    note: "silent namings",
    ...overrides,
  };
}

test("me.json requires credited_without_notice and answered_before_intent_routing", () => {
  assert.ok(schema.required.includes("credited_without_notice"));
  assert.ok(schema.required.includes("answered_before_intent_routing"));
});

test("credited_without_notice requires count/total_count/rows_returned/truncated", () => {
  for (const key of ["count", "total_count", "rows_returned", "truncated", "items", "note"]) {
    assert.ok(credited.required.includes(key), `missing required ${key}`);
  }
});

test("a complete credited bucket validates; dropping total_count does not", () => {
  assert.deepEqual(validate(credited, bucket()), []);
  const incomplete = bucket();
  delete (incomplete as { total_count?: number }).total_count;
  const errors = validate(credited, incomplete);
  assert.ok(errors.some((e) => /total_count/.test(e)), errors.join("; "));
});

test("dropping truncated must NOT validate (clipped page looks whole)", () => {
  const incomplete = bucket();
  delete (incomplete as { truncated?: boolean }).truncated;
  const errors = validate(credited, incomplete);
  assert.ok(errors.some((e) => /truncated/.test(e)), errors.join("; "));
});

test("answered_before_intent_routing requires count/items/note", () => {
  for (const key of ["count", "items", "note"]) {
    assert.ok(answered.required.includes(key), `missing required ${key}`);
  }
  assert.deepEqual(validate(answered, { count: 0, items: [], note: "none" }), []);
  const bad = { count: 0, items: [] };
  assert.ok(validate(answered, bad).some((e) => /note/.test(e)));
});

test("description names the credited completeness contract", () => {
  assert.match(schema.description, /total_count/);
  assert.match(schema.description, /truncated/);
  assert.match(schema.description, /credited_without_notice/);
});
