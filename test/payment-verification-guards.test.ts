// verifyBasePayment: the per-provider refusals that no test killed.
//
// The existing RPC test (test/payouts.test.ts) covers the shapes that
// matter most often: a reverted transaction, a missing one, a payment before
// the binding or after its expiry, an unfinalized block, an unreachable
// provider. The mutation audit of 2026-09-04 deleted each of the remaining
// refusals inside the provider loop in src/payouts.ts and the suite stayed
// green. Every one of them is a way a single misbehaving provider could put a
// receipt on the record; each test below names its killing mutation.
//
// The provider is scripted through a replaced globalThis.fetch (restored
// after every scenario). Every provider in the pool answers the same script,
// so the two-source rule is satisfied and the refusal under test is the only
// thing between the scenario and a recorded payment.

import test from "node:test";
import assert from "node:assert/strict";
import { BASE_USDC, verifyBasePayment } from "../src/payouts.ts";
import { SocietyError, type Env } from "../src/society.ts";

const payee = "0x1111111111111111111111111111111111111111";
const funder = "0x2222222222222222222222222222222222222222";
const txHash = "0x" + "ab".repeat(32);
const blockHash = "0x" + "cd".repeat(32);
const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const topicAddress = (a: string) => "0x" + "0".repeat(24) + a.slice(2).toLowerCase();
const word = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");
const hex = (n: bigint | number) => "0x" + BigInt(n).toString(16);
const HUGE = (1n << 60n); // past Number.MAX_SAFE_INTEGER (2^53 - 1)

const binding = {
  chain_id: 8453,
  token: BASE_USDC,
  payout_address: payee,
  amount_atomic: "10000000",
  created_at: 1_000_000,
  expiry: 2_000,
} as never;

const goodReceipt = () => ({
  status: "0x1", transactionHash: txHash, blockNumber: "0x64", blockHash, from: funder,
  logs: [{ address: BASE_USDC, topics: [transferTopic, topicAddress(funder), topicAddress(payee)], data: word(10_000_000n), logIndex: "0x1" }],
});

type Scenario = {
  receipt?: Record<string, unknown>;
  chainId?: string;
  latest?: string;
  finalized?: { hash: string; number: string; timestamp: string } | null;
  canonical?: { hash: string; number: string; timestamp: string };
  bindingOverride?: Record<string, unknown>;
};

async function run(s: Scenario) {
  const refuser = globalThis.fetch;
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    const result = request.method === "eth_getTransactionReceipt" ? (s.receipt ?? goodReceipt())
      : request.method === "eth_chainId" ? (s.chainId ?? "0x2105")
      : request.method === "eth_blockNumber" ? (s.latest ?? "0x70")
      : request.params[0] === "finalized" ? (s.finalized === undefined ? { hash: blockHash, number: "0x64", timestamp: "0x5dc" } : s.finalized)
      : (s.canonical ?? { hash: blockHash, number: "0x64", timestamp: hex(1_500) });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
  }) as typeof fetch;
  try {
    return await verifyBasePayment({} as Env, { ...(binding as object), ...(s.bindingOverride ?? {}) } as never, txHash, null, 1234);
  } finally {
    globalThis.fetch = refuser;
  }
}

const refusedWith = (status: number, pattern: RegExp) => (e: unknown) =>
  e instanceof SocietyError && e.status === status && pattern.test(e.message);

test("the scenario runner's happy path records, so each refusal below is the one line it bends", async () => {
  const ok = await run({});
  assert.equal(ok.blockNumber, 100);
  assert.equal(ok.finalizedBlockNumber, 100);
  assert.equal(ok.blockTimestamp, 1_500);
});

test("a binding on another chain, or in an unlisted asset, is refused before any provider is asked", async () => {
  // KILLING MUTATION: src/payouts.ts verifyBasePayment, `throw new
  // SocietyError(400, `${assetProblem} The signed binding remains public
  // ...`)` -> `void ...`. The loop then runs and, with providers scripted
  // to answer, would record a receipt for an asset the rail does not price.
  await assert.rejects(run({ bindingOverride: { chain_id: 1 } }), refusedWith(400, /settles on Base .* only.*The signed binding remains public/s));
  await assert.rejects(run({ bindingOverride: { token: "0x" + "9".repeat(40) } }), refusedWith(400, /is not an asset this rail prices work in/));
});

test("a receipt naming a different transaction hash than the one asked for is refused", async () => {
  // KILLING MUTATION: `if (receipt.transactionHash?.toLowerCase() !== txHash)
  // throw ...` -> `void ...`. A provider answering with somebody else's
  // receipt (the right shape, the wrong transaction) would then be matched
  // on its logs and recorded under the hash the payee supplied.
  await assert.rejects(run({ receipt: { ...goodReceipt(), transactionHash: "0x" + "ef".repeat(32) } }), refusedWith(400, /names a different transaction hash/));
});

