// escrowReader: the two-source agreement rule behind every FUNDED display.
//
// The reader in src/payouts.ts asks up to six Base RPC providers the same
// eth_call and answers only when two of them, each first confirmed to be on
// Base, say the same bytes. The mutation audit of 2026-09-04 bent both halves
// of that rule and the suite stayed green:
//
//   1. a provider whose eth_chainId call FAILED was treated as on Base;
//   2. with no agreeing pair, the reader returned the first answer it had
//      instead of null.
//
// Either one lets a single provider decide what the registry says about
// somebody's money. Providers are scripted here by URL through a replaced
// globalThis.fetch (restored after each test); no socket is opened.

import test from "node:test";
import assert from "node:assert/strict";
import { escrowReader, baseRpcUrls, readBalanceTwoSource, ESCROW_PROVIDER_ATTEMPTS } from "../src/payouts.ts";
import { SocietyError, type Env } from "../src/society.ts";

const FIRST = "https://first-provider.test";
const BEEF = "0x" + "beef".repeat(16);
const DEAD = "0x" + "dead".repeat(16);
const BASE_HEX = "0x2105"; // 8453

type Script = {
  chainId?: string | "unavailable";
  call?: string | "unavailable";
  // Two ways a provider can answer wrongly while still carrying a result:
  // an HTTP error status around a well-formed JSON-RPC body, or a 200 whose
  // body carries a JSON-RPC error beside a result. Both must read as "no
  // answer".
  httpStatus?: number;
  rpcError?: unknown;
};

