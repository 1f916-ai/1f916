// A dated measurement is only legitimate because it is LABELLED, and until this
// file nothing checked the label.
//
// Two figures in the recognition block cannot be derived from a balance: how
// much one sender has cumulatively sent, and how much was given deliberately.
// Both need a walk of hundreds of ranged eth_getLogs calls, which an anonymous
// GET may not cost this society. So they are typed constants on a page whose
// entire discipline is that quantities are computed, and the ONLY thing that
// makes that acceptable is `as_of`, `method`, and `live: false` on the wire.
//
// The pre-deploy auditor ran six mutations against the full 794-test suite on
// 2026-08-21. All six passed green: strip the `measured` object off the served
// entry, flip `live: false` to true, delete `as_of` from the constant, strip
// `given_deliberately.measured`, delete `recognition_is_not_endorsement`, and
// delete the promotion/placement ban from standing_rules. A dated measurement
// could silently lose its date and ship. That is "never collected" with the
// serial numbers filed off, and closing it with care rather than a guard is
// what this repo has already learned does not work.

import test from "node:test";
import assert from "node:assert/strict";
import { MEASURED, SELECTORS } from "../src/assets.ts";
import { treasury, type Env } from "../src/society.ts";

// The asset cache is a process-global Map keyed by address+RPC, so every test
// in this file needs its OWN treasury address or it reads the previous test's
// snapshot through the 30s TTL. Cost me two debugging passes; writing it down
// so it costs the next reader none.
const stubEnv = (TREASURY: string) =>
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

test("every MEASURED entry carries the date and the walk that produced it", () => {
  const entries = Object.entries(MEASURED as Record<string, Record<string, unknown>>);
  assert.ok(entries.length > 0, "the constant exists to be labelled; an empty one is a silent removal");
  for (const [name, entry] of entries) {
    assert.equal(typeof entry.as_of, "string", `MEASURED.${name} must say WHEN it was measured`);
    assert.match(
      String(entry.as_of),
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/,
      `MEASURED.${name}.as_of must be a real instant, not a placeholder — an earlier draft shipped "05:2xZ"`,
    );
    assert.equal(typeof entry.method, "string", `MEASURED.${name} must say HOW`);
    assert.ok(
      String(entry.method).length > 80,
      `MEASURED.${name}.method must be re-runnable by a stranger, not a word`,
    );
  }
});

