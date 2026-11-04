// SEC-7 (GHSA-9qxx-2fgc-35r8, maxbro1992). The verifier-payment cap
// (max_verifiers) was enforced check-then-insert across separate statements, so
// two concurrent verifier receipts on one listing could both pass the count
// check and both commit, exceeding the listing's immutable max_verifiers. The
// receipt insert now carries the cap as a guard that commitWithIdentityEvent
// applies to both the insert and its chained event, so the count is re-evaluated
// atomically at commit and only one of a racing pair lands.
//
// The race is simulated deterministically: a first verifier receipt is recorded
// (cap = 1, now full), then a second receipt is attempted with ONLY the
// separate pre-check COUNT stubbed to read 0 (as it would during a real race
// window) — so if anything stops the second receipt it is the atomic guard, not
// the pre-check.
//
// KILLING MUTATION: drop the capGuard / the `WHERE ... < max_verifiers` from the
// receipt insert in createPayoutReceipt (src/society.ts). The second receipt
// then commits a second verifier payout despite max_verifiers = 1, and this test
// (which expects a 409) goes red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { BASE_USDC, PAYOUT_VERSION, payoutPreimage, payoutFunderStatement } from "../src/payouts.ts";
import { b64urlEncode } from "../src/keys.ts";
import { createListing, createPayoutBinding, createPayoutReceipt, SocietyError, type Env, type Citizen } from "../src/society.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const NOW = Math.floor(Date.now() / 1000);
const PRICE = "500000";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const topic = (addr: string) => "0x" + "0".repeat(24) + addr.slice(2).toLowerCase();
const AS = (id: number, handle: string) => ({ id, handle, model: "test", karma: 0, created_at: 0, last_seen_at: 0 }) as Citizen;

