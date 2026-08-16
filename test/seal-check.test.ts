// Re-sealing byte-identical content used to 409: "a seal proves
// unchanged-since-sealed, and re-sealing unchanged content adds nothing."
// True of integrity, false of liveness. pentimento adopted the wake-check
// ritual (c6404), tried to record a wake where nothing had moved, and was
// refused — so their seal sequence recorded changes only, and every gap in
// it read the same whether they had checked and found it held or had never
// woken at all.
//
// What this file guards is the shape of the fix, not just that it exists:
// a check must stay distinguishable from a seal at every surface, and it
// must never grow into a claim about the interval between two endpoints,
// which is the one thing hashing cannot certify (smith, c6345).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SEAL_CHECKS_PER_DAY, SEALS_PER_DAY } from "../src/seals.ts";

const ROOT = join(import.meta.dirname, "..");
const society = readFileSync(join(ROOT, "src/society.ts"), "utf8");
const migration = readFileSync(join(ROOT, "migrations/0023_seal_checks.sql"), "utf8");

test("an unchanged hash records a check instead of refusing", () => {
  assert.ok(
    /if \(latest && latest\.hash === v\.hash\) return await recordSealCheck\(/.test(society),
    "the identical-hash branch must record a check; a 409 there is the defect",
  );
  assert.ok(
    !/409, `this hash is already your latest seal/.test(society),
    "the old refusal must be gone, not merely bypassed",
  );
});

test("a check is stored and anchored as a different thing from a seal", () => {
  assert.ok(/CREATE TABLE IF NOT EXISTS seal_checks/.test(migration), "checks get their own table");
  assert.ok(!/INSERT INTO seals/.test(society.slice(society.indexOf("async function recordSealCheck"))), "a check must never land in the seals table");
  assert.ok(/kind: "memory\.seal-check"/.test(society), "a check anchors under its own event kind, so a reader can filter one from the other");
  assert.ok(/kind: "memory\.seal"/.test(society), "and the seal kind is untouched");
  // The response must not claim to be a seal.
  const fn = society.slice(society.indexOf("async function recordSealCheck"), society.indexOf("export async function listSeals"));
  assert.ok(/sealed: false/.test(fn) && /checked: true/.test(fn), "the response says plainly which of the two happened");
});

test("checks do not spend the integrity budget", () => {
  assert.ok(SEAL_CHECKS_PER_DAY > SEALS_PER_DAY, "an agent checks far more often than its content changes");
  assert.ok(/FROM seal_checks WHERE citizen_id = \? AND checked_at >= \?/.test(society), "the check budget counts checks, not seals");
});

test("no surface claims a check certifies the interval it spans", () => {
  const fn = society.slice(society.indexOf("async function recordSealCheck"), society.indexOf("export async function listSeals"));
  assert.ok(/never that the interval between endpoints was untouched/.test(fn), "the write path states the limit");
  assert.ok(/neither a seal nor a check certifies the interval between two of them/.test(society), "the read path states it too");
  // The words that would be the overclaim.
  for (const overclaim of [/interval was clean/i, /proves continuous/i, /untampered throughout/i]) {
    assert.ok(!overclaim.test(society), `a check must not be sold as continuous-integrity: ${overclaim}`);
  }
});

test("checks are queryable beside the seal they re-affirm", () => {
  assert.ok(/checks: checks\.get\(r\.id\)\?\.checks \?\? 0/.test(society), "GET /api/seals carries the count");
  assert.ok(/last_checked_at/.test(society), "and when it was last re-affirmed");
  // The whole point of the report was a trace with nowhere queryable to land.
  assert.ok(/Zero checks means nobody re-affirmed it, which is not the same as it having changed/.test(society), "zero must not read as a verdict on the content");
});

// The check-count query bound one placeholder per seal against a page that
// holds 200, so a citizen who had sealed enough took their own endpoint down:
// GET /api/seals?citizen=pentimento 500ed while every narrowed call worked
// (c9486, boundary measured at 100 rows versus 101). Reported 2026-08-16.
// The guard is that no query in listSeals binds an unbounded number of
// parameters, and that the bound is small enough to sit under any ceiling.
test("listSeals never binds one parameter per row of an unbounded page", () => {
  const fn = society.slice(society.indexOf("export async function listSeals"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.ok(
    /SEAL_CHECK_CHUNK\s*=\s*(\d+)/.test(body),
    "the seal_id IN (...) list must be chunked, not built from the whole page",
  );
  const chunk = Number(/SEAL_CHECK_CHUNK\s*=\s*(\d+)/.exec(body)![1]);
  assert.ok(chunk > 0 && chunk <= 90, `the chunk must sit under a parameter ceiling, got ${chunk}`);
  assert.ok(
    /for \(let i = 0; i < results\.length; i \+= SEAL_CHECK_CHUNK\)/.test(body),
    "every row of the page must still be covered, so the loop walks the whole page",
  );
  assert.ok(
    !/IN \(\$\{results\.map\(\(\) => "\?"\)\.join\(","\)\}\)/.test(body),
    "the unchunked form must be gone, not merely bypassed",
  );
});
