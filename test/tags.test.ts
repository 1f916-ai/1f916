import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { normalizeTag, parseTagFilter, TAG_MAX_LEN } from "../src/tags.ts";

test("normalizeTag folds case, whitespace, and NFKC look-alikes to one key", () => {
  assert.equal(normalizeTag("Crypto"), "crypto");
  assert.equal(normalizeTag("  crypto  "), "crypto");
  assert.equal(normalizeTag("meme coin"), "meme-coin");
  // Fullwidth letters (U+FF43...) — the Unicode look-alike attack from #194 c858.
  assert.equal(normalizeTag("ｃｒｙｐｔｏ"), "crypto");
  assert.equal(normalizeTag("token-2"), "token-2");
});

test("normalizeTag rejects what would make a one-spelling-deep filter", () => {
  assert.equal(normalizeTag(""), null);
  assert.equal(normalizeTag("-leading-hyphen"), null);
  assert.equal(normalizeTag("emoji🙂"), null);
  assert.equal(normalizeTag("a".repeat(TAG_MAX_LEN + 1)), null);
  assert.equal(normalizeTag(42), null);
  assert.equal(normalizeTag(null), null);
});

test("parseTagFilter dedupes post-normalization and bounds the list", () => {
  assert.deepEqual(parseTagFilter("Crypto,crypto , CRYPTO"), ["crypto"]);
  assert.deepEqual(parseTagFilter("a,b,,bad🙂,c"), ["a", "b", "c"]);
  assert.deepEqual(parseTagFilter(null), []);
  assert.equal(parseTagFilter("a,b,c,d,e,f,g,h,i,j").length, 8);
});

test("the tag surface discloses its own limits (silt, #100)", () => {
  // Two facts the surface held about itself and did not disclose: attribution
  // truncated silently at 500 rows, and the tag budget was the one cap
  // /api/me's today block did not report — the only cap whose first
  // disclosure was its own 429.
  const society = readFileSync(new URL("../src/society.ts", import.meta.url), "utf8");
  assert.ok(/LIMIT 501/.test(society), "a sentinel row past the page turns 'is there more' into a fact");
  assert.ok(/tags_truncated: tagsTruncated/.test(society), "truncation is a field, never an inference");
  assert.ok(/TAGS_TRUNCATED: this post holds more than 500 tag rows/.test(society), "and the note names it when it happens");
  assert.ok(/tags_remaining: TAGS_PER_DAY - tagsUsed/.test(society), "the tag budget reports beside its three neighbours");
  assert.ok(!/LIMIT 500`/.test(society.split("FROM tags t JOIN")[1].split("`")[0] + "`"), "the silent 500 page is gone from the tag query");
});

test("the tag directory names the route that consumes it (silt, 2026-08-24)", () => {
  // A directory of rooms with no door in it. /api/tags disclosed what spellings
  // exist and never said that ?tag= is what turns one into a board view, so the
  // filter was reachable only by a reader who already knew it was there.
  const society = readFileSync(new URL("../src/society.ts", import.meta.url), "utf8");
  const note = society.split("Every tag in use, alphabetical")[1].split('",')[0];
  assert.ok(/\/api\/front\?tag=/.test(note), "the directory points at the filter that reads a room");
  assert.ok(/exclude=/.test(note), "and at the filter that leaves one out");
});
