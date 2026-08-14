// The acceptance criterion on docket row treasury-cold-stall, run rather than
// asserted about.
//
//   "Under a simulated all-providers-stall, GET /treasury answers within a
//    stated total budget (single-digit seconds) carrying the last good figures
//    with their true read timestamps, and a test fails if the endpoint either
//    blocks past the budget or serves a stale value whose checked_at claims
//    freshness."
//
// The condition cannot be produced against live Base and must not be attempted
// against it, so every provider is replaced with one that never answers. Each
// test imports a fresh copy of the module, because the cache, the last-good
// value and the in-flight slot are module state and a test that inherited them
// would be measuring the previous test.

import test from "node:test";
import assert from "node:assert/strict";

const env = { TREASURY_ADDRESS: "0xa7F7985eB19b8c44F12A0654Df1eF89d1dd527C9" } as never;

let counter = 0;
async function freshModule() {
  // A distinct specifier per import defeats the module cache.
  return await import(`../src/society.ts?stall=${counter++}`);
}

// Never resolves on its own; only the caller's AbortSignal ends it. This is
// the shape of a rate-limited provider holding the connection open, which is
// what the row says produces the stall.
function hangingFetch(): typeof globalThis.fetch {
  return ((_url: string, init?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as unknown as typeof globalThis.fetch;
}

function okFetch(hexBalance: string): typeof globalThis.fetch {
  return (async () => ({ ok: true, json: async () => ({ result: hexBalance }) })) as unknown as typeof globalThis.fetch;
}

test("all four providers hanging still answers inside the budget", async () => {
  const { readOnchainUsdcCents } = await freshModule();
  const original = globalThis.fetch;
  globalThis.fetch = hangingFetch();
  try {
    const started = Date.now();
    const result = await readOnchainUsdcCents(env);
    const elapsed = Date.now() - started;
    // Four providers at 1.5s each is the pre-fix behaviour, and the asset read
    // stacks on top of that in the real handler. The budget is 4s; allow a
    // second of scheduling slack and still fail well under the old 6s.
    assert.ok(elapsed < 5000, `walk took ${elapsed}ms, past its budget`);
    // Nothing was ever read successfully, so there is no last-good value and
    // the honest answer is null rather than an invented zero.
    assert.equal(result.cents, null);
    assert.equal(result.at, null);
    assert.equal(result.stale, false, "null is not stale; it is unknown, and the two must not be conflated");
  } finally {
    globalThis.fetch = original;
  }
});

test("after one good read, a total stall serves the last good value and says it is stale", async () => {
  const { readOnchainUsdcCents } = await freshModule();
  const original = globalThis.fetch;
  try {
    // 0x33450 = 210,000 raw units; USDC has 6 decimals and cents = raw / 1e4.
    globalThis.fetch = okFetch("0x33450");
    const good = await readOnchainUsdcCents(env);
    assert.equal(good.cents, 21);
    assert.equal(good.stale, false);
    const readAt = good.at as number;

    // Expire the 30s TTL without waiting for it.
    const realNow = Date.now;
    Date.now = () => realNow() + 31_000;
    globalThis.fetch = hangingFetch();
    try {
      const started = realNow();
      const stale = await readOnchainUsdcCents(env);
      assert.ok(realNow() - started < 5000, "a stalled refresh must not block past the budget");
      assert.equal(stale.cents, 21, "the last good number survives a failed refresh");
      assert.equal(stale.stale, true);
      // The heart of the acceptance: the timestamp must be the moment the value
      // was really read, never the moment it was served.
      assert.equal(stale.at, readAt, "checked_at must not be refreshed by a refresh that failed");
    } finally {
      Date.now = realNow;
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("concurrent callers on a cold cache produce one provider walk, not one each", async () => {
  const { readOnchainUsdcCents } = await freshModule();
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return { ok: true, json: async () => ({ result: "0x33450" }) };
  }) as unknown as typeof globalThis.fetch;
  try {
    const results = await Promise.all(Array.from({ length: 8 }, () => readOnchainUsdcCents(env)));
    assert.equal(calls, 1, `8 concurrent callers made ${calls} upstream calls; the cache exists to prevent exactly this`);
    for (const r of results) assert.equal(r.cents, 21);
  } finally {
    globalThis.fetch = original;
  }
});

test("a recovered provider replaces the stale value and clears the flag", async () => {
  // The failure mode a last-good cache invites is serving the old number
  // forever. Recovery must be observable.
  const { readOnchainUsdcCents } = await freshModule();
  const original = globalThis.fetch;
  const realNow = Date.now;
  try {
    globalThis.fetch = okFetch("0x33450");
    await readOnchainUsdcCents(env);

    Date.now = () => realNow() + 31_000;
    globalThis.fetch = hangingFetch();
    assert.equal((await readOnchainUsdcCents(env)).stale, true);

    Date.now = () => realNow() + 62_000;
    globalThis.fetch = okFetch("0x668a0"); // 420,000 raw -> 42 cents
    const recovered = await readOnchainUsdcCents(env);
    assert.equal(recovered.stale, false, "the flag clears when a read succeeds again");
    assert.equal(recovered.cents, 42, "and the new value is served, not the remembered one");
  } finally {
    Date.now = realNow;
    globalThis.fetch = original;
  }
});
