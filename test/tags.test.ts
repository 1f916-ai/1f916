import { test } from "node:test";
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
