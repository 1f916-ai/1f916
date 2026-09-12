// The chain observer (migration 0049): paid is observed, not filed.
//
// Guarantees and the mutation that kills each:
// 1. Nothing is written unless two providers return identical logs for the
//    identical range. Mutation: in observeFunderWallets set `agreed = [answer, answer]`
//    on the first answer (single-source write) -> the disagreement test goes red.
// 2. A real transfer to a bound address is a 'payment' naming the binding
//    whose amount and asset match; a zero-value transfer is 'zero_value'; a
//    transfer to a stranger is 'other'. Mutation: in classifyTransfer drop the
//    `t.amount_atomic === "0"` branch -> poisoning rows become payments, red.
// 3. The mark advances only after rows are written, to the last block fully
//    covered. Mutation: write the mark before the loop, or set coveredTo = toBlock
//    unconditionally -> the capped-page test goes red.
// 4. A re-run over the same range writes nothing twice (UNIQUE tx,log_index).
//    Mutation: change INSERT OR IGNORE to INSERT -> the rerun test throws.
// 5. The listing page and the rail serve observed payments as their own tier.
//    Mutation: drop `observed_payments` from the binding row -> red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { blocksPerCycle, blocksPerCycleCapped, callWithRetry, classifyTransfer, logsAgree, observeFunderWallets, observerRpcUrls, padTopic, parseTransferLogs, OBSERVER_BLOCKS_PER_CYCLE, OBSERVER_BLOCKS_PER_CYCLE_KEYED, OBSERVER_BLOCKS_PER_PAGE, OBSERVER_MAX_PAGES_PER_CYCLE, OBSERVER_MAX_ROWS_PER_CYCLE, OBSERVER_PROVIDER_ATTEMPTS } from "../src/observer.ts";
import { baseRpcUrls } from "../src/payouts.ts";
import { getListing, listListings, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const FUNDER = "0x3853965505b92bcef5b6a20fcca65c758f76736a";
const PAYEE = "0xd962bf2b962263ab155f55fa0c5fb02252fca5d9";
const LOOKALIKE = "0xd9628bf03727718c597895e6a2758279dd1aa5d9";
const STRANGER = "0x4b010deacd6aa30d6674b0624ad5aad935b44d28";

const log = (to: string, amount: bigint, block: number, tx: string, idx = 0) => ({
  address: USDC,
  topics: [TOPIC, padTopic(FUNDER), padTopic(to)],
  data: "0x" + amount.toString(16).padStart(64, "0"),
  transactionHash: tx,
  logIndex: "0x" + idx.toString(16),
  blockNumber: "0x" + block.toString(16),
});
const tx = (n: number) => "0x" + n.toString(16).padStart(64, "0");

function makeEnv() {
  const { env, db } = sqliteTestEnv(SCHEMA);
  const nowS = Math.floor(Date.now() / 1000);
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES
      (1, 'understory', 'm', 'a', 100, 100), (2, 'hermes', 'm', 'b', 100, 100), (3, 'other', 'm', 'c', 100, 100);
    INSERT INTO listings (id, citizen_id, title, condition, amount_atomic, chain_id, token, expiry, funder_address, funder_signature, funds_seen_atomic, payload_hash, commit_nonce, created_at)
      VALUES (9, 1, 'bounty', '${"c".repeat(40)}', '500000', 8453, '${USDC}', ${nowS + 86400}, '${FUNDER}', '${"0x" + "1".repeat(130)}', '24000000', 'ph9', 'n9', ${Date.now() - 30 * 60 * 1000});
    INSERT INTO payout_bindings (id, citizen_id, docket_id, version, amount_atomic, chain_id, token, payout_address, expiry, wallet_signature, citizen_public_key, citizen_signature, citizen_key_thumbprint, citizen_key_custody, citizen_key_bound_at, authorization_verification, authorization_verified_at, docket_acceptance, docket_updated, docket_snapshot, preimage, authorization_hash, payload_hash, commit_nonce, created_at)
      VALUES (25, 2, 'listing-9', '1f916.payout.v1', '500000', 8453, '${USDC}', '${PAYEE}', ${nowS + 86400}, 'ws', 'pk', 'cs', 'tp', 'self', 1, 'valid-at-binding-event', 1, 'a', '0', '{}', 'pre', 'ah', 'ph25', 'n25', ${Date.now() - 20 * 60 * 1000});
  `);
  return { env, db };
}

// A fake provider pool: each url answers with its own logs for the range.
function fakeRpc(answers: Record<string, unknown[] | "fail">, finalized = 51_000_000) {
  const calls: Array<{ url: string; method: string }> = [];
  const rpc = async (url: string, method: string, params: unknown[]) => {
    calls.push({ url, method });
    if (answers[url] === "fail") throw new Error("rpc unavailable");
    if (method === "eth_chainId") return "0x2105";
    if (method === "eth_getBlockByNumber") return { number: "0x" + finalized.toString(16), timestamp: "0x1" };
    if (method === "eth_getLogs") {
      const p = params[0] as { fromBlock: string; toBlock: string };
      const from = Number(BigInt(p.fromBlock)), to = Number(BigInt(p.toBlock));
      return (answers[url] as Array<{ blockNumber: string }>).filter((l) => { const b = Number(BigInt(l.blockNumber)); return b >= from && b <= to; });
    }
    throw new Error("unexpected " + method);
  };
  return { rpc, calls };
}

test("parseTransferLogs canonicalises and drops anything that is not an ERC-20 Transfer", () => {
  const good = log(PAYEE, 500000n, 100, tx(1), 3);
  const bad = { ...good, topics: [TOPIC, padTopic(FUNDER)] };
  const rows = parseTransferLogs([bad, good, { ...good, data: "0xzz" }]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { token: USDC, from: FUNDER, to: PAYEE, amount_atomic: "500000", tx_hash: tx(1), log_index: 3, block_number: 100 });
  assert.equal(logsAgree(parseTransferLogs([good]), parseTransferLogs([{ ...good, removed: false }])), true, "provider-specific fields do not break agreement");
  assert.equal(logsAgree(parseTransferLogs([good]), parseTransferLogs([log(PAYEE, 500000n, 100, tx(2), 3)])), false);
  assert.throws(() => parseTransferLogs({ not: "array" }));
});

test("classifyTransfer names the binding on an exact match, flags zero-value rows, and calls strangers other", () => {
  const index = { byAddress: new Map([[PAYEE, [
    { binding_id: 25, listing_id: 9, citizen_id: 2, amount_atomic: "500000", token: USDC },
    { binding_id: 26, listing_id: 10, citizen_id: 2, amount_atomic: "1000000", token: USDC },
    // The dominant real regime: one payee bound at the same price on many of
    // the funder's listings. A 0.50 payment must not be credited to any one.
    { binding_id: 40, listing_id: 14, citizen_id: 2, amount_atomic: "500000", token: USDC },
  ]]]) };
  const t = (to: string, amt: string) => ({ token: USDC, from: FUNDER, to, amount_atomic: amt, tx_hash: tx(1), log_index: 0, block_number: 1 });
  assert.deepEqual(classifyTransfer(t(PAYEE, "1000000"), index), { kind: "payment", binding_id: 26, listing_id: 10, citizen_id: 2 }, "a unique exact match credits its listing");
  assert.deepEqual(classifyTransfer(t(PAYEE, "500000"), index), { kind: "payment", binding_id: null, listing_id: null, citizen_id: 2 }, "an exact match on two listings credits neither (killing mutation: find() instead of filter()+uniqueness)");
  assert.deepEqual(classifyTransfer(t(PAYEE, "250000"), index), { kind: "payment", binding_id: null, listing_id: null, citizen_id: 2 }, "no exact amount: the citizen is named, no listing or binding is credited");
  assert.deepEqual(classifyTransfer(t(LOOKALIKE, "0"), index), { kind: "zero_value", binding_id: null, listing_id: null, citizen_id: null });
  assert.deepEqual(classifyTransfer(t(PAYEE, "0"), index), { kind: "zero_value", binding_id: null, listing_id: null, citizen_id: null }, "zero to a bound address is still poisoning, never a payment");
  assert.deepEqual(classifyTransfer(t(STRANGER, "35000000"), index), { kind: "other", binding_id: null, listing_id: null, citizen_id: null });
});

test("nothing is written unless two providers return identical logs; a disagreement is logged on the mark and retried", async () => {
  const { env, db } = makeEnv();
  const paid = log(PAYEE, 500000n, 50_979_500, tx(1));
  const { rpc, calls } = fakeRpc({ a: [paid], b: [], c: "fail", d: [paid] });
  const one = await observeFunderWallets(env, { rpc, urls: () => ["a", "b", "c", "d"] });
  assert.equal(one.error, undefined, "a and d agree");
  assert.equal(one.payments, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM observed_transfers").get()!.n, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(db.prepare("SELECT kind, binding_id, listing_id, citizen_id, sources FROM observed_transfers").get())), { kind: "payment", binding_id: 25, listing_id: 9, citizen_id: 2, sources: 2 });
  assert.ok(calls.filter((c) => c.method === "eth_getLogs").length <= 3, "at most one getLogs per provider tried");

  // Fresh wallet, only one provider answers: no write, error on the mark, mark unchanged.
  const { env: env2, db: db2 } = makeEnv();
  const two = await observeFunderWallets(env2, { rpc: fakeRpc({ a: [paid], b: "fail", c: "fail", d: "fail" }).rpc, urls: () => ["a", "b", "c", "d"] });
  assert.equal(two.error, "no two providers agreed");
  assert.equal(db2.prepare("SELECT COUNT(*) AS n FROM observed_transfers").get()!.n, 0);
  const mark = db2.prepare("SELECT last_block, last_error FROM observer_marks").get() as { last_block: number | null; last_error: string };
  assert.match(mark.last_error, /no two providers agreed/);
  assert.equal(mark.last_block, null, "a failed first cycle leaves the wallet never-walked");
  // Killing mutation: bind 0 instead of NULL on the failure path. The next
  // successful cycle would then start at block 1 and walk from genesis.
  const recovered = await observeFunderWallets(env2, { rpc: fakeRpc({ a: [paid], b: [paid] }).rpc, urls: () => ["a", "b"] });
  assert.ok(recovered.from_block > 50_000_000, `the start rule still applies after a failed cycle, got ${recovered.from_block}`);
  // Two providers that disagree with each other also write nothing.
  const { env: env3, db: db3 } = makeEnv();
  const three = await observeFunderWallets(env3, { rpc: fakeRpc({ a: [paid], b: [log(PAYEE, 250000n, 50_979_500, tx(1))] }).rpc, urls: () => ["a", "b"] });
  assert.equal(three.error, "no two providers agreed");
  assert.equal(db3.prepare("SELECT COUNT(*) AS n FROM observed_transfers").get()!.n, 0);
});

test("the walk is bounded per cycle, resumes from its mark, never double-writes, and stops short of a capped page", async () => {
  const { env, db } = makeEnv();
  const finalized = 51_000_000;
  // Rows across three cycles' worth of blocks, plus poisoning and a stranger.
  const logs = [
    log(PAYEE, 500000n, finalized - 15_000, tx(1)),
    log(LOOKALIKE, 0n, finalized - 14_999, tx(2)),
    log(STRANGER, 35_000_000n, finalized - 5_000, tx(3)),
    log(PAYEE, 500000n, finalized - 100, tx(4)),
  ];
  const { rpc } = fakeRpc({ a: logs, b: logs }, finalized);
  const deps = { rpc, urls: () => ["a", "b"] };
  const first = await observeFunderWallets(env, deps);
  assert.equal(first.to_block - first.from_block + 1, OBSERVER_BLOCKS_PER_CYCLE, "one bounded range per cycle");
  assert.ok(OBSERVER_BLOCKS_PER_CYCLE <= 1000, "public providers cap eth_getLogs at 1,000 blocks; a wider range finds no second source");
  assert.equal(db.prepare("SELECT last_block FROM observer_marks").get()!.last_block, first.to_block);
  let cycles = 1;
  while (cycles < 60) {
    const r = await observeFunderWallets(env, deps);
    cycles++;
    if (r.to_block >= finalized) break;
  }
  const rows = db.prepare("SELECT kind, to_address, amount_atomic FROM observed_transfers ORDER BY block_number").all() as Array<{ kind: string; to_address: string; amount_atomic: string }>;
  assert.deepEqual(rows.map((r) => r.kind), ["payment", "zero_value", "other", "payment"]);
  assert.equal(db.prepare("SELECT last_block FROM observer_marks").get()!.last_block, finalized, "walked to the finalized head");
  // Re-running over the same head writes nothing new.
  const again = await observeFunderWallets(env, deps);
  assert.equal(again.rows, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM observed_transfers").get()!.n, 4);
  // A mark that went backwards (a cycle that wrote rows and then failed to
  // write its mark) re-walks the same range: rows already held are skipped by
  // the UNIQUE (tx_hash, log_index), never duplicated and never thrown on.
  db.prepare("UPDATE observer_marks SET last_block = ?").run(finalized - 20_000);
  let walked = 0;
  while (walked < 60) {
    const r = await observeFunderWallets(env, deps);
    walked++;
    if (r.to_block >= finalized) break;
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM observed_transfers").get()!.n, 4, "a re-walk never double-writes");

  // A capped page: more rows than OBSERVER_MAX_ROWS_PER_CYCLE in one range.
  const { env: env2, db: db2 } = makeEnv();
  const many = Array.from({ length: OBSERVER_MAX_ROWS_PER_CYCLE + 5 }, (_, i) => log(STRANGER, 1n, finalized - 20_800 + Math.floor(i / 2), tx(100 + i), i % 2));
  const r2 = await observeFunderWallets(env2, { rpc: fakeRpc({ a: many, b: many }, finalized).rpc, urls: () => ["a", "b"] });
  const lastFull = many[OBSERVER_MAX_ROWS_PER_CYCLE - 1]!;
  assert.equal(r2.to_block, Number(BigInt(lastFull.blockNumber)) - 1, "the mark stops before the block the cap cut into");
  assert.ok(db2.prepare("SELECT COUNT(*) AS n FROM observed_transfers").get()!.n < OBSERVER_MAX_ROWS_PER_CYCLE, "rows in the cut block are left for next cycle");
});

test("the listing page and the rail serve observed payments as their own tier, beside receipts", async () => {
  const { env, db } = makeEnv();
  const paid = log(PAYEE, 500000n, 50_999_000, tx(1));
  const deps = { rpc: fakeRpc({ a: [paid], b: [paid] }).rpc, urls: () => ["a", "b"] };
  for (let i = 0; i < 60; i++) {
    const r = await observeFunderWallets(env, deps);
    if (r.to_block >= 51_000_000) break;
  }
  const page = await getListing(env, 9);
  const b25 = page.bindings.find((b) => Number(b.id) === 25) as unknown as { observed_payments: Array<{ tx_hash: string; amount_atomic: string }>; receipt_id: unknown };
  assert.equal(b25.observed_payments.length, 1);
  assert.equal(b25.observed_payments[0]!.tx_hash, tx(1));
  assert.equal(b25.receipt_id, null, "an observed payment is not a receipt");
  assert.match(String((page as { observed_payment_note: string }).observed_payment_note), /not a receipt/);
  const feed = await listListings(env);
  assert.equal(feed.listings[0]!.observed_payments, 1);
  assert.equal(feed.listings[0]!.receipts, 0);
});

// A listing that names no funder wallet is never walked: null, never zero.
// Killing mutation: drop the funder_address === null branch in getListing or
// the CASE in listListings -> red.
test("a listing with no funder wallet serves null observed payments, and the rail serves the observer's marks", async () => {
  const { env, db } = makeEnv();
  db.exec(`INSERT INTO listings (id, citizen_id, title, condition, amount_atomic, chain_id, token, expiry, payload_hash, commit_nonce, created_at)
    VALUES (13, 3, 'unfunded', '${"c".repeat(40)}', '1000000', 8453, '${USDC}', ${Math.floor(Date.now() / 1000) + 86400}, 'ph13', 'n13', ${Date.now()})`);
  const feed = await listListings(env);
  const byId = Object.fromEntries(feed.listings.map((l) => [Number(l.id), l.observed_payments]));
  assert.deepEqual(byId, { 9: 0, 13: null });
  const page = await getListing(env, 13);
  assert.equal(page.bindings.length, 0);
  const paid = log(PAYEE, 500000n, 50_999_000, tx(1));
  const deps = { rpc: fakeRpc({ a: [paid], b: [paid] }).rpc, urls: () => ["a", "b"] };
  const first = await observeFunderWallets(env, deps);
  const { railCensus } = await import("../src/society.ts");
  const r = (await railCensus(env)) as unknown as { observer: { marks: Array<{ funder_address: string; last_block: number; last_range_rows: number }> } };
  assert.equal(r.observer.marks.length, 1);
  assert.equal(r.observer.marks[0]!.funder_address, FUNDER);
  assert.equal(r.observer.marks[0]!.last_block, first.to_block);
});

// The write is one batch. A cycle that dies mid-write leaves nothing behind,
// and the mark's clock still moves so the wallet rotates.
// Killing mutations: replace env.DB.batch(statements) with a loop of .run()
// (rows land before the failure: first assertion red); drop the catch in
// observeFunderWallets (updated_at stays null: third assertion red).
test("the write is atomic and a cycle that throws still rotates the wallet", async () => {
  const { env, db } = makeEnv();
  const paid = log(PAYEE, 500000n, 50_979_500, tx(1));
  const NOW = Date.now();
  const deps = { rpc: fakeRpc({ a: [paid], b: [paid] }).rpc, urls: () => ["a", "b"], now: () => NOW };
  const realBatch = env.DB.batch.bind(env.DB);
  let batched = 0;
  (env.DB as unknown as { batch: (s: unknown[]) => Promise<unknown> }).batch = async (stmts: unknown[]) => {
    batched = stmts.length;
    throw new Error("simulated D1 failure mid-batch");
  };
  await assert.rejects(() => observeFunderWallets(env, deps), /simulated D1 failure/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM observed_transfers").get()!.n, 0, "no row lands outside the batch");
  assert.equal(batched, 2, "one insert plus the mark upsert travel together");
  const mark = db.prepare("SELECT last_block, updated_at, last_error FROM observer_marks").get() as { last_block: number | null; updated_at: number; last_error: string };
  assert.equal(mark.last_block, null, "the mark did not move");
  assert.equal(mark.updated_at, NOW, "but its clock did, so the wallet rotates");
  assert.match(mark.last_error, /cycle threw/);
  (env.DB as unknown as { batch: typeof realBatch }).batch = realBatch;
  const ok = await observeFunderWallets(env, deps);
  assert.equal(ok.payments, 1, "the same range is re-walked cleanly next cycle");
});

// A capped page over 100 rows must not hit D1's 100-parameter limit in the
// already-held check. Killing mutation: chunk size 200 -> the fake below throws.
test("the already-held check never binds more than 100 parameters", async () => {
  const { env } = makeEnv();
  const finalized = 51_000_000;
  const many = Array.from({ length: 150 }, (_, i) => log(STRANGER, 1n, finalized - 20_800 + Math.floor(i / 2), tx(100 + i), i % 2));
  const prepare = env.DB.prepare.bind(env.DB);
  (env.DB as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    const n = (sql.match(/\?/g) ?? []).length;
    if (n > 100) throw new Error(`too many SQL variables: ${n}`);
    return prepare(sql);
  };
  const r = await observeFunderWallets(env, { rpc: fakeRpc({ a: many, b: many }, finalized).rpc, urls: () => ["a", "b"] });
  assert.equal(r.rows, 150);
});

// A keyed endpoint, when configured, leads both provider lists and is never
// listed twice. Killing mutation: drop the BASE_RPC_PRIVATE_URL spread in
// either function -> red.
test("a configured private RPC endpoint leads both provider lists exactly once", () => {
  const priv = "https://example.quiknode.pro/abc";
  const withKey = { BASE_RPC_PRIVATE_URL: priv } as unknown as Env;
  const without = {} as unknown as Env;
  assert.equal(observerRpcUrls(withKey)[0], priv);
  assert.equal(baseRpcUrls(withKey)[0], priv);
  assert.equal(observerRpcUrls(withKey).filter((u) => u === priv).length, 1);
  assert.equal(observerRpcUrls(withKey)[1], "https://mainnet.base.org");
  assert.equal(observerRpcUrls(withKey)[2], "https://base.gateway.tenderly.co");
  assert.ok(!observerRpcUrls(without).some((u) => u.includes("quiknode")));
  assert.equal(observerRpcUrls(without)[0], "https://mainnet.base.org");
  // Two keyed endpoints lead in order, and only then does the range widen.
  // Killing mutations: drop the _2 spread (order red); make blocksPerCycle
  // return the keyed range with one endpoint (range red).
  const priv2 = "https://base-mainnet.infura.io/v3/abc";
  const both = { BASE_RPC_PRIVATE_URL: priv, BASE_RPC_PRIVATE_URL_2: priv2 } as unknown as Env;
  assert.deepEqual(observerRpcUrls(both).slice(0, 3), [priv, priv2, "https://mainnet.base.org"]);
  assert.deepEqual(baseRpcUrls(both).slice(0, 2), [priv, priv2]);
  assert.equal(blocksPerCycle(both), OBSERVER_BLOCKS_PER_CYCLE_KEYED);
  // One keyed endpoint widens the STRIDE, not the width of one question:
  // mainnet.base.org caps eth_getLogs at 2,000 blocks (re-measured 2026-09-12,
  // c56583) and cannot second a 10,000-block question at all. The stride is
  // reached by paging; see the page tests below.
  assert.equal(blocksPerCycle(withKey), OBSERVER_BLOCKS_PER_CYCLE_KEYED, "one keyed endpoint widens the stride (killing mutation: require both keyed)");
  assert.equal(blocksPerCycle(without), OBSERVER_BLOCKS_PER_CYCLE);
  assert.ok(OBSERVER_BLOCKS_PER_CYCLE_KEYED <= 10_000);
});

// The walk uses the keyed range when both endpoints are configured.
// Killing mutation: hardcode OBSERVER_BLOCKS_PER_CYCLE in walkWallet -> red.
test("with two keyed endpoints the walk covers the keyed range per cycle", async () => {
  const { env } = makeEnv();
  (env as unknown as { BASE_RPC_PRIVATE_URL: string; BASE_RPC_PRIVATE_URL_2: string }).BASE_RPC_PRIVATE_URL = "https://a.example/k";
  (env as unknown as { BASE_RPC_PRIVATE_URL_2: string }).BASE_RPC_PRIVATE_URL_2 = "https://b.example/k";
  const r = await observeFunderWallets(env, { rpc: fakeRpc({ "https://a.example/k": [], "https://b.example/k": [] }).rpc });
  assert.equal(r.sources, 2);
  assert.equal(r.to_block - r.from_block + 1, OBSERVER_BLOCKS_PER_CYCLE_KEYED);
});

// One retry on a 429, and only on a 429. Killing mutations: drop the regex
// test (a non-429 error is retried: second block red); drop the retry (first
// block red).
test("callWithRetry retries exactly once on HTTP 429 and never on anything else", async () => {
  let n = 0;
  const flaky = async () => { n++; if (n === 1) throw new Error("rpc unavailable (HTTP 429)"); return "ok"; };
  assert.equal(await callWithRetry(flaky as never, "u", "m", [], 1), "ok");
  assert.equal(n, 2);
  let m = 0;
  const hard = async () => { m++; throw new Error("rpc error -32001: usage limit"); };
  await assert.rejects(() => callWithRetry(hard as never, "u", "m", [], 1), /usage limit/);
  assert.equal(m, 1, "a non-429 failure is not retried");
  let k = 0;
  const twice = async () => { k++; throw new Error("rpc unavailable (HTTP 429)"); };
  await assert.rejects(() => callWithRetry(twice as never, "u", "m", [], 1), /429/);
  assert.equal(k, 2, "at most one retry");
});

// ---------------------------------------------------------------------------
// Paging: one question is never wider than the public pool answers.
//
// The regression these three guard, measured live 2026-09-12 (c56583 on #3525):
// with one keyed endpoint the cycle asked all five providers for 10,000 blocks
// at once. mainnet.base.org caps eth_getLogs at 2,000, tenderly at under 2,000,
// publicnode refuses 10,000, drpc refuses every width. Only the keyed voice
// could answer, so "two independently operated providers" was unsatisfiable by
// construction and all four marks on /api/rail read "no two providers agreed
// (1 answered)" with last_block 22 to 26 days behind finality.
// ---------------------------------------------------------------------------

// A pool that behaves like the real one: `cap` is the widest inclusive range a
// provider will answer, and anything wider throws the way mainnet.base.org
// does. `failFrom` refuses exactly one page, to model a mid-walk 429.
function cappedRpc(answers: Record<string, { logs: unknown[]; cap: number; failFrom?: number }>, finalized = 51_000_000) {
  const calls: Array<{ url: string; method: string; from?: number; to?: number }> = [];
  const rpc = async (url: string, method: string, params: unknown[]) => {
    const who = answers[url];
    if (!who) throw new Error("rpc unavailable");
    if (method === "eth_chainId") { calls.push({ url, method }); return "0x2105"; }
    if (method === "eth_getBlockByNumber") { calls.push({ url, method }); return { number: "0x" + finalized.toString(16), timestamp: "0x1" }; }
    if (method === "eth_getLogs") {
      const p = params[0] as { fromBlock: string; toBlock: string };
      const from = Number(BigInt(p.fromBlock)), to = Number(BigInt(p.toBlock));
      calls.push({ url, method, from, to });
      if (to - from + 1 > who.cap) throw new Error(`rpc error -32614: eth_getLogs is limited to a ${who.cap.toLocaleString("en-US")} range`);
      if (who.failFrom === from) throw new Error("rpc unavailable (HTTP 429)");
      return (who.logs as Array<{ blockNumber: string }>).filter((l) => { const b = Number(BigInt(l.blockNumber)); return b >= from && b <= to; });
    }
    throw new Error("unexpected " + method);
  };
  return { rpc, calls };
}

// Killing mutation: ask the whole stride in one eth_getLogs (revert the page
// split in walkWallet) -> only the keyed voice answers, sources drops to 1 and
// the walk writes nothing. That mutation IS the production bug.
test("a provider that caps eth_getLogs below the cycle stride still votes, because the question is one page wide", async () => {
  const { env, db } = makeEnv();
  (env as unknown as { BASE_RPC_PRIVATE_URL: string }).BASE_RPC_PRIVATE_URL = "https://keyed.example/k";
  const finalized = 51_000_000;
  db.prepare("INSERT INTO observer_marks (funder_address, last_block, updated_at) VALUES (?, ?, ?)").run(FUNDER, finalized - 100_000, 1);
  const paid = log(PAYEE, 500000n, finalized - 95_000, tx(1)); // inside page 3
  const { rpc, calls } = cappedRpc({
    "https://keyed.example/k": { logs: [paid], cap: 10_000 },
    // Exactly mainnet.base.org: it can never answer 10,000, and it is the only
    // other operator in this pool.
    "https://mainnet.base.org": { logs: [paid], cap: OBSERVER_BLOCKS_PER_PAGE },
  }, finalized);
  const r = await observeFunderWallets(env, { rpc, urls: () => ["https://keyed.example/k", "https://mainnet.base.org"] });

  assert.equal(r.error, undefined, "a capped public provider is a voter again");
  assert.equal(r.sources, 2, "two independently operated providers, not one");
  assert.equal(r.pages, OBSERVER_BLOCKS_PER_CYCLE_KEYED / OBSERVER_BLOCKS_PER_PAGE);
  assert.equal(r.to_block - r.from_block + 1, OBSERVER_BLOCKS_PER_CYCLE_KEYED, "the stride is unchanged: paging costs no ground");
  assert.equal(r.payments, 1);
  assert.equal(db.prepare("SELECT last_block FROM observer_marks").get()!.last_block, r.to_block);
  assert.equal(db.prepare("SELECT last_error FROM observer_marks").get()!.last_error, null, "a full stride leaves no error behind");
  // No single question was ever wider than a page, on ANY provider.
  const widest = Math.max(...calls.filter((c) => c.method === "eth_getLogs").map((c) => c.to! - c.from! + 1));
  assert.equal(widest, OBSERVER_BLOCKS_PER_PAGE, "no eth_getLogs is wider than one page");
});

// Killing mutations: on a page failure, throw instead of breaking (the pages
// behind it are lost: first assertion red); or set the mark to toBlock rather
// than the last agreed block (the resume assertion red, and the walk would be
// claiming blocks nobody seconded).
test("a page nobody seconds ends the cycle at the last agreed block, and the pages behind it are kept", async () => {
  const { env, db } = makeEnv();
  (env as unknown as { BASE_RPC_PRIVATE_URL: string }).BASE_RPC_PRIVATE_URL = "https://keyed.example/k";
  const finalized = 51_000_000;
  const start = finalized - 100_000;
  db.prepare("INSERT INTO observer_marks (funder_address, last_block, updated_at) VALUES (?, ?, ?)").run(FUNDER, start, 1);
  const from = start + 1;
  const page2End = from + 2 * OBSERVER_BLOCKS_PER_PAGE - 1;
  const inPage1 = log(PAYEE, 500000n, from + 10, tx(1));
  const inPage2 = log(STRANGER, 7n, from + OBSERVER_BLOCKS_PER_PAGE + 10, tx(2));
  const inPage3 = log(PAYEE, 500000n, page2End + 50, tx(3));
  const logs = [inPage1, inPage2, inPage3];
  const { rpc } = cappedRpc({
    "https://keyed.example/k": { logs, cap: 10_000 },
    // Page 3 is refused with the 429 the production marks actually record.
    "https://mainnet.base.org": { logs, cap: OBSERVER_BLOCKS_PER_PAGE, failFrom: page2End + 1 },
  }, finalized);
  const urls = () => ["https://keyed.example/k", "https://mainnet.base.org"];
  const r = await observeFunderWallets(env, { rpc, urls });

  assert.equal(r.pages, 2, "two pages agreed, the third did not");
  assert.equal(r.to_block, page2End, "the mark holds the last block two operators agreed on");
  assert.equal(r.rows, 2, "pages 1 and 2 are banked, not discarded");
  assert.match(String(r.partial), /429/);
  const mark = db.prepare("SELECT last_block, last_error FROM observer_marks").get() as { last_block: number; last_error: string };
  assert.equal(mark.last_block, page2End);
  assert.match(mark.last_error, /429/, "a short walk says why it was short (killing mutation: bind NULL last_error) ");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM observed_transfers").get()!.n, 2);

  // The next cycle resumes at the refused page and, with it answered, covers
  // the rest without re-writing anything.
  const clean = cappedRpc({
    "https://keyed.example/k": { logs, cap: 10_000 },
    "https://mainnet.base.org": { logs, cap: OBSERVER_BLOCKS_PER_PAGE },
  }, finalized);
  const again = await observeFunderWallets(env, { rpc: clean.rpc, urls });
  assert.equal(again.from_block, page2End + 1, "resumed exactly where the refusal stopped it");
  assert.equal(again.rows, 1, "only the row in the page that was missed");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM observed_transfers").get()!.n, 3, "no row written twice");
  assert.equal(db.prepare("SELECT last_error FROM observer_marks").get()!.last_error, null, "the error clears when the stride completes");
});

// The cron shares its subrequest budget with the checkpoint pass, which is the
// one thing in that invocation that must never be skipped. Killing mutation:
// drop the OBSERVER_MAX_PAGES_PER_CYCLE clamp in blocksPerCycleCapped and the
// cost grows with whatever anyone sets the stride to.
test("the cycle's outbound cost is bounded by the page budget, not by how far behind the mark is", async () => {
  const withKey = { BASE_RPC_PRIVATE_URL: "https://keyed.example/k" } as unknown as Env;
  assert.equal(blocksPerCycleCapped(withKey), OBSERVER_BLOCKS_PER_PAGE * OBSERVER_MAX_PAGES_PER_CYCLE);
  assert.ok(blocksPerCycleCapped(withKey) <= OBSERVER_BLOCKS_PER_PAGE * OBSERVER_MAX_PAGES_PER_CYCLE);
  assert.equal(blocksPerCycleCapped({} as unknown as Env), OBSERVER_BLOCKS_PER_CYCLE, "no keyed endpoint is still one page");

  const { env, db } = makeEnv();
  (env as unknown as { BASE_RPC_PRIVATE_URL: string }).BASE_RPC_PRIVATE_URL = "https://keyed.example/k";
  const finalized = 51_000_000;
  // A mark a million blocks behind: the cost of this cycle must not notice.
  db.prepare("INSERT INTO observer_marks (funder_address, last_block, updated_at) VALUES (?, ?, ?)").run(FUNDER, finalized - 1_126_794, 1);
  const { rpc, calls } = cappedRpc({
    "https://keyed.example/k": { logs: [], cap: 10_000 },
    "https://mainnet.base.org": { logs: [], cap: OBSERVER_BLOCKS_PER_PAGE },
  }, finalized);
  const r = await observeFunderWallets(env, { rpc, urls: () => ["https://keyed.example/k", "https://mainnet.base.org"] });
  assert.equal(r.pages, OBSERVER_MAX_PAGES_PER_CYCLE);
  const gets = calls.filter((c) => c.method === "eth_getLogs").length;
  // One getLogs per provider on page one (at most OBSERVER_PROVIDER_ATTEMPTS),
  // then two per remaining page.
  assert.ok(gets <= OBSERVER_PROVIDER_ATTEMPTS + 2 * (OBSERVER_MAX_PAGES_PER_CYCLE - 1), `getLogs calls ${gets} within budget`);
  assert.equal(gets, 2 + 2 * (OBSERVER_MAX_PAGES_PER_CYCLE - 1), "two voices, every page, no re-asking the providers that lost");
  assert.ok(calls.filter((c) => c.method === "eth_getBlockByNumber").length <= OBSERVER_PROVIDER_ATTEMPTS, "the finalized head is read once per provider, never once per page");
});
