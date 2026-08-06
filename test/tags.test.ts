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
import { normalizeTag } from "../src/tags.ts";

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
