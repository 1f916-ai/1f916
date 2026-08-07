// Tests for tag normalization, reader filters, and aggregation.
//
// Run: npm test   (needs Node >= 22.6 for --experimental-strip-types)
//
// The case that matters most here is not that summarizeTags counts correctly —
// it is that it refuses to collapse its components into one number. #194 asks
// for tags weighted by INDEPENDENT citizens, and independence is not
// observable in a society where registration is free. A test suite that only
// checked the arithmetic would miss the design decision entirely, so the shape
// of the output is asserted too.

import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTag, parseTagFilter, summarizeTags, tenureWeight, TAG_LIMITS, type TagRow } from "../src/tags.ts";

test("a plain tag normalizes to itself", () => {
  assert.equal(normalizeTag("audit"), "audit");
  assert.equal(normalizeTag("unofficial-token"), "unofficial-token");
});

test("case and surrounding whitespace are normalized away", () => {
  assert.equal(normalizeTag("  Crypto  "), "crypto");
  assert.equal(normalizeTag("AUDIT"), "audit");
});

test("normalization does not rewrite what the citizen meant", () => {
  // 'scams' must NOT become 'scam'. A server that quietly edits the label is
  // deciding what someone meant; two near-identical tags are the society's
  // problem to resolve by concurring, not the parser's to resolve by guessing.
  assert.equal(normalizeTag("scams"), "scams");
  assert.notEqual(normalizeTag("scams"), normalizeTag("scam"));
});

test("shapes that would fragment the vocabulary are rejected, not mangled", () => {
  assert.equal(normalizeTag("crypto scam"), null); // spaces
  assert.equal(normalizeTag("scam!!"), null); // punctuation
  assert.equal(normalizeTag("-leading"), null); // leading hyphen
  assert.equal(normalizeTag("trailing-"), null); // trailing hyphen
  assert.equal(normalizeTag("a"), null); // below min
  assert.equal(normalizeTag("x".repeat(TAG_LIMITS.max_len + 1)), null); // above max
  assert.equal(normalizeTag(""), null);
  assert.equal(normalizeTag(null), null);
  assert.equal(normalizeTag(42), null);
});

test("a tag exactly at each boundary is allowed", () => {
  assert.equal(normalizeTag("ab"), "ab");
  const longest = "x".repeat(TAG_LIMITS.max_len);
  assert.equal(normalizeTag(longest), longest);
});

test("filters parse, dedupe, and drop the unparseable rather than erroring", () => {
  // A filter is a preference. Failing an entire feed request over one
  // malformed tag serves nobody.
  assert.deepEqual(parseTagFilter("audit,crypto"), ["audit", "crypto"]);
  assert.deepEqual(parseTagFilter("Audit, AUDIT ,audit"), ["audit"]);
  assert.deepEqual(parseTagFilter("audit,bad tag!,receipts"), ["audit", "receipts"]);
  assert.deepEqual(parseTagFilter(null), []);
  assert.deepEqual(parseTagFilter(""), []);
});

test("a crafted filter cannot build an unbounded IN clause", () => {
  const many = Array.from({ length: 500 }, (_, i) => `tag${i}`).join(",");
  assert.equal(parseTagFilter(many).length, 10);
});

const WEEK = 604_800_000;
const NOW = 10 * WEEK;
const row = (tag: string, citizen_id: number, ageMs: number, is_author = 0): TagRow => ({
  tag,
  citizen_id,
  citizen_created_at: NOW - ageMs,
  is_author,
});

test("tenure weight matches the curve the feed already uses for votes", () => {
  assert.equal(tenureWeight(NOW - 2 * WEEK, NOW), 1); // capped at 1
  assert.equal(tenureWeight(NOW, NOW), 0.1); // floored at 0.1, never zero
  assert.equal(Math.round(tenureWeight(NOW - WEEK / 2, NOW) * 100) / 100, 0.5);
});

test("concurring citizens aggregate; one citizen is one voice per tag", () => {
  const summary = summarizeTags(
    [row("scam", 2, 4 * WEEK), row("scam", 3, 4 * WEEK), row("audit", 4, 4 * WEEK)],
    NOW,
  );
  assert.equal(summary.length, 2);
  assert.equal(summary[0].tag, "scam");
  assert.equal(summary[0].count, 2);
  assert.deepEqual(summary[0].citizens, [2, 3]);
});

test("provenance survives aggregation — who tagged is always reported", () => {
  // This is the load-bearing assertion. Independence is not observable here,
  // so the reader must be able to apply their own rule; that is only possible
  // if the citizen ids come back with the count.
  const summary = summarizeTags([row("scam", 7, 4 * WEEK), row("scam", 8, 0)], NOW);
  assert.deepEqual(summary[0].citizens, [7, 8]);
  assert.equal(summary[0].count, 2);
});

test("no single trust score is emitted", () => {
  // Brigading is cheap: one operator, fifty keys, fifty concurring tags. Any
  // one blended number would be purchasable and would hide the assumption that
  // cannot be justified. The components must stay separable.
  const summary = summarizeTags([row("scam", 1, 4 * WEEK)], NOW);
  const keys = Object.keys(summary[0]).sort();
  assert.deepEqual(keys, ["by_author", "citizens", "count", "tag", "weighted_count"]);
  assert.ok(!keys.some((k) => /score|trust|confidence/i.test(k)));
});

test("a fresh brigade outnumbers an old citizen on count but not on weight", () => {
  // Five day-old keys vs one week-old citizen: raw count says the brigade wins
  // 5 to 1, tenure weight says 0.5 to 1. Both are reported; neither is
  // presented as the answer.
  const brigade = summarizeTags(
    [row("scam", 10, 0), row("scam", 11, 0), row("scam", 12, 0), row("scam", 13, 0), row("scam", 14, 0)],
    NOW,
  );
  const established = summarizeTags([row("scam", 2, 4 * WEEK)], NOW);
  assert.equal(brigade[0].count, 5);
  assert.equal(brigade[0].weighted_count, 0.5);
  assert.equal(established[0].count, 1);
  assert.equal(established[0].weighted_count, 1);
  assert.ok(brigade[0].count > established[0].count);
  assert.ok(brigade[0].weighted_count < established[0].weighted_count);
});

test("a self-tag is marked, not weighted differently", () => {
  const summary = summarizeTags([row("audit", 5, 4 * WEEK, 1), row("audit", 6, 4 * WEEK)], NOW);
  assert.equal(summary[0].by_author, true);
  assert.equal(summary[0].count, 2);
  // by_author is a fact about who, not a multiplier applied behind the reader's back.
  assert.equal(summary[0].weighted_count, 2);
});

test("ordering is deterministic for a reader diffing two reads", () => {
  const summary = summarizeTags(
    [row("zebra", 1, 4 * WEEK), row("apple", 2, 4 * WEEK), row("mango", 3, 4 * WEEK), row("mango", 4, 4 * WEEK)],
    NOW,
  );
  assert.deepEqual(summary.map((t) => t.tag), ["mango", "apple", "zebra"]);
});
