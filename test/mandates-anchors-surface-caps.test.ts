// GET /api/mandates pages at MANDATE_PAGE (100) and GET /api/anchors at
// ANCHOR_PAGE (200). Both constants already drove the wire LIMIT and the
// response `caps.per_response`, but src/surface.ts published bare literals
// 100 and 200 — so a future change to either constant would leave
// GET /api/surface citing a stale ceiling (the exact drift surface.ts exists
// to prevent). Soft-power binds SURFACE to the named exports.
//
// Killing mutations:
//   1. Restore per_response: 100 on /api/mandates — SURFACE no longer equals
//      MANDATE_PAGE.
//   2. Restore per_response: 200 on /api/anchors — SURFACE no longer equals
//      ANCHOR_PAGE.
//   3. Un-export ANCHOR_PAGE — import from surface fails.
//
// Soft-power / cloudymcclouder. Not a twin of thin citation-only page-cap
// ships that invent a name; these names already existed beside the wire.
// Not cloudy/* money/preimage; not gooseberry/clients.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SURFACE } from "../src/surface.ts";
import { MANDATE_PAGE } from "../src/mandates.ts";
import { ANCHOR_PAGE } from "../src/anchors.ts";

test("MANDATE_PAGE is 100 and ANCHOR_PAGE is 200", () => {
  assert.equal(MANDATE_PAGE, 100);
  assert.equal(ANCHOR_PAGE, 200);
});

test("SURFACE cites MANDATE_PAGE on GET /api/mandates", () => {
  const route = SURFACE.find((r) => r.method === "GET" && r.path === "/api/mandates");
  assert.ok(route?.caps, "mandates route must declare caps");
  assert.equal(route!.caps!.per_response, MANDATE_PAGE);
  assert.match(route!.caps!.more, /next_since_id/);
  assert.match(route!.caps!.more, /has_more/);
});

test("SURFACE cites ANCHOR_PAGE on GET /api/anchors", () => {
  const route = SURFACE.find((r) => r.method === "GET" && r.path === "/api/anchors");
  assert.ok(route?.caps, "anchors route must declare caps");
  assert.equal(route!.caps!.per_response, ANCHOR_PAGE);
  assert.match(route!.caps!.more, /next_since_id/);
  assert.match(route!.caps!.more, /has_more/);
});

test("surface.ts imports the named caps rather than bare 100/200 on those doors", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/surface.ts", import.meta.url)), "utf8");
  assert.match(src, /import \{ MANDATE_PAGE \} from "\.\/mandates\.ts"/);
  assert.match(src, /import \{ ANCHOR_PAGE \} from "\.\/anchors\.ts"/);
  assert.match(src, /per_response: MANDATE_PAGE/);
  assert.match(src, /per_response: ANCHOR_PAGE/);
  // The mandates/anchors GET caps lines must not fall back to bare literals.
  assert.doesNotMatch(src, /path: "\/api\/mandates"[\s\S]{0,400}?per_response: 100/);
  assert.doesNotMatch(src, /path: "\/api\/anchors"[\s\S]{0,800}?per_response: 200/);
});

test("anchors.ts exports ANCHOR_PAGE for surface and callers to cite", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/anchors.ts", import.meta.url)), "utf8");
  assert.match(src, /export const ANCHOR_PAGE = 200/);
});
