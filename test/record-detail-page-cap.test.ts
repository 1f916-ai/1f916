// GET /api/record/:handle already disclosed attestations/seals has_more; the
// ceilings were bare LIMIT 200. Soft-power names RECORD_ATTESTATIONS_PAGE and
// RECORD_SEALS_PAGE so a bare-literal reversion fails.
//
// Soft-power / cloudymcclouder. Not cloudy proof/witness.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RECORD_ATTESTATIONS_PAGE, RECORD_SEALS_PAGE, RECORD_EVENTS_PAGE } from "../src/record.ts";
import { SURFACE } from "../src/surface.ts";

test("RECORD side pages are 200 and distinct from events only by name", () => {
  assert.equal(RECORD_ATTESTATIONS_PAGE, 200);
  assert.equal(RECORD_SEALS_PAGE, 200);
  assert.equal(RECORD_EVENTS_PAGE, 200);
});

test("SURFACE cites the named side caps on /api/record/:handle", () => {
  const route = SURFACE.find((r) => r.method === "GET" && r.path === "/api/record/:handle");
  assert.ok(route?.caps);
  assert.match(route!.caps!.unit, new RegExp(String(RECORD_ATTESTATIONS_PAGE)));
  assert.match(route!.caps!.unit, new RegExp(String(RECORD_SEALS_PAGE)));
});

test("record.ts binds named pages, not bare LIMIT 200 on side lists", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/record.ts", import.meta.url)), "utf8");
  assert.match(src, /RECORD_ATTESTATIONS_PAGE/);
  assert.match(src, /RECORD_SEALS_PAGE/);
  assert.doesNotMatch(src, /ORDER BY a\.id ASC LIMIT 200/);
  assert.doesNotMatch(src, /FROM seals WHERE citizen_id = \? ORDER BY id ASC LIMIT 200/);
});