test("a receipt without a valid sender address is refused before the transfer is matched", async () => {
  // KILLING MUTATION: src/payouts.ts matchTransfer, `if (typeof receipt.from
  // !== "string" || !ADDRESS_RE.test(receipt.from)) throw ...` -> `void
  // ...`. transaction_sender is a hashed receipt field; a receipt would then
  // be sealed with a sender that is not an address.
  await assert.rejects(run({ receipt: { ...goodReceipt(), from: "nobody" } }), refusedWith(400, /transaction receipt has no valid sender/));
  await assert.rejects(run({ receipt: { ...goodReceipt(), from: undefined } }), refusedWith(400, /transaction receipt has no valid sender/));
});

test("an on-chain integer that is not hex is refused by name, not by a parser's stack trace", async () => {
  // KILLING MUTATION: src/payouts.ts parseHexInteger, `throw new
  // SocietyError(400, `on-chain ${name} is malformed`)` -> `void ...`. The
  // BigInt() that follows then throws a SyntaxError, which the provider loop
  // swallows as a transport failure: the payee is told the providers
  // disagreed when one of them answered nonsense.
  await assert.rejects(run({ receipt: { ...goodReceipt(), blockNumber: "one hundred" } }), refusedWith(400, /on-chain blockNumber is malformed/));
  await assert.rejects(run({ latest: "0xzz" }), refusedWith(400, /on-chain latest block number is malformed/));
});

test("a receipt block number past the safe-integer range is refused rather than rounded", async () => {
  // KILLING MUTATION: `if (blockNumberBig > BigInt(Number.MAX_SAFE_INTEGER))
  // throw ...` -> `void ...`. Number(blockNumberBig) then rounds, and the
  // canonical-height lookup that follows is for a block that is not the
  // receipt's.
  await assert.rejects(run({ receipt: { ...goodReceipt(), blockNumber: hex(HUGE) } }), refusedWith(400, /receipt block number exceeds the safe integer range/));
});

test("a receipt without a valid block hash is refused before the canonical check needs one", async () => {
  // KILLING MUTATION: `if (typeof receipt.blockHash !== "string" ||
  // !HASH_RE.test(receipt.blockHash)) throw ...` -> `void ...`. The
  // canonical comparison then fails on .toLowerCase() of a non-string or
  // reports "not canonical", which blames the chain for a malformed answer.
  await assert.rejects(run({ receipt: { ...goodReceipt(), blockHash: "0x1234" } }), refusedWith(400, /transaction receipt has no valid block hash/));
  await assert.rejects(run({ receipt: { ...goodReceipt(), blockHash: undefined } }), refusedWith(400, /transaction receipt has no valid block hash/));
});

test("a provider that is not on Base is refused, whatever its receipt says", async () => {
  // KILLING MUTATION: `if (parseHexInteger("chain id", chainIdRaw) !==
  // BigInt(BASE_CHAIN_ID)) throw ...` -> `void ...`. Every provider in the
  // pool scripted to say chain 1 would then agree with each other and a
  // receipt from another chain would be recorded as a Base payment.
  await assert.rejects(run({ chainId: "0x1" }), refusedWith(400, /the configured RPC is not Base/));
});

test("a provider whose latest head is behind the receipt block is refused, not counted as unconfirmed", async () => {
  // KILLING MUTATION: `if (latestBig < blockNumberBig) throw ...` -> `void
  // ...`. The confirmation arithmetic then goes negative and the provider
  // votes "pending", which reads to the payee as "wait", when the true
  // reading is that this provider cannot have seen the block it claims to.
  await assert.rejects(run({ latest: "0x10" }), refusedWith(400, /latest head is behind the receipt block/));
});

test("a finalized head past the safe-integer range is refused rather than rounded", async () => {
  // KILLING MUTATION: `if (finalizedBig > BigInt(Number.MAX_SAFE_INTEGER))
  // throw ...` -> `void ...`. The receipt would then record a
  // finalized_block_number that is not the number the provider gave.
  await assert.rejects(run({ finalized: { hash: blockHash, number: hex(HUGE), timestamp: "0x5dc" } }), refusedWith(400, /finalized Base block number exceeds the safe integer range/));
});

test("a block timestamp past the safe-integer range is refused, and not read as 'after expiry'", async () => {
  // KILLING MUTATION: `if (timestampBig > BigInt(Number.MAX_SAFE_INTEGER))
  // throw ...` -> `void ...`. The rounded timestamp then compares as after
  // the binding's expiry and the refusal says the payment was late, which
  // is a claim about the payee's timing that the data does not support.
  await assert.rejects(run({ canonical: { hash: blockHash, number: "0x64", timestamp: hex(HUGE) } }), refusedWith(400, /payment block timestamp exceeds the safe integer range/));
});

// NOT TESTED, ON PURPOSE, two lines in the same loop:
//
//   `if (!finalized) throw new Error("RPC returned no finalized Base head")`
//   With the throw removed the next line reads .number off null and throws a
//   TypeError, which the same catch swallows the same way (no vote). The
//   mutant is behaviourally identical, so no test can tell them apart; the
//   line exists to name the condition, not to change the outcome.
//
//   `if (!agreed) throw new SocietyError(503, "Base RPC agreement failed")`
//   The winning key is always either "pending", an error key, or an "ok:"
//   key that was put into `candidates` in the same statement that counted
//   it, so `agreed` cannot be undefined. Defence in depth against a future
//   edit that separates the two maps.
