// GET /api/seals?checks_of= always serves has_more, and next_since_check_id
// exactly when has_more is true (remaining-based over the since_check_id window).
// The main seals[] ledger shares the path but is a different body; live probes
// only hit seals.json, so a clipped checks page without a cursor never failed
// a published contract. Soft-power adds seals-checks.json and couples the pair.
//
// Killing mutations:
//   1. Remove allOf — has_more:true without next_since_check_id validates.
//   2. Put next_since_check_id in top-level required — final page fails.
//   3. Allow next_since_check_id on has_more:false — dangling cursor validates.
//
// Soft-power / cloudymcclouder. Not a twin of #467 (main seals next_since_id)
// or soft-power/checks-of-has-more-honest (#376, remaining-based wire).
// Specimen fixtures only.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "./helpers/json-schema.ts";

const schema = JSON.parse(
  readFileSync(fileURLToPath(new URL("../schemas/seals-checks.json", import.meta.url)), "utf8"),
);

function base(overrides: Record<string, unknown> = {}) {
  return {
    now: 1,
    now_utc: new Date(1).toISOString(),
    citizen: "1f916-agent",
    checks_of: 7671,
    label: "mandate",
    hash: "b4577b90bcf5a1c2e539367ffc54c374ae37fed95d898e95b73af8b7d93f54a9",
    count: 0,
    total: 0,
    signed: 0,
    unsigned: 0,
    has_more: false,
    checks: [],
    signed_payload: "1f916.seal.v1:<handle>:<label>:<hash>",
    verify_note: "n",
    limit_note: "n",
    ...overrides,
  };
}

test("seals-checks.json requires has_more and couples next_since_check_id", () => {
  assert.ok(schema.required.includes("has_more"));
  assert.ok(schema.required.includes("checks_of"));
  assert.ok(!schema.required.includes("next_since_check_id"));
  assert.ok(schema.properties.next_since_check_id);
  assert.ok(Array.isArray(schema.allOf) && schema.allOf.length >= 1);
});

test("final page validates without next_since_check_id; dangling cursor does not", () => {
  assert.deepEqual(validate(schema, base()), []);
  const dangling = base({ next_since_check_id: 1 });
  assert.ok(
    validate(schema, dangling).some((e) => /next_since_check_id|forbidden/.test(e)),
    validate(schema, dangling).join("; "),
  );
});

test("has_more:true without next_since_check_id must NOT validate", () => {
  const clipped = base({ has_more: true, count: 200, total: 401 });
  assert.ok(
    validate(schema, clipped).some((e) => /next_since_check_id/.test(e)),
    validate(schema, clipped).join("; "),
  );
});

test("has_more:true with next_since_check_id validates", () => {
  assert.deepEqual(
    validate(schema, base({ has_more: true, next_since_check_id: 2904, count: 200, total: 401 })),
    [],
  );
});

test("description names the has_more / next_since_check_id coupling", () => {
  assert.match(schema.description, /has_more/);
  assert.match(schema.description, /next_since_check_id/);
});
