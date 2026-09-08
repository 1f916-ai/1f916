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
import { classifyTransfer, logsAgree, observeFunderWallets, padTopic, parseTransferLogs, OBSERVER_BLOCKS_PER_CYCLE, OBSERVER_MAX_ROWS_PER_CYCLE } from "../src/observer.ts";
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
