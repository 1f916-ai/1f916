// Regression coverage for the fail-open asset paths in issue #38.
//
// Every fixture here is an eth_call result, never a transaction. The first
// test makes one provider answer only a single row so the healthy fallback has
// to fill the remaining holes. The remaining tests pin malformed slot0 handling:
// neither zero nor a short ABI word may become a confident zero-dollar mark,
// and zero must not crash the optional depth walk.

import test from "node:test";
import assert from "node:assert/strict";
import {
  CLAIM_SOURCES,
  SELECTORS,
  readPoolDepth,
  readTreasuryAssets,
  summarizeAssets,
  type RpcCall,
} from "../src/assets.ts";

const TREASURY = "0x0000000000000000000000000000000000000038";
const Q96 = 1n << 96n;
const abiWord = (value: bigint) => value.toString(16).padStart(64, "0");
const abi = (...values: bigint[]) => "0x" + values.map(abiWord).join("");

type RpcRequest = {
  id: number;
  params: [RpcCall, "latest"];
};

function resultFor(call: RpcCall, sqrtPriceX96 = Q96): string {
  if (call.data === SELECTORS.latestRoundData) {
    return abi(1n, 2_000n * 100_000_000n, 0n, 1_700_000_000n, 1n);
  }
  if (call.data.startsWith(SELECTORS.getSlot0)) {
    return abi(sqrtPriceX96, 0n, 0n, 3_000n);
  }
  if (call.data.startsWith(SELECTORS.collectFees)) return abi(0n, 0n);
  return abi(0n);
}

function rowsFor(payload: RpcRequest[], sqrtPriceX96 = Q96) {
  return payload.map(({ id, params }) => ({ id, result: resultFor(params[0], sqrtPriceX96) }));
}

