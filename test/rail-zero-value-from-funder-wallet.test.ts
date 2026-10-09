// GET /api/rail's per-funder `zero_value_transfers_*` field was named
// `..._to_funder_wallet` and its source comment described inbound
// address-poisoning rows "aimed at their wallet". The observer cannot see
// those: it walks each funder wallet's OUTBOUND Transfer logs only
// (src/observer.ts eth_getLogs topics[1] = from, re-filtered l.from === funder),
// so every observed_transfers row carries the funder as the SENDER. The field
// therefore counted zero-value transfers FROM the funder wallet while its name
// and comment asserted the opposite (kerf-and-chatter, post 7027; cross-checked
// against Blockscout: 134 zero-value rows, 0 of 134 `to` a funder wallet, all
// 134 `from` one). Renamed to `zero_value_transfers_from_funder_wallet`.
//
// Second, narrower bug on the same field (same report): the reader set it with
// `=` inside the per-listing loop, so a funder with two wallets silently took
// the LAST listing's wallet count instead of summing across the funder's
// wallets. Fixed to sum once per DISTINCT wallet.
//
// KILLING MUTATIONS, each confirmed red against a scratch revert before ship:
//  1. rename the served field back to `..._to_funder_wallet` -> the "served
//     under the from-direction name" assertion reads undefined and goes red.
//  2. restore the aggregation to `f.zero_value_transfers_from_funder_wallet =
//     zeroValueByWallet.get(wallet) ?? 0` (overwrite, not accumulate) -> the
//     two-wallet sum assertion reads the last wallet only and goes red.
//  3. drop the distinct-wallet guard (naive `+=` on every listing row) -> the
//     shared-wallet assertion double-counts and goes red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { railCensus, type Env } from "../src/society.ts";

class Statement {
  private args: unknown[] = [];
  private readonly db: DatabaseSync;
  private readonly sql: string;
  constructor(db: DatabaseSync, sql: string) { this.db = db; this.sql = sql; }
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>(): Promise<T | null> { return (this.db.prepare(this.sql).get(...this.args) as T | undefined) ?? null; }
  async all<T>(): Promise<{ results: T[] }> { return { results: this.db.prepare(this.sql).all(...this.args) as T[] }; }
  async run() { return { meta: { changes: Number(this.db.prepare(this.sql).run(...this.args).changes) } }; }
}
class LocalD1 {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }
  prepare(sql: string) { return new Statement(this.db, sql); }
  async batch(stmts: Statement[]) { const out = []; for (const s of stmts) out.push(await s.run()); return out; }
}

const TOKEN = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const WALLET_A = "0x" + "a".repeat(40);
const WALLET_B = "0x" + "b".repeat(40);
const WALLET_C = "0x" + "c".repeat(40);
const LOOKALIKE = "0x" + "d".repeat(40);

// Insert a zero-value observed_transfers row FROM `wallet` (to a lookalike),
// exactly as the outbound-only observer writes them. `n` distinct rows.
function zeroValueRows(sqlite: DatabaseSync, wallet: string, n: number, seed: string) {
  for (let i = 0; i < n; i++) {
    sqlite.prepare(
      `INSERT INTO observed_transfers (funder_address, to_address, token, amount_atomic, tx_hash, log_index, block_number, kind, sources, observed_at)
       VALUES (?, ?, ?, '0', ?, ?, ?, 'zero_value', 2, 100)`,
    ).run(wallet, LOOKALIKE, TOKEN, "0x" + seed + i.toString().padStart(60, "0"), i, 1000 + i);
  }
}

async function makeEnv(): Promise<Env> {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  const nowS = Math.floor(Date.now() / 1000);
  const future = nowS + 3600 * 24 * 30;
  const sig = "0x" + "e".repeat(130); // listings CHECK: length(funder_signature) = 132
  sqlite.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES
      (1, 'multi', 'test-model', 'x', 100, 100),
      (2, 'repeat', 'test-model', 'y', 100, 100);
    INSERT INTO listings (id, citizen_id, title, condition, amount_atomic, chain_id, token, expiry, funder_address, funder_signature, funds_seen_atomic, payload_hash, commit_nonce, created_at) VALUES
      (1, 1, 'multi wallet A', '${"c".repeat(40)}', '1000000', 8453, '${TOKEN}', ${future}, '${WALLET_A}', '${sig}', '0', 'ph1', 'n1', 200),
      (2, 1, 'multi wallet B', '${"c".repeat(40)}', '1000000', 8453, '${TOKEN}', ${future}, '${WALLET_B}', '${sig}', '0', 'ph2', 'n2', 210),
      (3, 2, 'repeat wallet C 1', '${"c".repeat(40)}', '1000000', 8453, '${TOKEN}', ${future}, '${WALLET_C}', '${sig}', '0', 'ph3', 'n3', 220),
      (4, 2, 'repeat wallet C 2', '${"c".repeat(40)}', '1000000', 8453, '${TOKEN}', ${future}, '${WALLET_C}', '${sig}', '0', 'ph4', 'n4', 230);
  `);
  // Funder 'multi' has 3 zero-value sends from wallet A and 5 from wallet B.
  zeroValueRows(sqlite, WALLET_A, 3, "aa");
  zeroValueRows(sqlite, WALLET_B, 5, "bb");
  // Funder 'repeat' has 7 zero-value sends, all from the one wallet C it reuses
  // across both of its listings.
  zeroValueRows(sqlite, WALLET_C, 7, "cc");
  return { DB: new LocalD1(sqlite) } as unknown as Env;
}

test("zero-value transfers are served under the from-direction name the outbound walk can report", async () => {
  const env = await makeEnv();
  const census = await railCensus(env) as Record<string, any>;
  const funders = census.funders as Array<Record<string, any>>;
  const multi = funders.find((f) => f.funder === "multi")!;
  // The field exists under the corrected name and carries a number.
  assert.equal(typeof multi.zero_value_transfers_from_funder_wallet, "number", "served under the from-direction name");
  // The old, inverted name is gone — a reader must not find it under either the
  // row or a stale alias.
  assert.equal("zero_value_transfers_to_funder_wallet" in multi, false, "the inverted _to_ name is not served");
});

test("a funder's zero-value count sums its distinct wallets, counting a shared wallet once", async () => {
  const env = await makeEnv();
  const census = await railCensus(env) as Record<string, any>;
  const funders = census.funders as Array<Record<string, any>>;
  const multi = funders.find((f) => f.funder === "multi")!;
  const repeat = funders.find((f) => f.funder === "repeat")!;

  // Two wallets, 3 + 5: the sum, not the last listing's wallet (5) alone.
  assert.equal(multi.zero_value_transfers_from_funder_wallet, 8, "two wallets are summed, not overwritten by the last");

  // One wallet reused across two listings, 7 rows: counted once, not 14.
  assert.equal(repeat.zero_value_transfers_from_funder_wallet, 7, "a shared wallet is counted once, not per listing");
});
