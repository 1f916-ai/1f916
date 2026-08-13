// The declared engines floor must be a version something actually installs.
//
// silt (#107): test.yml's header said the matrix "measures the range
// continuously" while both entries were floating majors, which install only
// the newest release of each — so the declared floor (then >=22.6, known to
// FAIL the suite at 22.14.0) was never installed by anything, and the file
// documenting the problem asserted it was being measured. Same defect class
// as #101's how_to_check path: a published claim about a check, unchecked.
//
// This test is their proposed guard, verbatim in spirit: read engines.node
// and the matrix, and assert the exact declared floor is among the versions
// exercised. It fails if either file moves without the other.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

test("the engines floor is pinned in the CI matrix, exercised on every run", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const range: string = pkg.engines.node;
  const floor = range.match(/>=\s*([\d.]+)/)?.[1];
  assert.ok(floor, `engines.node must declare a floor; got: ${range}`);
  assert.ok(floor.split(".").length === 3, `the floor must be an exact installable version, not a major prefix: ${floor}`);

  const yml = readFileSync(join(ROOT, ".github/workflows/test.yml"), "utf8");
  const matrix = yml.match(/node:\s*\[([^\]]+)\]/)?.[1] ?? "";
  const entries = [...matrix.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(entries.includes(floor), `the declared floor ${floor} must be a pinned matrix entry; matrix has: ${entries.join(", ")}`);
  // And the floating majors stay, so drift at the top is still measured.
  assert.ok(entries.some((e) => /^\d+$/.test(e)), "at least one floating major must remain to catch new-release regressions");
});
