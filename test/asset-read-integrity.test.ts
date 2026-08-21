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
      assert.equal(summarizeAssets(read.holdings).complete, true);
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

      const summary = summarizeAssets(read.holdings);
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