async function withMockFetch<T>(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  action: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler as typeof fetch;
  try {
    return await action();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("the asset batch fills a partial provider response from a healthy fallback", async () => {
  const requestedUrls: string[] = [];
  const requestedBatchSizes: number[] = [];
  await withMockFetch(
    async (input, init) => {
      const url = String(input);
      requestedUrls.push(url);
      const payload = JSON.parse(String(init?.body)) as RpcRequest[];
      requestedBatchSizes.push(payload.length);
      const rows = rowsFor(payload);
      // A superficially usable batch used to stop fallback after this one row.
      return Response.json(url === "https://partial.rpc" ? rows.slice(0, 1) : rows);
    },
    async () => {
      const read = await readTreasuryAssets(TREASURY, ["https://partial.rpc", "https://healthy.rpc"]);
      assert.deepEqual(requestedUrls, ["https://partial.rpc", "https://healthy.rpc"]);
      assert.deepEqual(requestedBatchSizes, [11, 10], "the answered row must not be fetched again");
      // This test is about the BASE batch's fallback, so it is run with no BNB
      // provider on purpose. The one error it now carries is that absence,
      // disclosed rather than silently answered as zero — a chain that was not
      // read must never be reported as a chain holding nothing.
      assert.deepEqual(read.errors, [
        "no BNB Chain provider configured; holdings on that chain are NOT being reported as zero, and this response's totals cover Base only",
      ]);
      assert.equal(read.eth_usd, 2_000);
      assert.equal(read.token_usd, 2_000);
      // Passes readOk exactly as src/society.ts does, so this fixture tests the
      // served composition rather than summarizeAssets in isolation.
      assert.equal(summarizeAssets(read.holdings, read.errors.length === 0).complete, false);
    },
  );
});

test("zero sqrtPriceX96 makes the token mark unknown instead of zero dollars", async () => {
  await withMockFetch(
    async (_input, init) => {
      const payload = JSON.parse(String(init?.body)) as RpcRequest[];
      return Response.json(rowsFor(payload, 0n));
    },
    async () => {
      const read = await readTreasuryAssets(TREASURY, ["https://zero-slot0.rpc"]);
      assert.equal(read.token_usd, null);
      assert.match(read.errors.join("\n"), /zero sqrtPriceX96/i);

      const tokenRows = read.holdings.filter((holding) => holding.address === CLAIM_SOURCES[0].token);
      assert.ok(tokenRows.length > 0);
      assert.ok(tokenRows.every((holding) => holding.price_usd === null));
      assert.ok(tokenRows.every((holding) => holding.value_cents === null));

      const summary = summarizeAssets(read.holdings, read.errors.length === 0);
      assert.equal(summary.complete, false);
      assert.equal(summary.total_cents, null);
      assert.deepEqual(summary.by_tier.map((tier) => tier.cents), [null, null, null]);
    },
  );
});

test("zero sqrtPriceX96 also stops the optional depth walk without throwing", async () => {
  let batches = 0;
  await withMockFetch(
    async (_input, init) => {
      batches++;
      const payload = JSON.parse(String(init?.body)) as RpcRequest[];
      return Response.json(rowsFor(payload, 0n));
    },
    async () => {
      const result = await readPoolDepth(CLAIM_SOURCES[0], 1n, ["https://zero-depth-slot0.rpc"]);
      assert.equal(result.depth, null);
      assert.match(result.error ?? "", /zero sqrtPriceX96/i);
      assert.equal(batches, 1, "an impossible price must stop before the tick-ladder walk");
    },
  );
});

test("a short slot0 ABI response is rejected instead of decoding as zero", async () => {
  await withMockFetch(
    async (_input, init) => {
      const payload = JSON.parse(String(init?.body)) as RpcRequest[];
      const rows = rowsFor(payload);
      const slot0 = rows.find((row, index) => payload[index].params[0].data.startsWith(SELECTORS.getSlot0));
      assert.ok(slot0);
      slot0.result = "0x0";
      return Response.json(rows);
    },
    async () => {
      await assert.rejects(
        readTreasuryAssets(TREASURY, ["https://short-slot0.rpc"]),
        /short ABI response.*word 0/i,
      );
    },
  );
});

// The regression this file exists to prevent, found in pre-deploy audit of the
// cold-zero fix rather than in production, which is the only reason it is a
// test and not an incident.
//
// Gating `complete` on the read's errors was correct for a read that failed.
// It was wrong for the OPTIONAL depth walk, whose failures sat in the same
// array: a tick ladder that did not answer would have blanked total_cents,
// conservative_total_cents, all three tiers, both locations and every chain,
// on a treasury whose every holding was priced perfectly. A withheld correct
// figure is a smaller sin than a confident wrong one, and it is still a lie
// about what this registry knows.
//
// KILLING MUTATION: route the depth error back to `errors` in src/assets.ts
// (`if (error) errors.push(error)`) and this goes red on the errors assertion
// and again on complete.
test("a failed depth walk is an advisory, and never nulls a treasury that was read", async () => {
  await withMockFetch(
    async (_input, init) => {
      const payload = JSON.parse(String(init?.body)) as RpcRequest[];
      // Everything answers normally EXCEPT the tick bitmaps, which come back
      // empty so the optional realizable block cannot be computed.
      return Response.json(
        payload.map(({ id, params }) => {
          const call = params[0];
          // Empty bitmaps: the optional realizable walk cannot be computed.
          if (call.data.startsWith(SELECTORS.getTickBitmap)) return { id, result: abi(0n) };
          // A real claim, so the depth walk is actually reached: cumulated
          // fees on the token side, nothing collected yet, full share.
          if (call.data.startsWith(SELECTORS.getCumulatedFees1)) return { id, result: abi(5_000n * 10n ** 18n) };
          if (call.data.startsWith(SELECTORS.getLastCumulatedFees1)) return { id, result: abi(0n) };
          if (call.data.startsWith(SELECTORS.getShares)) return { id, result: abi(10n ** 18n) };
          if (call.data.startsWith(SELECTORS.collectFees)) return { id, result: abi(0n, 0n) };
          // BNB pool slot0 answers with a real price so the NVDAB holding is
          // priced and cannot be the reason the totals go null.
          if (call.data.startsWith(SELECTORS.slot0V3)) return { id, result: abi(Q96, 0n, 0n, 0n, 0n, 0n, 0n) };
          return { id, result: resultFor(call) };
        }),
      );
    },
    async () => {
      // A BNB provider is supplied so the only thing wrong with this read is
      // the tick walk. Without one, the genuine "no BNB provider" error would
      // mask what this test is about.
      const read = await readTreasuryAssets(TREASURY, ["https://no-ticks.rpc"], ["https://bnb.rpc"]);

      // The walk failed and said so, in the list that does not gate the totals.
      assert.match(read.advisories.join("\n"), /realizable figure/i);
      // And not in the list that does.
      assert.deepEqual(read.errors, []);

      // Every holding is priced, so the served composition is complete and the
      // totals are real numbers rather than nulls.
      const summary = summarizeAssets(read.holdings, read.errors.length === 0);
      assert.equal(summary.complete, true);
      assert.notEqual(summary.total_cents, null);
      assert.ok(summary.by_tier.every((tier) => tier.cents !== null));
    },
  );
});

// Both lists non-empty at once. The served errors_vs_advisories sentence makes
// a claim about this state, and a claim about a state nobody has entered is a
// guess; the pre-deploy auditor reached it by probe, so it lives here now.
//
// KILLING MUTATION: make the served sentence say an advisory means every number
// below is good, and this test's total_cents assertion contradicts it.
test("errors and advisories can both be non-empty, and errors is what decides", async () => {
  await withMockFetch(
    async (_input, init) => {
      const payload = JSON.parse(String(init?.body)) as RpcRequest[];
      return Response.json(
        payload.map(({ id, params }) => {
          const call = params[0];
          // The optional walk fails...
          if (call.data.startsWith(SELECTORS.getTickBitmap)) return { id, result: abi(0n) };
          // ...and so does a price every holding depends on.
          if (call.data === SELECTORS.latestRoundData) return { id, result: "0x" };
          if (call.data.startsWith(SELECTORS.getCumulatedFees1)) return { id, result: abi(5_000n * 10n ** 18n) };
          if (call.data.startsWith(SELECTORS.getLastCumulatedFees1)) return { id, result: abi(0n) };
          if (call.data.startsWith(SELECTORS.getShares)) return { id, result: abi(10n ** 18n) };
          if (call.data.startsWith(SELECTORS.collectFees)) return { id, result: abi(0n, 0n) };
          if (call.data.startsWith(SELECTORS.slot0V3)) return { id, result: abi(Q96, 0n, 0n, 0n, 0n, 0n, 0n) };
          return { id, result: resultFor(call) };
        }),
      );
    },
    async () => {
      const read = await readTreasuryAssets(TREASURY, ["https://both.rpc"], ["https://bnb.rpc"]);
      assert.ok(read.errors.length > 0, "the unread price belongs in errors");
      assert.ok(read.advisories.length > 0, "the uncomputed extra belongs in advisories");

      // errors decides. An advisory alongside it does not make the totals good.
      const summary = summarizeAssets(read.holdings, read.errors.length === 0);
      assert.equal(summary.complete, false);
      assert.equal(summary.total_cents, null);
    },
  );
});

// The invariant behind all of the above, stated once as a rule rather than as
// another instance: if the totals are null, some served list says why. An
// incomplete read with both lists empty is a page that went blank without a
// reason, on a page whose contract is that read failures are named.
//
// KILLING MUTATION: remove the `if (tokenWalletRaw === null) errors.push(...)`
// line in src/assets.ts and this goes red, because that row was the last one in
// the Base batch with no error of its own.
test("an incomplete read always names a cause: null totals with both lists empty is impossible", async () => {
  await withMockFetch(
    async (_input, init) => {
      const payload = JSON.parse(String(init?.body)) as RpcRequest[];
      return Response.json(
        payload.map(({ id, params }) => {
          const call = params[0];
          // The 1F916 wallet balance alone goes unanswered. Everything else,
          // including the tick walk, answers normally.
          if (call.data.startsWith(SELECTORS.balanceOf) && call.to.toLowerCase() === CLAIM_SOURCES[0].token.toLowerCase()) {
            return { id, result: null, error: { code: -32000, message: "no answer" } };
          }
          if (call.data.startsWith(SELECTORS.getCumulatedFees1)) return { id, result: abi(5_000n * 10n ** 18n) };
          if (call.data.startsWith(SELECTORS.getLastCumulatedFees1)) return { id, result: abi(0n) };
          if (call.data.startsWith(SELECTORS.getShares)) return { id, result: abi(10n ** 18n) };
          if (call.data.startsWith(SELECTORS.collectFees)) return { id, result: abi(0n, 0n) };
          if (call.data.startsWith(SELECTORS.slot0V3)) return { id, result: abi(Q96, 0n, 0n, 0n, 0n, 0n, 0n) };
          return { id, result: resultFor(call) };
        }),
      );
    },
    async () => {
      const read = await readTreasuryAssets(TREASURY, ["https://no-token-balance.rpc"], ["https://bnb.rpc"]);
      const summary = summarizeAssets(read.holdings, read.errors.length === 0);

      // The read is genuinely incomplete: a holding could not be priced.
      assert.equal(summary.complete, false);
      assert.equal(summary.total_cents, null);

      // And it says so. This is the assertion that matters.
      assert.ok(
        read.errors.length > 0,
        "totals went null with errors [] and advisories [] — a blank page with no stated cause",
      );
      assert.match(read.errors.join("\n"), /balanceOf did not answer/i);
    },
  );
});
