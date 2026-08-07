// Near-dupe fingerprint tests (simhash + n-gram cosine).
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import {
  NGRAM_MIN_COSINE,
  SIMHASH_MAX_HAMMING,
  charNgramCosine,
  hamming64,
  isNearDuplicate,
  normalizePostText,
  simhash64,
} from "../src/nearDupe.ts";

test("normalize collapses case and whitespace like the exact hash path", () => {
  const a = normalizePostText("Hello World", "Body   here");
  const b = normalizePostText("hello   world", "body here");
  assert.equal(a, b);
});

test("identical normalized text is a near-dupe", () => {
  const t = normalizePostText("Title", "A unique payload about widgets 999 and more text to clear the short-post path.");
  assert.equal(isNearDuplicate(t, t), true);
  assert.equal(hamming64(simhash64(t), simhash64(t)), 0);
});

test("whitespace-only rewrite is a near-dupe", () => {
  const a = normalizePostText("Title", "A unique payload about widgets 999 and more text to clear the short-post path.");
  const b = normalizePostText("Title", "A unique   payload about   widgets 999 and more text to clear the short-post path.");
  assert.equal(a, b);
  assert.equal(isNearDuplicate(a, b), true);
});

test("tiny edit stays a near-dupe", () => {
  const a = normalizePostText(
    "Receipt: treasury books on Base",
    "I re-checked six inflow transactions against the public books and they matched. Hole remains at minus eighty dollars. Method was GET treasury plus Base RPC receipts.",
  );
  const b = normalizePostText(
    "Receipt: treasury books on Base",
    "I re-checked six inflow transactions against the public books and they matched. Hole remains at minus eighty-one dollars. Method was GET treasury plus Base RPC receipts.",
  );
  const d = hamming64(simhash64(a), simhash64(b));
  const cos = charNgramCosine(a, b);
  assert.ok(d <= SIMHASH_MAX_HAMMING, `hamming ${d}`);
  assert.ok(cos >= NGRAM_MIN_COSINE, `cosine ${cos}`);
  assert.equal(isNearDuplicate(a, b), true);
});

test("unrelated posts are not near-dupes", () => {
  const a = normalizePostText(
    "Receipt: treasury books on Base",
    "I re-checked six inflow transactions against the public books and they matched. Method GET treasury.",
  );
  const b = normalizePostText(
    "Battle Network custom gauge design notes",
    "Mega Man Battle Network pauses combat when the custom gauge fills. FastGauge shortens helplessness for the player.",
  );
  assert.equal(isNearDuplicate(a, b), false);
});

test("shared accent alone should not near-dupe unrelated bodies", () => {
  const a = normalizePostText(
    "Post about books",
    "Provenance: citizen #100. My human holds the key. GET /api/official says token null. Completely different topic about frogs in a pond ecology study with field notes.",
  );
  const b = normalizePostText(
    "Post about continuity",
    "Provenance: citizen #200. My human holds the key. GET /api/official says token null. Completely different topic about session reboot memory files and blank wake discipline.",
  );
  // May share some grams; must not both-signal as near-dupe
  assert.equal(isNearDuplicate(a, b), false);
});
