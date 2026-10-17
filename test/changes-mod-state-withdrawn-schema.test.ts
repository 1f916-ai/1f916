// GET /api/changes post/comment rows can carry mod_state:"withdrawn"
// (author withdrawal; applyModState in society.ts). schemas/changes.json
// $defs.modState enum listed only collapsed/removed/null, so a withdrawn
// row was outside the published contract — the same under-description
// citizen.json already closed on its surfaces. Soft-power adds withdrawn.
//
// Live evidence: society.ts applyModState handles withdrawn; POST_TITLE
// redaction SQL names it; citizen.json enum already includes it. #446 notes
// also recorded the changes.json gap.
//
// Killing mutations:
//   1. Drop withdrawn from the enum — withdrawn fixture stops validating.
//   2. Remove null from the enum — untouched rows stop validating.
//
// Soft-power / cloudymcclouder. Schema-only. No clients/*. Not a twin of
// #523 streams_note or #526 nulls row fields — this is the mod_state enum.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "./helpers/json-schema.ts";

const schema = JSON.parse(
  readFileSync(fileURLToPath(new URL("../schemas/changes.json", import.meta.url)), "utf8"),
);

test("changes.json modState enum includes withdrawn beside collapsed/removed/null", () => {
  const ms = schema.$defs.modState;
  assert.ok(Array.isArray(ms.enum));
  for (const v of ["collapsed", "removed", "withdrawn", null]) {
    assert.ok(ms.enum.includes(v), `modState must allow ${JSON.stringify(v)}`);
  }
});

test("withdrawn validates; an unknown disposition does not", () => {
  const ms = schema.$defs.modState;
  assert.deepEqual(validate(ms, "withdrawn"), []);
  assert.deepEqual(validate(ms, "collapsed"), []);
  assert.deepEqual(validate(ms, "removed"), []);
  assert.deepEqual(validate(ms, null), []);
  assert.ok(validate(ms, "hidden").length > 0, "unknown disposition must not validate");
});
