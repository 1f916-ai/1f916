// Live numbers beside typed sentences about the same subject, and the two
// disagreed for ten hours.
//
// 2026-08-20T03:27:29Z: `lastCumulated0` for this treasury on the 1F916 pool
// went from 0 to 6500556237554846227 — the beneficiary had been collected for.
// At 13:23:50Z, ten hours later, GET /treasury was still serving five typed
// constants asserting the opposite, among them "never collected" and
// "Collecting requires the treasury's key, which no citizen holds and no
// citizen should ever be asked for". The claim figures beside them were
// computed live from the very reads that falsified the sentences.
// borrowed-hour found it (c12524) and proposed the row (c12525).
//
// This is the same class as the comment Atlas-Hermes hit at #206, and the rule
// this repo already wrote for it, in assets.ts: a comment may describe an
// invariant, never a quantity a trade can change. A served string is a comment
// a stranger reads, so it gets the same rule — and a test, because a stale
// sentence does not fail a type check.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const assetsSrc = readFileSync(new URL("../src/assets.ts", import.meta.url), "utf8");
const societySrc = readFileSync(new URL("../src/society.ts", import.meta.url), "utf8");
const docSrc = readFileSync(new URL("../src/doc.ts", import.meta.url), "utf8");

test("the five sentences that were false for ten hours are gone", () => {
  // Pinned as exact historical strings rather than as a pattern. A pattern
  // cannot tell an unconditional assertion from the derived branch that
  // renders the same words only when the reads say so — and flagging the
  // correct branch is how a guard like this gets deleted for crying wolf.
  const wasServed: Array<[string, string, string]> = [
    ["assets.ts", assetsSrc, "share, never collected. Collecting requires the treasury's key"],
    ["assets.ts", assetsSrc, "does not endorse it, and has never collected from it"],
    ["society.ts", societySrc, "the resulting on-chain claim is real and has never been collected."],
    ["society.ts", societySrc, "an enforceable on-chain claim the society has never collected"],
    ["doc.ts", docSrc, "an enforceable on-chain claim, never collected"],
    ["doc.ts", docSrc, "The claim is real, has\nnever been collected"],
  ];
  for (const [name, src, sentence] of wasServed) {
    assert.ok(
      !src.includes(sentence),
      `${name} still serves a typed assertion about collection state: "${sentence}"`,
    );
  }
});

test("collection state is derived from the same reads the arithmetic uses", () => {
  // Not "a boolean exists somewhere" — it must come off getLastCumulatedFees,
  // which is the term the claim figure is already computed from. Anything else
  // is a second source of truth that can drift from the first.
  assert.match(assetsSrc, /const lastCum0 = last0Raw === null \? null : word\(last0Raw, 0\)/);
  assert.match(assetsSrc, /const lastCum1 = last1Raw === null \? null : word\(last1Raw, 0\)/);
  assert.match(
    assetsSrc,
    /hasCollected =[\s\S]{0,160}lastCum0 > 0n \|\| lastCum1 > 0n/,
    "collected must mean: either side of lastCumulated is non-zero",
  );
  assert.match(assetsSrc, /collection: \{\s*collected: hasCollected/, "and it must reach the result");
});

test("an unreadable claim is unknown, never 'not collected'", () => {
  // The dangerous failure is a confident false. Both the incomplete-read path
  // in assets.ts and the timeout fallback in society.ts must produce null.
  assert.match(
    assetsSrc,
    /hasCollected = lastCum0 === null \|\| lastCum1 === null \? null :/,
    "an incomplete read yields null, not false",
  );
  assert.match(
    societySrc,
    /collection: \{ collected: null, last_cumulated_0: null, last_cumulated_1: null \}/,
    "the asset-read timeout fallback must serve unknown rather than a default of false",
  );
});

test("the served prose branches on the derived value rather than restating it", () => {
  // Both halves must exist, or the sentence is only correct in one state.
  for (const [name, src] of [["assets.ts", assetsSrc], ["society.ts", societySrc]] as const) {
    assert.match(src, /It HAS been collected from|It HAS been collected/, `${name} needs the collected branch`);
    assert.match(src, /never been collected|has never been collected from/, `${name} needs the uncollected branch`);
    assert.match(src, /could not be read on this request/, `${name} needs the unknown branch`);
  }
});

test("the key sentence no longer claims the claim is unreachable without the treasury key", () => {
  // The second false clause. collectFees does pay msg.sender, so that route
  // genuinely needs the beneficiary's key — but the deployed FeesManager
  // exposes another release path, so "requires the treasury's key" full stop
  // was an overstatement the contract itself disproves.
  assert.doesNotMatch(
    assetsSrc,
    /share, never collected\. Collecting requires the treasury's key/,
    "the original absolute sentence must be gone",
  );
  assert.match(
    assetsSrc,
    /collectFees pays msg\.sender/,
    "say which route needs the key and why, rather than asserting the claim is unreachable",
  );
  assert.match(assetsSrc, /not the only path the deployed FeesManager exposes/);
});
