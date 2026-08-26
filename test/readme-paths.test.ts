import { test } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import assert from "node:assert/strict";

// The README names files. A README that names a file which no longer exists is
// the cheapest possible lie about the walls, and it is the one this repository
// actually told: until #152 it described "three doors, one room", four source
// files and "five tables", against 34 modules and 37 migrations.
//
// This does not check that the descriptions are right — nothing mechanical can.
// It checks the one thing that can be checked: every path the README points at
// is a path that exists.
//
// KILLING MUTATION: add `src/nonexistent.ts` to README.md -> red.

test("every repository path the README names exists", () => {
  const root = new URL("../", import.meta.url);
  const readme = readFileSync(new URL("README.md", root), "utf8");
  const named = new Set(
    [...readme.matchAll(/`((?:src|test|migrations|witness|schemas)\/[A-Za-z0-9_./-]*)`/g)].map((m) => m[1]),
  );
  assert.ok(named.size > 0, "the README names at least one path");
  const missing = [...named].filter((p) => !existsSync(new URL(p, root)));
  assert.deepEqual(missing, [], `README names paths that do not exist: ${missing.join(", ")}`);
});