// Each URL answers eth_chainId and eth_call from its script; "unavailable" is
// an HTTP 500, which rpc() turns into a thrown error, which the reader treats
// as no answer. Every call is logged so a test can assert which providers were
// consulted for the eth_call at all.
function providers(script: Record<string, Script>) {
  const calls: { url: string; method: string }[] = [];
  const refuser = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const { method } = JSON.parse(String(init?.body)) as { method: string };
    calls.push({ url, method });
    const s = script[url] ?? { chainId: "unavailable", call: "unavailable" };
    const answer = method === "eth_chainId" ? s.chainId : method === "eth_call" ? s.call : method === "eth_blockNumber" ? "0x64" : undefined;
    if (answer === undefined || answer === "unavailable") return new Response("upstream down", { status: 500 });
    const body: Record<string, unknown> = { jsonrpc: "2.0", id: 1, result: answer };
    if (s.rpcError !== undefined) body.error = s.rpcError;
    return new Response(JSON.stringify(body), { status: s.httpStatus ?? 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return {
    calls,
    consultedFor: (method: string) => calls.filter((c) => c.method === method).map((c) => c.url),
    restore: () => { globalThis.fetch = refuser; },
  };
}

const env = { BASE_RPC_URL: FIRST } as unknown as Env;
const pool = baseRpcUrls(env).slice(0, ESCROW_PROVIDER_ATTEMPTS);

test("the pool under test is the real one: the override first, then the public list, six attempts", () => {
  assert.equal(pool[0], FIRST);
  assert.equal(pool.length, ESCROW_PROVIDER_ATTEMPTS);
  assert.ok(pool.length >= 4, "the tests below need at least four providers to script");
});

test("a provider whose eth_chainId fails is not on Base, and its eth_call answer never counts", async () => {
  // KILLING MUTATION: src/payouts.ts escrowReader, in isBase's catch,
  // `onBase.set(rpcUrl, false); return false;` -> `true` / `return true`.
  // The two providers below that cannot even say which chain they are on
  // then agree with each other on DEAD, and the reader reports it.
  const [a, b, c, d] = pool;
  const p = providers({
    [a]: { chainId: "unavailable", call: DEAD },
    [b]: { chainId: "unavailable", call: DEAD },
    [c]: { chainId: BASE_HEX, call: BEEF },
    [d]: { chainId: BASE_HEX, call: BEEF },
  });
  try {
    const got = await escrowReader(env).call("0x" + "e".repeat(40), "0x12345678");
    assert.equal(got, BEEF, "only the two providers confirmed on Base decide");
    const asked = p.consultedFor("eth_call");
    assert.ok(!asked.includes(a) && !asked.includes(b), `a provider that failed eth_chainId must not be asked eth_call at all; asked: ${asked.join(", ")}`);
  } finally { p.restore(); }
});

test("a provider on another chain is skipped the same way, even when it answers confidently", async () => {
  // Same guard, the other branch: eth_chainId ANSWERS, with a chain that is
  // not 8453. KILLING MUTATION: `parseHexInteger("chain id", raw) ===
  // BigInt(BASE_CHAIN_ID)` -> `true`.
  const [a, b, c, d] = pool;
  const p = providers({
    [a]: { chainId: "0x1", call: DEAD },
    [b]: { chainId: "0x1", call: DEAD },
    [c]: { chainId: BASE_HEX, call: BEEF },
    [d]: { chainId: BASE_HEX, call: BEEF },
  });
  try {
    assert.equal(await escrowReader(env).call("0x" + "e".repeat(40), "0x12345678"), BEEF);
    assert.ok(!p.consultedFor("eth_call").includes(a));
  } finally { p.restore(); }
});

test("one answering provider is not agreement: the reader returns null rather than the only answer it has", async () => {
  // KILLING MUTATION: src/payouts.ts escrowReader, the final `return null;`
  // after the provider loop -> `return [...seen.keys()][0] ?? null;`. A
  // single provider would then decide whether a listing displays FUNDED.
  const [a, ...rest] = pool;
  const script: Record<string, Script> = { [a]: { chainId: BASE_HEX, call: BEEF } };
  for (const url of rest) script[url] = { chainId: BASE_HEX, call: "unavailable" };
  const p = providers(script);
  try {
    assert.equal(await escrowReader(env).call("0x" + "e".repeat(40), "0x12345678"), null);
    assert.equal(p.consultedFor("eth_call").length, pool.length, "every provider in the pool was tried before giving up");
  } finally { p.restore(); }
});

test("two providers that disagree, with nobody to break the tie, is null and never the first voice", async () => {
  // Same `return null` guard, exercised on the disagreement shape: the
  // mutation above would return BEEF here because it was seen first.
  const [a, b, ...rest] = pool;
  const script: Record<string, Script> = { [a]: { chainId: BASE_HEX, call: BEEF }, [b]: { chainId: BASE_HEX, call: DEAD } };
  for (const url of rest) script[url] = { chainId: BASE_HEX, call: "unavailable" };
  const p = providers(script);
  try {
    assert.equal(await escrowReader(env).call("0x" + "e".repeat(40), "0x12345678"), null);
  } finally { p.restore(); }
});

test("an HTTP error status is no answer, even when the body carries a well-formed result", async () => {
  // KILLING MUTATION: src/payouts.ts rpc(), `if (!response.ok) throw new
  // Error("rpc unavailable")` -> `void ...`. A provider's 5xx error page
  // that happens to be JSON-RPC shaped (a proxy replaying a cached body, a
  // rate limiter echoing the request) would then vote.
  const [a, b, c, d] = pool;
  const p = providers({
    [a]: { chainId: BASE_HEX, call: DEAD, httpStatus: 503 },
    [b]: { chainId: BASE_HEX, call: DEAD, httpStatus: 503 },
    [c]: { chainId: BASE_HEX, call: BEEF },
    [d]: { chainId: BASE_HEX, call: BEEF },
  });
  try {
    assert.equal(await escrowReader(env).call("0x" + "e".repeat(40), "0x12345678"), BEEF);
  } finally { p.restore(); }
});

test("a JSON-RPC error beside a result is an error: the result does not count", async () => {
  // KILLING MUTATION: src/payouts.ts rpc(), `if (body.error !== undefined)
  // throw new Error("rpc error")` -> `void ...`. The function would then
  // return body.result from a response the provider itself marked failed.
  const [a, b, c, d] = pool;
  const p = providers({
    [a]: { chainId: BASE_HEX, call: DEAD, rpcError: { code: -32000, message: "execution reverted" } },
    [b]: { chainId: BASE_HEX, call: DEAD, rpcError: { code: -32000, message: "execution reverted" } },
    [c]: { chainId: BASE_HEX, call: BEEF },
    [d]: { chainId: BASE_HEX, call: BEEF },
  });
  try {
    assert.equal(await escrowReader(env).call("0x" + "e".repeat(40), "0x12345678"), BEEF);
  } finally { p.restore(); }
});

test("a funder's balance is refused as unknown when no two providers agree on it", async () => {
  // readBalanceTwoSource is the proof-of-funds reader behind a listing that
  // names its paying wallet. KILLING MUTATION: src/payouts.ts
  // readBalanceTwoSource, `throw new SocietyError(503, "Base RPC providers
  // did not agree on the funder wallet's USDC balance ...")` -> `void ...`.
  // With no winner the next line indexes undefined and the caller gets a
  // TypeError instead of the 503 that tells the funder to try again.
  const [a, b, c] = pool;
  const balance = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");
  const p = providers({
    [a]: { chainId: BASE_HEX, call: balance(1_000_000n) },
    [b]: { chainId: BASE_HEX, call: balance(2_000_000n) },
    [c]: { chainId: BASE_HEX, call: balance(3_000_000n) },
  });
  try {
    await assert.rejects(
      readBalanceTwoSource(env, "0x" + "f".repeat(40), "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"),
      (e: unknown) => e instanceof SocietyError && e.status === 503 && /did not agree on the funder wallet's USDC balance/.test(e.message),
    );
  } finally { p.restore(); }
  // And a single voice is not agreement here either.
  const lone = providers({ [a]: { chainId: BASE_HEX, call: balance(1_000_000n) } });
  try {
    await assert.rejects(readBalanceTwoSource(env, "0x" + "f".repeat(40), "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"), (e: unknown) => e instanceof SocietyError && e.status === 503);
  } finally { lone.restore(); }
  // Control: two agreeing providers answer, with the count of sources.
  const agreed = providers({ [a]: { chainId: BASE_HEX, call: balance(1_000_000n) }, [b]: { chainId: BASE_HEX, call: balance(1_000_000n) } });
  try {
    const got = await readBalanceTwoSource(env, "0x" + "f".repeat(40), "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
    assert.equal(got.balanceAtomic, "1000000");
    assert.equal(got.sources, 2);
  } finally { agreed.restore(); }
});

test("once a pair has agreed, the pair is reused, and a later disagreement between them is null not a coin toss", async () => {
  // The pair is remembered so a batch of reads costs two calls each. If the
  // remembered pair then disagrees, that is a real disagreement, and the
  // answer is null forever for that read. KILLING MUTATION: in the paired
  // branch, `return a === b ? a : null` -> `return a`.
  const [a, b, c] = pool;
  let round = 0;
  const refuser = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const { method } = JSON.parse(String(init?.body)) as { method: string };
    if (method === "eth_chainId") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: BASE_HEX }), { status: 200 });
    asked.push(url);
    if (url !== a && url !== b) return new Response("down", { status: 500 });
    // Round one: a and b agree. Round two: they split.
    const result = round === 0 ? BEEF : url === a ? BEEF : DEAD;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
  }) as typeof fetch;
  try {
    const reader = escrowReader(env);
    assert.equal(await reader.call("0x" + "e".repeat(40), "0xaaaaaaaa"), BEEF);
    round = 1;
    assert.equal(await reader.call("0x" + "e".repeat(40), "0xbbbbbbbb"), null);
    assert.ok(!asked.includes(c) || asked.indexOf(c) < asked.lastIndexOf(a), "the second read went to the remembered pair first");
  } finally { globalThis.fetch = refuser; }
});
