// /treasury is anonymous, but one response used to cost an eleven-call Base
// batch (and up to four provider attempts) even when an identical response had
// just finished. A burst therefore turned free GETs into third-party RPC work.
// This test holds the first batch open so the second request has to join it,
// then walks the clock through the cache window without sleeping for 30 seconds.
// It also pins config isolation and the difference between a resolved degraded
// result (cache it) and an unexpected rejection (clear it so recovery can retry).

import test from "node:test";
import assert from "node:assert/strict";
import { SELECTORS } from "../src/assets.ts";
import { treasury, type Env } from "../src/society.ts";

const TREASURY = "0x0000000000000000000000000000000000000037";
const word = (value: bigint) => value.toString(16).padStart(64, "0");

function stubEnv(
  treasuryAddress = TREASURY,
  rpcUrl = "https://rpc.test",
): Env {
  const db = {
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
  };
  return { DB: db, TREASURY_ADDRESS: treasuryAddress, BASE_RPC_URL: rpcUrl } as unknown as Env;
}

type AssetRpcRequest = { id: number; params?: [{ data: string }, "latest"] };

function assetBatchResponse(payload: AssetRpcRequest[], now: number): Response {
  const zero = "0x" + word(0n);
  // A positive Chainlink answer and a 1:1 pool sqrt price keep the fixture
  // complete while every balance/claim remains zero (and avoids the depth walk).
  const roundData =
    "0x" + [0n, 2_000n * 100_000_000n, 0n, BigInt(Math.floor(now / 1000)), 0n].map(word).join("");
  const slot0 = "0x" + [1n << 96n, 0n, 0n, 3_000n].map(word).join("");
  const collectFees = "0x" + word(0n) + word(0n);
  return Response.json(
    payload.map(({ id, params }) => {
      const data = params?.[0].data;
      const result = data
        ? data === SELECTORS.latestRoundData
          ? roundData
          : data.startsWith(SELECTORS.getSlot0)
            ? slot0
            : data.startsWith(SELECTORS.slot0V3)
              ? // BNB Chain's NVDAB/USDT pool. sqrtPriceX96 = 2^96 is a 1:1
                // price, which keeps that holding priced and the error list
                // empty; this test is about caching, not about marks.
                "0x" + [1n << 96n, 0n, 0n, 0n, 0n, 0n, 0n].map(word).join("")
              : data.startsWith(SELECTORS.collectFees)
                ? collectFees
              : zero
        : id === 2
          ? roundData
          : id === 3
            ? slot0
            : id === 10
              ? collectFees
              : zero;
      return { id, result };
    }),
  );
}