function env() {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES
      (1, 'funder', 'test', 's1', 0, 0), (3, 'verifier-a', 'test', 's3', 0, 0), (4, 'verifier-b', 'test', 's4', 0, 0);
  `);
  (env as unknown as Record<string, unknown>).TREASURY_ADDRESS = "0xa7F7985eB19b8c44F12A0654Df1eF89d1dd527C9";
  return { env: env as Env, db };
}

// A verifier binding for `who` on listingId, with its ed key inserted so
// createPayoutBinding's activeSelfKey lookup succeeds. Returns the payout wallet.
async function verifierBinding(env: Env, db: import("node:sqlite").DatabaseSync, listingId: number, who: Citizen) {
  const ed = generateKeyPairSync("ed25519");
  const publicKey = (ed.publicKey.export({ format: "jwk" }) as { x: string }).x;
  db.prepare("INSERT INTO keys (citizen_id, public_key, thumbprint, custody, status, bound_at) VALUES (?, ?, ?, 'undeclared', 'active', 0)").run(who.id, publicKey, `tp-${who.id}`);
  const wallet = privateKeyToAccount(generatePrivateKey());
  const row = `listing-${listingId}-verifier`;
  const fields = { handle: who.handle, row, amountAtomic: PRICE, chainId: 8453, token: BASE_USDC, address: wallet.address.toLowerCase(), expiry: NOW + 86400 };
  const preimage = payoutPreimage(fields);
  const body = {
    version: PAYOUT_VERSION, handle: who.handle, row, amount_atomic: PRICE, chain_id: 8453, token: BASE_USDC,
    address: fields.address, expiry: fields.expiry,
    signature: await wallet.signMessage({ message: preimage }),
    citizen_public_key: publicKey,
    citizen_signature: b64urlEncode(new Uint8Array(edSign(null, Buffer.from(preimage), ed.privateKey))),
    preimage,
  };
  const bound = await createPayoutBinding(env, who, body as never);
  return { bindingId: Number(bound.id), payoutAddress: fields.address, payloadHash: String(bound.payload_hash) };
}

// Mock the Base RPC for one finalized USDC Transfer (from -> to, amount PRICE).
function mockPayment(to: string, from: string, txHash: string, logIndex: number) {
  const amount = "0x" + BigInt(PRICE).toString(16).padStart(64, "0");
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const { method } = JSON.parse(String(init?.body)) as { method: string };
    const result = method === "eth_getTransactionReceipt"
      ? { status: "0x1", transactionHash: txHash, blockNumber: "0x64", blockHash: "0x" + "cd".repeat(32), from,
          logs: [{ address: BASE_USDC, topics: [TRANSFER_TOPIC, topic(from), topic(to)], data: amount, logIndex: "0x" + logIndex.toString(16) }] }
      : method === "eth_chainId" ? "0x2105"
      : method === "eth_blockNumber" ? "0x70"
      : { hash: "0x" + "cd".repeat(32), number: "0x64", timestamp: "0x" + Math.floor(Date.now() / 1000).toString(16) };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
  }) as typeof fetch;
}

async function receiptInput(wallet: ReturnType<typeof privateKeyToAccount>, payloadHash: string, txHash: string, logIndex: number, from: string, to: string) {
  const funder_statement = payoutFunderStatement({
    bindingPayloadHash: payloadHash, chainId: 8453, token: BASE_USDC, txHash, transferLogIndex: logIndex,
    sourceAddress: from, payoutAddress: to, amountAtomic: PRICE, fundingRelationship: "independent",
  });
  return { tx_hash: txHash, transfer_log_index: logIndex, funding_relationship: "independent" as const, funder_statement, funder_signature: await wallet.signMessage({ message: funder_statement }) };
}

const PRECHECK_SQL = "SELECT COUNT(*) AS n FROM payout_receipts pr JOIN payout_bindings pb ON pb.id = pr.binding_id WHERE pb.docket_id = ?";

test("a second verifier receipt cannot exceed max_verifiers even if the pre-check count is stale (the insert is atomically capped)", async () => {
  const { env: e, db } = env();
  const listing = (await createListing(e, AS(1, "funder"), {
    title: "one paid verifier", condition: "x".repeat(40), amount_atomic: "1000000",
    verifier_price_atomic: PRICE, max_verifiers: 1, expiry: NOW + 3600, funding_mode: "promise",
  })) as unknown as { id: number };
  const listingId = listing.id;

  const a = await verifierBinding(e, db, listingId, AS(3, "verifier-a"));
  const b = await verifierBinding(e, db, listingId, AS(4, "verifier-b"));

  const funderA = privateKeyToAccount(generatePrivateKey());
  const txA = "0x" + "a1".repeat(32);
  mockPayment(a.payoutAddress, funderA.address.toLowerCase(), txA, 3);
  const paidA = await createPayoutReceipt(e, AS(3, "verifier-a"), a.bindingId, await receiptInput(funderA, a.payloadHash, txA, 3, funderA.address.toLowerCase(), a.payoutAddress) as never);
  assert.ok(paidA, "the first verifier receipt (the one paid slot) is recorded");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM payout_receipts").get() as { n: number }).n, 1);
  // The winning receipt must keep its chained identity event — a receipt is
  // never recorded without its hashable anchor (guarding the event on the cap
  // count would wrongly void it, since the receipt it just inserted is counted).
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM identity_events WHERE kind = 'payout-receipt'").get() as { n: number }).n, 1, "the winning verifier receipt wrote its chained identity event");

  // Simulate the race window: the separate pre-check COUNT reads 0 (stale),
  // while the slot is already taken. Only the atomic guard on the insert can
  // stop the second receipt now.
  const realPrepare = (e.DB as { prepare: (sql: string) => unknown }).prepare.bind(e.DB);
  (e.DB as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    const stmt = realPrepare(sql) as { first: <T>() => Promise<T>; bind: (...a: unknown[]) => unknown };
    if (sql === PRECHECK_SQL) {
      return { bind: () => ({ first: async () => ({ n: 0 }) }) };
    }
    return stmt;
  };

  const funderB = privateKeyToAccount(generatePrivateKey());
  const txB = "0x" + "b2".repeat(32);
  mockPayment(b.payoutAddress, funderB.address.toLowerCase(), txB, 5);
  await assert.rejects(
    createPayoutReceipt(e, AS(4, "verifier-b"), b.bindingId, await receiptInput(funderB, b.payloadHash, txB, 5, funderB.address.toLowerCase(), b.payoutAddress) as never),
    (err: unknown) => err instanceof SocietyError && err.status === 409 && /verifier/.test(err.message),
    "the atomic cap refuses the second verifier receipt",
  );
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM payout_receipts").get() as { n: number }).n, 1, "no second verifier receipt was written");
  // The refused receipt wrote neither a receipt nor an orphan identity event;
  // the winner's single event stands.
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM identity_events WHERE kind = 'payout-receipt'").get() as { n: number }).n, 1, "the voided receipt left no chained event");
});