test("a measured figure is served as measured, and the endorsement boundary is served at all", async () => {
  const originalFetch = globalThis.fetch;
  try {
    // Every provider down. The labels are structural and must survive the
    // degraded path, which is the path where a reader most needs them.
    globalThis.fetch = (async () => {
      throw new Error("provider unreachable");
    }) as unknown as typeof fetch;

    const body = await treasury(stubEnv("0x0000000000000000000000000000000000000041"));
    const policy = body.spending_policy as Record<string, unknown>;
    const rec = policy.recognition as {
      tokens: Array<Record<string, unknown>>;
      given_deliberately: Record<string, unknown>;
    };

    const measuredTokens = rec.tokens.filter((t) => t.live === false);
    assert.equal(measuredTokens.length, 1, "exactly one served token entry is a measurement, and it must say so");
    for (const t of measuredTokens) {
      const m = t.measured as Record<string, unknown> | undefined;
      assert.ok(m, "a token entry marked live:false must carry its measured block");
      assert.equal(typeof m.as_of, "string");
      assert.equal(typeof m.method, "string");
    }
    for (const t of rec.tokens.filter((x) => x.live === true)) {
      assert.ok(!("measured" in t), "a live entry must not claim to be a measurement");
    }

    const gd = rec.given_deliberately.measured as Record<string, unknown> | undefined;
    assert.ok(gd, "given_deliberately is a walk, not a balance, and must carry its receipt");
    assert.equal(typeof gd.as_of, "string");
    assert.equal(typeof gd.method, "string");

    // The boundary itself. Recognition without it is an endorsement with extra
    // steps, and the auditor deleted this field with the whole suite green.
    assert.equal(
      typeof policy.recognition_is_not_endorsement,
      "string",
      "the page must state that listing what an asset sent is not a recommendation",
    );
    // Recognition of the official token happened on 2026-08-25 and this
    // boundary had to survive it: the sentence that used to lean on "no
    // official token" must still deny endorsement without that crutch.
    assert.match(String(policy.recognition_is_not_endorsement), /never issued a token/);
    assert.match(String(policy.recognition_is_not_endorsement), /not an endorsement/);
    assert.match(
      String((policy as { standing_rules: string }).standing_rules),
      /does not buy promotion or placement of any asset/,
      "the ban on spending treasury money on promotion is a constitutional line and was unguarded",
    );

    // And the BLOCK the auditor found: a failed read must never render as zero.
    for (const t of rec.tokens.filter((x) => x.live === true)) {
      assert.doesNotMatch(
        String(t.sent),
        /^0\.0+ /,
        "an unread balance must be reported as unread, never as a precise zero in a sentence",
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});


// The guards above run with every provider DOWN. Seven mutations escaped the
// full 796-test suite because nothing exercised the HEALTHY path, including two
// that revert this round's own fixes: dropping `location` from the qty() filter
// so `sent` counts claimable again, and returning 0 instead of null for the
// zero-rows case. A fix with no guard is a fix with a countdown on it.
test("on a healthy read, sent is wallet-only and a dust claimable never renders as zero", async () => {
  const word = (v: bigint) => v.toString(16).padStart(64, "0");
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body));
      if (!Array.isArray(payload)) return Response.json({ jsonrpc: "2.0", id: 1, result: "0x" + word(0n) });
      const roundData = "0x" + [0n, 2_000n * 100_000_000n, 0n, BigInt(Math.floor(Date.now() / 1000)), 0n].map(word).join("");
      return Response.json(
        payload.map(({ id, params }: { id: number; params?: [{ data: string }, "latest"] }) => {
          const data = params?.[0].data ?? "";
          if (data === SELECTORS.latestRoundData) return { id, result: roundData };
          if (data.startsWith(SELECTORS.getSlot0)) return { id, result: "0x" + [1n << 96n, 0n, 0n, 3_000n].map(word).join("") };
          if (data.startsWith(SELECTORS.slot0V3)) return { id, result: "0x" + [1n << 96n, 0n, 0n, 0n, 0n, 0n, 0n].map(word).join("") };
          // A DUST CLAIMABLE: 0.4 of a token. Math.round() takes that to 0 while
          // the holdings table beside it prices it in dollars. Reachable after
          // every collection, since the claimable rows climb back from zero.
          // Two different hazards in one fixture, on purpose.
          // word0 (WETH) is DUST: 4e-7, below amount()'s six-decimal floor, so
          // a naive toFixed(6) prints "0.000000" for a real quantity.
          // word1 (the token) is 3 whole tokens against a 5-token wallet row,
          // so wallet-only and wallet+claimable round to DIFFERENT integers.
          // The first fixture used 0.4 there, which rounded to the same number
          // as the wallet row and made the "sent is wallet-only" assertion
          // vacuous — it passed with the fix reverted.
          if (data.startsWith(SELECTORS.collectFees)) return { id, result: "0x" + word(4n * 10n ** 11n) + word(3n * 10n ** 18n) };
          if (data.startsWith(SELECTORS.getShares)) return { id, result: "0x" + word(10n ** 18n) };
          if (data.startsWith(SELECTORS.balanceOf)) return { id, result: "0x" + word(5n * 10n ** 18n) };
          return { id, result: "0x" + word(0n) };
        }),
      );
    }) as typeof fetch;

    const body = await treasury(stubEnv("0x0000000000000000000000000000000000000043"));
    const policy = body.spending_policy as Record<string, unknown>;
    const rec = policy.recognition as { tokens: Array<Record<string, unknown>> };
    const holdings = (body.assets as unknown as { holdings: Array<Record<string, unknown>> }).holdings;

    // (a) N3: `sent` must be WALLET ONLY. An invoice is not revenue.
    const walletTokens = holdings.filter((h) => h.location === "wallet" && h.chain === "base" && h.asset === "1F916");
    const claimTokens = holdings.filter((h) => h.location === "claimable" && h.chain === "base" && h.asset === "1F916");
    assert.ok(claimTokens.length > 0 && Number(claimTokens[0].quantity) > 0, "fixture must produce a claimable row");
    const sent = String(rec.tokens[0].sent);
    const walletQty = Math.round(Number(walletTokens[0].quantity));
    assert.match(sent, new RegExp(walletQty.toLocaleString("en-US").replace(/,/g, ",")), "sent names the wallet quantity");
    const bothQty = Math.round(Number(walletTokens[0].quantity) + Number(claimTokens[0].quantity));
    if (bothQty !== walletQty) {
      assert.doesNotMatch(sent, new RegExp(bothQty.toLocaleString("en-US")), "sent must NOT include the claimable row");
    }

    // (c) a dust claimable must never render as the bare digit 0.
    const accruing = String(rec.tokens[0].still_accruing_in_the_pool);
    assert.doesNotMatch(
      accruing,
      /(^|\s)0 of its supply|(^|\s)0\.0+ WETH/,
      "a non-zero claimable rounded to zero is a rounding lie beside a dollar figure that disagrees",
    );
    assert.match(accruing, /less than 0\.000001 WETH/, "a dust WETH claimable must render as a bound, not as 0.000000");

    // (d) N8: the boundary by MEANING, not by substring. A disclaimer that
    //     contains the right phrase and then recommends the asset is worse than
    //     no disclaimer, and the phrase-match guard passed exactly that.
    const boundary = String(policy.recognition_is_not_endorsement);
    assert.match(boundary, /not an endorsement/);
    assert.match(boundary, /never issued a token/);
    assert.doesNotMatch(
      boundary,
      /\brecommends?\b|\bencourages?\b|\bshould buy\b|\bworth buying\b/i,
      "the endorsement boundary must not itself recommend anything",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// (b) N4: the other half of the BLOCK. qty() must report UNREAD when there are
// no rows at all, not zero — that is the no-provider path, which the
// all-providers-down fixture never reaches because it still creates null rows.
test("a chain with no rows at all reports unread, not zero", async () => {
  const { readTreasuryAssets } = await import("../src/assets.ts");
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    // No BNB provider configured: readBnbHoldings is never called, so there is
    // no bnb row of any kind.
    const read = await readTreasuryAssets("0x0000000000000000000000000000000000000042", ["https://rpc.test"], []);
    assert.equal(read.holdings.filter((h) => h.chain === "bnb").length, 0, "the fixture must produce zero bnb rows");
    assert.ok(
      read.errors.some((e) => /no BNB Chain provider configured/.test(e)),
      "an unread chain must be disclosed, never silently absent",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});


// KNOWINGLY UNGUARDED, and written down rather than left silent.
//
// The auditor's N4 mutation makes qty() return 0 instead of null for the
// zero-rows case, and it still passes. I could not build a fixture that reaches
// it through treasury(): bnbRpcUrls() always returns four entries and the
// `env.BNB_RPC_URL || default` absorbs an empty binding, so a token entry whose
// chain contributed NO holdings rows at all cannot occur in production or in
// any harness that goes through the real config path. Every reachable failure
// produces rows with null quantities, which IS guarded above.
//
// Testing it would mean either exporting recognitionBlock purely to test it, or
// faking a config state the code forbids. Both make the test a description of
// itself rather than of the system. So: the branch is defensive, it is
// unreachable by construction, and if bnbRpcUrls() is ever changed to return an
// empty list, this comment is the thing that should stop you.


// THE SECOND VACUOUS GUARD IN THIS FILE, and the auditor caught it the same way
// it caught the first: by reverting the fix and watching the suite stay green.
//
// The test above needs a claimable of 3 whole tokens so that wallet-only and
// wallet-plus-claimable round to DIFFERENT integers, which is what makes the
// "sent is wallet-only" assertion bite. But Math.round(3) is 3 with or without
// whole()'s sub-1 floor, so the very fixture that arms one assertion disarms the
// one beside it. Exactly the shape of the 0.4-against-5 collision I had already
// been caught on once in this same file.
//
// The lesson is not "write better fixtures". It is that a hazard which must be
// large for one assertion and small for another needs TWO fixtures, and that a
// negative assertion (doesNotMatch) proves nothing unless something in the same
// run proves the branch executed at all. Both checks below are positive.
test("a sub-1 claimable renders as a bound, and a true zero still renders as zero", async () => {
  const word = (v: bigint) => v.toString(16).padStart(64, "0");
  const originalFetch = globalThis.fetch;
  const run = async (uncollected1: bigint, address: string) => {
    globalThis.fetch = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body));
      if (!Array.isArray(payload)) return Response.json({ jsonrpc: "2.0", id: 1, result: "0x" + word(0n) });
      const roundData = "0x" + [0n, 2_000n * 100_000_000n, 0n, BigInt(Math.floor(Date.now() / 1000)), 0n].map(word).join("");
      return Response.json(
        payload.map(({ id, params }: { id: number; params?: [{ data: string }, "latest"] }) => {
          const data = params?.[0].data ?? "";
          if (data === SELECTORS.latestRoundData) return { id, result: roundData };
          if (data.startsWith(SELECTORS.getSlot0)) return { id, result: "0x" + [1n << 96n, 0n, 0n, 3_000n].map(word).join("") };
          if (data.startsWith(SELECTORS.slot0V3)) return { id, result: "0x" + [1n << 96n, 0n, 0n, 0n, 0n, 0n, 0n].map(word).join("") };
          if (data.startsWith(SELECTORS.collectFees)) return { id, result: "0x" + word(0n) + word(uncollected1) };
          if (data.startsWith(SELECTORS.getShares)) return { id, result: "0x" + word(10n ** 18n) };
          if (data.startsWith(SELECTORS.balanceOf)) return { id, result: "0x" + word(5n * 10n ** 18n) };
          return { id, result: "0x" + word(0n) };
        }),
      );
    }) as typeof fetch;
    const body = await treasury(stubEnv(address));
    const rec = (body.spending_policy as { recognition: { tokens: Array<Record<string, unknown>> } }).recognition;
    return String(rec.tokens[0].still_accruing_in_the_pool);
  };

  try {
    // 0.4 tokens. Math.round takes it to 0; the holdings row prices it in dollars.
    const dust = await run(4n * 10n ** 17n, "0x0000000000000000000000000000000000000044");
    assert.match(dust, /less than 1 of its supply/, "a sub-1 claimable must render as a bound, never as the digit 0");

    // And the converse, so the fix cannot be 'improved' into never saying zero:
    // a genuine zero must still read as zero, not as a bound over nothing.
    const zero = await run(0n, "0x0000000000000000000000000000000000000045");
    assert.match(zero, /0 of its supply/, "a real zero is a fact and must be stated as one");
    assert.doesNotMatch(zero, /less than/, "a bound over an empty pool would be an invented uncertainty");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// N5. `totals_note` asserts an ABSENCE — "there is deliberately no single
// 'total sent' figure" — and an absence claim in served prose has to be
// mechanical or it is just a sentence. Restoring token_derived_total would put a
// field with exactly that meaning beside a sentence denying it exists: a
// self-contradiction inside one response, which is different in kind from a
// response that is merely thinner.
test("the recognition block carries no total but the one it says it carries", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    const body = await treasury(stubEnv("0x0000000000000000000000000000000000000046"));
    const rec = (body.spending_policy as { recognition: Record<string, unknown> }).recognition;
    const totals = Object.keys(rec).filter((k) => /_total$/.test(k));
    assert.deepEqual(totals, ["treasury_total"], "the only total on this block is the one that is a balance");
    assert.match(String(rec.totals_note), /deliberately no single/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
