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
import { SELECTORS } from "../src/assets.ts";
import { treasury, type Env } from "../src/society.ts";

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
  // doc.ts said the same absolute thing and had no guard at all, so reverting
  // it alone kept the suite green (auditor MUT D). The door and the books must
  // not be able to disagree about whether a key is the only path.
  assert.doesNotMatch(
    docSrc,
    /collecting anything\s+would need the treasury's key/,
    "the front door carried the same absolute claim src/assets.ts now repudiates",
  );
  assert.match(docSrc, /collectFees pays msg\.sender/);
  // doc.ts hard-wraps its prose, so the sentence spans a line break. Match
  // across whitespace rather than pinning the wrap column, which would make
  // this guard fail on a reflow that changed nothing.
  assert.match(docSrc, /not the only\s+path the deployed FeesManager exposes/);
});

// The three tests above read SOURCE TEXT. They prove the strings changed; they
// execute nothing, so they cannot notice a derived value that is computed
// correctly and then dropped before serialisation. That is exactly what
// happened: assets.ts, doc.ts and assets_note each told a reader that the
// collection state "is served as assets.collection", while the served object
// was built from an explicit literal that never carried the field. Three typed
// assertions about a served surface, none of them checked against the surface —
// the same class the whole change exists to remove, surviving inside the fix
// for it. Found by the pre-deploy auditor, 2026-08-21, which pointed out that
// one assertion against the real response would have caught it for free.
//
// So this one runs the endpoint.
test("the collection state a served sentence points at is actually on the served object", async () => {
  const TREASURY = "0x0000000000000000000000000000000000000037";
  const word = (value: bigint) => value.toString(16).padStart(64, "0");
  const stubEnv = () =>
    ({
      DB: {
        prepare(sql: string) {
          return {
            async all<T>() {
              return { results: [] as T[] };
            },
            async first<T>() {
              if (sql.includes("SUM(amount_cents)")) return { balance: 0 } as T;
              return { n: 0 } as T;
            },
          };
        },
      },
      TREASURY_ADDRESS: TREASURY,
      BASE_RPC_URL: "https://rpc.test",
    }) as unknown as Env;

  const originalFetch = globalThis.fetch;
  // Non-zero lastCumulated words: the on-chain state after 2026-08-20T03:27:29Z.
  // If the wiring is right, every surface below must say collection HAPPENED.
  const LAST0 = 6_500_556_237_554_846_227n;
  const LAST1 = 3_558_869_812_786_525_367_352_640_813n;
  try {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body));
      if (!Array.isArray(payload)) return Response.json({ jsonrpc: "2.0", id: 1, result: "0x" + word(0n) });
      const zero = "0x" + word(0n);
      const roundData =
        "0x" + [0n, 2_000n * 100_000_000n, 0n, BigInt(Math.floor(Date.now() / 1000)), 0n].map(word).join("");
      const slot0 = "0x" + [1n << 96n, 0n, 0n, 3_000n].map(word).join("");
      return Response.json(
        payload.map(({ id, params }: { id: number; params?: [{ data: string }, "latest"] }) => {
          const data = params?.[0].data ?? "";
          if (data === SELECTORS.latestRoundData) return { id, result: roundData };
          if (data.startsWith(SELECTORS.getSlot0)) return { id, result: slot0 };
          if (data.startsWith(SELECTORS.collectFees)) return { id, result: "0x" + word(0n) + word(0n) };
          if (data.startsWith(SELECTORS.getLastCumulatedFees0)) return { id, result: "0x" + word(LAST0) };
          if (data.startsWith(SELECTORS.getLastCumulatedFees1)) return { id, result: "0x" + word(LAST1) };
          return { id, result: zero };
        }),
      );
    }) as typeof fetch;

    const body = await treasury(stubEnv());
    const assets = body.assets as unknown as Record<string, unknown>;

    // 1. The field the prose points at exists on the wire at all.
    assert.ok(
      Object.prototype.hasOwnProperty.call(assets, "collection"),
      "assets.collection is named by three served sentences and must be on the served object",
    );
    const collection = assets.collection as { collected: boolean | null; last_cumulated_0: string | null };

    // 2. It carries the DERIVED answer, not a placeholder.
    assert.equal(collection.collected, true, "non-zero lastCumulated words mean this beneficiary has been collected for");
    assert.equal(collection.last_cumulated_0, LAST0.toString(), "the served word must be the word that was read");
    assert.equal(
      collection.last_cumulated_1,
      LAST1.toString(),
      "both words or neither: asserting only word 0 left half the derived payload free to be hardcoded null (auditor MUT C)",
    );

    // 3. THE FIELD THE ORIGINAL DEFECT ACTUALLY LIVED IN. "share, never
    //    collected. Collecting requires the treasury's key" was served from the
    //    claimable holding's own note, not from refill_rung, and the first
    //    version of this test never looked at it. The auditor swapped the two
    //    branches of that note (MUT B) and the whole suite stayed green while
    //    one response carried collected:true beside a note saying it had never
    //    been collected — the verbatim ten-hour bug, reintroduced under 791
    //    passing tests.
    const holdings = assets.holdings as Array<{ location: string; note: string }>;
    const claimable = holdings.find((h) => h.location === "claimable");
    assert.ok(claimable, "the claim on the pool must still be reported as a holding");
    assert.match(
      claimable.note,
      /HAS been collected from/,
      "the claimable holding's own note must agree with the derived collection state, not merely refill_rung",
    );
    assert.doesNotMatch(claimable.note, /never been collected/);

    // 4. Every neighbouring sentence agrees with it. The failure being pinned is
    //    disagreement INSIDE one response, which is how /treasury read for ten
    //    hours on 2026-08-20 and would have read again with a stale sibling.
    const rung = (body.spending_policy as { refill_rung: Record<string, string> }).refill_rung;
    assert.match(rung.what, /HAS been collected/);
    assert.doesNotMatch(
      JSON.stringify(rung),
      /never been collected|does not collect what it has no need to collect|if it ever happens/,
      "no sibling of the derived sentence may assert the state it just contradicted",
    );
    assert.ok(!("why_uncollected" in rung), "a key whose NAME presupposes one state cannot be answered in the other");
    assert.ok(!("if_collected" in rung), "same, one axis over: 'if' is false once it has happened");

    // 5. AGENCY. getLastCumulatedFees says THAT the beneficiary was drawn on and
    //    never BY WHOM, so no branch selected by that boolean may claim who did
    //    it. The first fix for this was a text edit with no guard, and the
    //    auditor reverted the sentence verbatim with the whole suite green
    //    (NEW-3). A doesNotMatch list alone cannot hold a class — pin the
    //    replacement's PRESENCE too, so deleting it fails rather than passing.
    assert.doesNotMatch(
      JSON.stringify(rung),
      /did not collect this|society did not collect/,
      "no branch may assert agency from a read that carries none",
    );
    assert.match(
      rung.posture,
      /record the amount drawn, never the address that drew it/,
      "say what the read can and cannot attribute, rather than asserting who acted",
    );

    // 6. NEW-4: the same false claim lives on CLAIM_SOURCES.note, which is
    //    served on TWO holdings. Test 1 pins only the exact historical string,
    //    so a freshly worded version of it walked straight through onto both.
    //    Match the CLASS on every served note, not one remembered sentence.
    for (const h of holdings) {
      assert.doesNotMatch(
        h.note ?? "",
        /never (been )?collected|never drawn|never collected from it/,
        `holding note contradicts collected:true — ${h.location}`,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});