test("treasury asset reads cache, coalesce, and disclose their age", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const startedAt = 1_700_000_000_000;
  let now = startedAt;
  let assetBatchFetches = 0;
  let degradedOutage = false;
  let brokenRpc = true;
  let releaseFirstBatch: (response: Response) => void = () => {};
  const firstBatch = new Promise<Response>((resolve) => {
    releaseFirstBatch = resolve;
  });
  let firstRequest: ReturnType<typeof treasury> | undefined;
  let joinedRequest: ReturnType<typeof treasury> | undefined;

  Date.now = () => now;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body));
    if (Array.isArray(payload)) {
      // Count only the BASE batch. Since 2026-08-21 a treasury read also makes
      // a second batched call against BNB Chain, and a counter that cannot tell
      // the two apart reports two fetches for one read and makes the coalescing
      // assertion below fail for a reason that has nothing to do with
      // coalescing. The Chainlink call is unique to the Base batch.
      const isBaseBatch = payload.some(
        (c: AssetRpcRequest) => c.params?.[0].data === SELECTORS.latestRoundData,
      );
      if (!isBaseBatch) return assetBatchResponse(payload as AssetRpcRequest[], now);
      assetBatchFetches++;
      if (assetBatchFetches === 1) return firstBatch;
      // Keep every provider unavailable for this scenario. The complete-batch
      // reader will exhaust its hole-filling passes and resolve honest nulls.
      if (degradedOutage) return Response.json([]);
      if (String(input) === "https://broken.rpc" && brokenRpc) {
        return Response.json([{ id: 0, result: "0xnot-hex" }]);
      }
      return assetBatchResponse(payload as AssetRpcRequest[], now);
    }
    // The separate onchain_cents read is not the asset batch under test.
    return Response.json({ jsonrpc: "2.0", id: 1, result: "0x" + word(0n) });
  }) as typeof fetch;

  try {
    firstRequest = treasury(stubEnv());
    for (let turn = 0; turn < 20 && assetBatchFetches === 0; turn++) await Promise.resolve();
    assert.equal(assetBatchFetches, 1, "the first request should reach the asset RPC batch");

    joinedRequest = treasury(stubEnv());
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(assetBatchFetches, 1, "an overlapping request must join the in-flight batch");

    // Model a slow provider. The public age starts at the oldest possible read,
    // while the 30s reuse TTL starts only after the completed result is cached.
    now = startedAt + 5_000;
    releaseFirstBatch(assetBatchResponse(Array.from({ length: 11 }, (_, id) => ({ id })), now));
    const [first, joined] = await Promise.all([firstRequest, joinedRequest]);
    assert.equal(assetBatchFetches, 1);
    assert.equal(first.assets.checked_at, startedAt);
    assert.equal(first.assets.cache_age_ms, 5_000);
    assert.equal(joined.assets.checked_at, startedAt);
    assert.equal(joined.assets.cache_age_ms, 5_000);

    now += 1_234;
    const cached = await treasury(stubEnv());
    assert.equal(assetBatchFetches, 1, "a request inside the 30s TTL must not issue another asset batch");
    assert.equal(cached.assets.checked_at, startedAt, "checked_at is the oldest read time, not the cache-write time");
    assert.equal(cached.assets.cache_age_ms, 6_234, "the response discloses the cached asset result's age");

    now = startedAt + 5_000 + 30_000;
    const refreshed = await treasury(stubEnv());
    assert.equal(assetBatchFetches, 2, "the first request at the TTL boundary refreshes the snapshot");
    assert.equal(refreshed.assets.checked_at, now);
    assert.equal(refreshed.assets.cache_age_ms, 0);

    // Module caches must not hand one Env's treasury result to another Env.
    // Production bindings are stable per isolate, but the function's contract
    // and preview/test deployments still deserve an address/provider key.
    now += 1;
    const otherEnv = stubEnv("0x0000000000000000000000000000000000000038", "https://rpc.other.test");
    await treasury(otherEnv);
    assert.equal(assetBatchFetches, 3, "a different address/provider pair has its own cache entry");

    // Provider failure resolves to an honest, error-bearing AssetReadResult.
    // Cache that too: otherwise an outage reopens the amplification path at its
    // most expensive moment, when every request walks the fallback list.
    const degradedEnv = stubEnv("0x0000000000000000000000000000000000000039", "https://degraded.rpc");
    const beforeDegraded = assetBatchFetches;
    degradedOutage = true;
    const degraded = await treasury(degradedEnv);
    degradedOutage = false;
    assert.ok(degraded.assets.errors.length > 0);
    const afterDegraded = assetBatchFetches;
    assert.ok(afterDegraded > beforeDegraded, "the simulated outage should exercise provider fallbacks");
    now += 250;
    const degradedHit = await treasury(degradedEnv);
    assert.equal(assetBatchFetches, afterDegraded, "a resolved degraded read is cached inside the TTL");
    assert.deepEqual(degradedHit.assets.errors, degraded.assets.errors);
    assert.equal(degradedHit.assets.cache_age_ms, 250);

    // An unexpected parser failure is different: do not cache a rejection, and
    // always clear its in-flight slot so a healthy next attempt can recover.
    const brokenEnv = stubEnv("0x0000000000000000000000000000000000000040", "https://broken.rpc");
    const beforeBroken = assetBatchFetches;
    await assert.rejects(treasury(brokenEnv), /BigInt|convert/i);
    const afterBroken = assetBatchFetches;
    assert.ok(afterBroken > beforeBroken, "the malformed provider result should reach the parser");
    brokenRpc = false;
    const recovered = await treasury(brokenEnv);
    assert.equal(assetBatchFetches, afterBroken + 1, "a rejected refresh must not poison the cache or in-flight map");
    assert.deepEqual(recovered.assets.errors, []);
  } finally {
    // Safe even when already resolved; prevents a failed assertion from leaving
    // the first treasury request suspended while globals are restored.
    releaseFirstBatch(assetBatchResponse(Array.from({ length: 11 }, (_, id) => ({ id })), now));
    await Promise.allSettled([firstRequest, joinedRequest].filter((p): p is ReturnType<typeof treasury> => p !== undefined));
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});


// A SLOW provider must not become a hung endpoint.
//
// Found live on 2026-08-14: GET /treasury failed 3 of 6 anonymous requests and
// the live check "an ordinary read of the books still works" timed out after
// 300 SECONDS. Every hop was bounded and the walk was not — batchCall aborts
// each RPC at 3s but tries four, batchCallComplete loops it, and the
// pool-depth read chains three of those rounds.
//
// The stub below honours AbortController the way a real fetch does, so each
// hop still times out on schedule and only the COMPOSITION is under test. An
// earlier version of this test ignored the signal, which hung the on-chain
// read too and proved nothing about the fix.
test("a slow provider cannot hang the books", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_url: string, init?: { signal?: AbortSignal }) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      if (signal.aborted) return reject(new Error("aborted"));
      signal.addEventListener("abort", () => reject(new Error("aborted")));
    })) as unknown as typeof fetch;
  try {
    const env = stubEnv("0x0000000000000000000000000000000000000041", "https://slow.rpc");
    const started = Date.now();
    const body = await treasury(env);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 20_000, `the books answered in ${elapsed}ms; the refresh budget must bound this`);
    assert.ok(
      body.assets.errors.length > 0,
      `a refresh that could not complete must say so; got ${JSON.stringify(body.assets.errors)}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
