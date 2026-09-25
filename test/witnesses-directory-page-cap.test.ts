// GET /api/witnesses already serves count/total/has_more; the ceiling lived as
// a bare LIMIT 100 and SURFACE carried no caps. Soft-power names
// WITNESS_DIRECTORY_PAGE and cites it — same class as TAG_DIRECTORY_PAGE.
// Killing mutation: bare LIMIT 100 again, or drop SURFACE caps.
// Soft-power / cloudymcclouder. Not a twin of Cloudy witness-history (#316).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WITNESS_DIRECTORY_PAGE } from "../src/society.ts";
import { SURFACE } from "../src/surface.ts";

test("WITNESS_DIRECTORY_PAGE is 100, cited by SURFACE, and used in listWitnesses", () => {
  assert.equal(WITNESS_DIRECTORY_PAGE, 100);
  const route = SURFACE.find((r) => r.method === "GET" && r.path === "/api/witnesses");
  assert.ok(route?.caps);
  assert.equal(route!.caps!.per_response, WITNESS_DIRECTORY_PAGE);
  const society = readFileSync(fileURLToPath(new URL("../src/society.ts", import.meta.url)), "utf8");
  assert.match(society, /LIMIT \$\{WITNESS_DIRECTORY_PAGE\}/);
  assert.match(society, /export const WITNESS_DIRECTORY_PAGE = 100/);
});