// NEW-1, the auditor's sharpest one. Every executable assertion above runs the
// `collected === true` path. The `null` path is REACHABLE IN PRODUCTION — the
// 6s ASSET_REFRESH_BUDGET_MS timeout and any provider outage land there — and
// nothing executed it, so its branch could be replaced with a confident false
// and the suite stayed green at 791. src/society.ts:6777 says in a comment that
// a failed read must never be served as "has never collected"; this is that
// comment turned into something that fails.
//
// The `false` path is deliberately NOT tested here: lastCumulated is monotonic
// and already non-zero on-chain, so it is unreachable for this pool forever.
// Testing an unreachable state would be theatre; saying why is not.
test("a failed read serves unknown, and no sentence in that response claims it was never collected", async () => {
  // A DIFFERENT treasury address from the test above, on purpose. The asset
  // cache is a process-global Map keyed by address+RPC (src/society.ts:6733),
  // so reusing 0x...37 here served that test's collected:true snapshot through
  // the stale-cache path and this assertion read `true` instead of `null`. The
  // cache working exactly as designed; the test isolating itself badly.
  const TREASURY = "0x0000000000000000000000000000000000000038";
  const stubEnv = () =>
    ({
      DB: {
        prepare(sql: string) {
          return {
            async all<T>() {
              return { results: [] as T[] };
            },
            async first<T>() {
              if (sql.includes("SUM(amount_cents)")) return { balance: 0 } as T;
              return { n: 0 } as T;
            },
          };
        },
      },
      TREASURY_ADDRESS: TREASURY,
      BASE_RPC_URL: "https://rpc.test",
    }) as unknown as Env;

  const originalFetch = globalThis.fetch;
  try {
    // Every provider down. The reader must resolve honest nulls, not defaults.
    globalThis.fetch = (async () => {
      throw new Error("provider unreachable");
    }) as unknown as typeof fetch;

    const body = await treasury(stubEnv());
    const assets = body.assets as unknown as Record<string, unknown>;
    const collection = assets.collection as { collected: boolean | null };
    assert.equal(collection.collected, null, "an unreadable claim is unknown, never false");

    const rung = (body.spending_policy as { refill_rung: Record<string, string> }).refill_rung;
    assert.match(rung.what, /could not be read on this request/);
    assert.match(rung.posture, /could not be read on this request|nothing here characterises/);

    // Every NARRATIVE surface, not just the one field. Scoped to refill_rung and
    // the holdings' notes rather than the whole body on purpose: the `verify`
    // recipe legitimately contains the phrase "0 if it has never collected"
    // while EXPLAINING what the word means, which is a description of the read
    // and not a claim about its value. A guard that cannot tell those apart
    // gets deleted for crying wolf, which is how the last one died.
    const narrative = [
      ...Object.values(rung),
      ...(assets.holdings as Array<{ note?: string }>).map((h) => h.note ?? ""),
    ].join("\n");
    assert.doesNotMatch(
      narrative,
      /has never been collected|never been collected from|has never collected|never drawn/,
      "a failed read must not be served as an assertion that collection never happened",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
