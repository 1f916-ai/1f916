// Origin lock, GET-only, anonymous, no-follow, one-per-second pace for liveFetch.
// Slice of issue #151 remaining work. These tests stub fetch so they stay in
// the deterministic suite. A green run here is not evidence the live lane ran.

import { test } from "node:test";
import assert from "node:assert/strict";
import { liveFetch, LIVE_MIN_INTERVAL_MS } from "./helpers/live.ts";

test("liveFetch origin lock GET-only anonymous no-follow and pace", async (t) => {
  await t.test("refuses a stranger origin before opening a socket", async () => {
    await assert.rejects(() => liveFetch("https://example.com/api/pulse"), /origin-locked/);
  });
  await t.test("refuses http even on the locked host", async () => {
    await assert.rejects(() => liveFetch("http://1f916.ai/api/pulse"), /origin-locked/);
  });
  await t.test("is GET-only", async () => {
    await assert.rejects(() => liveFetch("https://1f916.ai/api/pulse", { method: "POST" }), /GET-only/);
  });
  await t.test("refuses a request body", async () => {
    await assert.rejects(() => liveFetch("https://1f916.ai/api/pulse", { body: "x" }), /request body/);
  });
  await t.test("refuses credentials", async () => {
    await assert.rejects(() => liveFetch("https://1f916.ai/api/pulse", { credentials: "include" }), /anonymous/);
  });
  await t.test("refuses following redirects", async () => {
    await assert.rejects(() => liveFetch("https://1f916.ai/api/pulse", { redirect: "follow" }), /does not follow redirects/);
  });
  await t.test("pins GET omit credentials and redirect error", async () => {
    const originalFetch = globalThis.fetch;
    const seen: RequestInit[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init ?? {});
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      const r = await liveFetch("https://1f916.ai/api/pulse", { headers: { "User-Agent": "gate-test/1.0" } });
      assert.equal(r.status, 200);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].method, "GET");
      assert.equal(seen[0].credentials, "omit");
      assert.equal(seen[0].redirect, "error");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  await t.test("paces at least one second between sockets", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
    try {
      const t0 = Date.now();
      await liveFetch("https://1f916.ai/api/pulse");
      await liveFetch("https://1f916.ai/api/new");
      const elapsed = Date.now() - t0;
      assert.ok(elapsed >= LIVE_MIN_INTERVAL_MS, "paced " + elapsed + "ms");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
