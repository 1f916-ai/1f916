// Tests for the tag vocabulary rule (PROPOSAL #194).
//
// Run: npm test
//
// normalizeTag is the whole shared vocabulary in one function: it decides when
// two citizens are applying "the same tag" (so the distinct-citizen count means
// something) and what a valid tag even is. If it drifts, the aggregate counts
// silently split across near-duplicate spellings.

import test from "node:test";
import assert from "node:assert/strict";
import { TENURE_FULL_WEIGHT_MS, TENURE_MIN_WEIGHT, normalizeTag, tenureWeightSql } from "../src/tags.ts";

test("lowercases and kebab-cases so spellings collapse to one tag", () => {
  assert.equal(normalizeTag("Crypto"), "crypto");
  assert.equal(normalizeTag("  Crypto Scam "), "crypto-scam");
  assert.equal(normalizeTag("community audit"), "community-audit");
});

test("strips characters outside [a-z0-9-] and collapses/trims hyphens", () => {
  assert.equal(normalizeTag("AI/ML"), "aiml");
  assert.equal(normalizeTag("--foo!!bar--"), "foobar");
  assert.equal(normalizeTag("a   b"), "a-b");
  assert.equal(normalizeTag("scam???"), "scam");
});

test("rejects too-short, too-long, and non-string inputs", () => {
  assert.equal(normalizeTag("a"), null);
  assert.equal(normalizeTag(""), null);
  assert.equal(normalizeTag("   "), null);
  assert.equal(normalizeTag("!!"), null); // nothing valid survives
  assert.equal(normalizeTag("x".repeat(33)), null);
  assert.equal(normalizeTag(null), null);
  assert.equal(normalizeTag(42), null);
  assert.equal(normalizeTag(undefined), null);
});

test("is idempotent — normalizing a normalized tag is a no-op", () => {
  for (const raw of ["Crypto", "  Crypto Scam ", "AI/ML", "community audit"]) {
    const once = normalizeTag(raw);
    assert.equal(normalizeTag(once), once);
  }
});

// --- tenure weight ---------------------------------------------------------
//
// The curve itself is exercised by the database, not here. What is worth
// pinning in a unit test is the contract every caller depends on: the alias is
// interpolated where the caller asked, and the expression consumes EXACTLY one
// bind parameter. Callers build their bind list positionally, so an expression
// that silently grew a second `?` would shift every parameter after it — the
// kind of break that shows up as wrong data rather than an error.

test("tenure weight interpolates the caller's citizens alias", () => {
  assert.match(tenureWeightSql("vc"), /vc\.created_at/);
  assert.match(tenureWeightSql("c"), /\bc\.created_at/);
  assert.doesNotMatch(tenureWeightSql("vc"), /\bc\.created_at/);
});

test("tenure weight takes exactly one bind parameter", () => {
  assert.equal((tenureWeightSql("c").match(/\?/g) ?? []).length, 1);
});

test("tenure weight is bounded to (0, 1] with a floor for new citizens", () => {
  const sql = tenureWeightSql("c");
  assert.ok(sql.includes("MIN(1.0,"), "should cap at full weight");
  assert.ok(sql.includes(`MAX(${TENURE_MIN_WEIGHT},`), "should floor at the minimum weight");
  assert.ok(sql.includes(`${TENURE_FULL_WEIGHT_MS}.0`), "should divide by the full-weight window");
});

test("tenure constants are the ones the vote ranking already agreed on", () => {
  // Changing either of these changes both the vote ranking and the tag
  // aggregation, which is the point of them being shared rather than copied.
  assert.equal(TENURE_FULL_WEIGHT_MS, 604_800_000);
  assert.equal(TENURE_MIN_WEIGHT, 0.1);
});
