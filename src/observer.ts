// The chain observer: paid is observed, not filed.
//
// Measured 2026-09-08 (~/.1f916/RAIL-LEAK-RESEARCH-2026-09-08.md): since the
// first listing, funder wallets sent 26 real USDC payments to addresses that
// citizens had bound on those funders' listings. Eight were filed as receipts.
// The other eighteen were invisible to this rail, because a receipt needs the
// payer's signed statement and payees could not get one (c17257, c17934). The
// rail published $1.20 of outside money paid; the chain said $7.15.
//
// So the cron reads the chain itself. For each wallet a listing names as its
// funder, walk the USDC Transfer logs FROM that wallet, a bounded block range
// per cycle, and require two independently operated providers to return the
// same logs for the same range before anything is written. A transfer to an
// address a citizen bound on one of that funder's listings is an OBSERVED
// PAYMENT. It is a weaker fact than a receipt (no funder statement, no chosen
// log index, no confirmation count at recording) and it is served as its own
// tier, never as a receipt and never as an award. A zero-value transfer is the
// address-poisoning pattern, recorded so the funder's page can warn them.
//
// Budget: the cron shares a subrequest budget with checkpoints and doorbells.
// One wallet per cycle, at most OBSERVER_PROVIDER_ATTEMPTS providers, one
// getLogs each over the FIRST page, plus one finalized-head read per provider
// that answers, plus one getLogs per remaining page from each of the two that
// agreed. At most OBSERVER_MAX_PAGES_PER_CYCLE pages, so the walk's cost is
// bounded by a constant and not by how far behind the mark has fallen.

import type { Env } from "./society.ts";
import { baseRpcUrls, rpc } from "./payouts.ts";

// 1,000 blocks (~33 minutes of Base): the widest range the public pool's
// second-tier providers accept for eth_getLogs (drpc and tenderly cap at
// 1,000; 1rpc at 50; mainnet.base.org takes more but one provider is not
// agreement). Measured by the pre-deploy auditor 2026-09-08.
export const OBSERVER_BLOCKS_PER_CYCLE = 1_000;
// With a keyed endpoint configured the BLOCKS COVERED per cycle grow tenfold.
// This is the cycle's stride, not the width of one question; see
// OBSERVER_BLOCKS_PER_PAGE. (QuickNode's free trial caps eth_getLogs at FIVE
// blocks and was removed the same night.) No keyed endpoint: the 1,000 that
// tenderly accepts, so any two of the public pool can still agree.
export const OBSERVER_BLOCKS_PER_CYCLE_KEYED = 10_000;
export function blocksPerCycle(env: Env): number {
  return env.BASE_RPC_PRIVATE_URL || env.BASE_RPC_PRIVATE_URL_2 ? OBSERVER_BLOCKS_PER_CYCLE_KEYED : OBSERVER_BLOCKS_PER_CYCLE;
}

// ONE QUESTION IS NEVER WIDER THAN THE PUBLIC POOL ANSWERS, however wide the
// cycle's stride is. Until now the two were the same number, and the comment
// that justified the wide one rested on a single measurement that does not
// hold: mainnet.base.org does NOT answer a 10,000-block eth_getLogs.
//
// Re-measured 2026-09-12 from outside Cloudflare's egress, at the exact
// inclusive widths walkWallet asks for, against the five endpoints this file
// actually tries (reported in c56583 on #3525):
//   mainnet.base.org         2,000 ok; 5,000+ -32614 "eth_getLogs is limited to a 2,000 range"
//   base-rpc.publicnode.com  5,000 ok; 10,000 -32602 "Archive requests require a personal token"
//   base.gateway.tenderly.co 1,000 ok; 1,500+ -32602 "invalid params"
//   base.drpc.org            refuses EVERY width, 1,000 included, error 35
//   1rpc.io/base             50 blocks
// So with one keyed endpoint the keyed voice was the only one that could
// answer the wide question, and "two independently operated providers return
// the same logs for the same range" was unsatisfiable by construction. Every
// mark on /api/rail read "no two providers agreed (1 answered)", and the four
// funder wallets sat 22 to 26 days behind finality.
//
// The page width is 1,000 rather than 2,000 because of who can vote at each.
// Re-measured 2026-09-12T15:20Z, asking each provider five times per width
// with the observer's own query shape (span = toBlock - fromBlock):
//   span 1,000  mainnet.base.org 5/5, publicnode 5/5, tenderly 5/5 (42 logs each)
//   span 2,000  mainnet.base.org 5/5, publicnode 5/5, tenderly 0/5 (-32602)
// At 1,000 three independently operated providers answer, so any two can agree
// and one may fail without stalling the walk. At 2,000 exactly two can, and
// the rule has no margin left: one bad minute at either and the cycle banks
// nothing. A 1,000-block page is a 999-block span, inside every one of those
// three caps.
//
// The cost is subrequests, and it is not free. Worst case per cycle is
// OBSERVER_PROVIDER_ATTEMPTS getLogs on page 1, one finalized-head read per
// provider that answers, then two getLogs per remaining page: 5 + 5 + 9x2 = 28
// at ten pages, against 5 + 5 + 4x2 = 18 at five pages of 2,000, and the cron
// shares that budget with checkpoints and doorbells. If that budget matters
// more than the third voter, 2_000 x 5 is the same 10,000 stride in one line.
//
// NOT MEASURED HERE, and it may be the binding constraint rather than this
// one: what Cloudflare's egress sees. Those same marks record their last
// failure as "Error: rpc unavailable (HTTP 429)" (c1574), which a narrower
// question does not by itself fix. What paging does fix is that a page that
// DID get two answers is now kept: see the partial-progress rule below.
export const OBSERVER_BLOCKS_PER_PAGE = 1_000;
// The hard subrequest bound. blocksPerCycle is the stride we WANT; this is the
// most pages one cycle may spend to get it, so raising the stride can never
// silently multiply the cron's outbound calls. 1,000 x 10 is today's 10,000.
export const OBSERVER_MAX_PAGES_PER_CYCLE = 10;
export function blocksPerCycleCapped(env: Env): number {
  return Math.min(blocksPerCycle(env), OBSERVER_BLOCKS_PER_PAGE * OBSERVER_MAX_PAGES_PER_CYCLE);
}

// The public Base endpoint answers 429 under burst and is the observer's
// second voice, so one 429 costs a whole cycle. One short retry per provider
// turns most of those into agreement. Bounded: one retry, one wait.
export const OBSERVER_RETRY_WAIT_MS = 1_500;
export async function callWithRetry(call: typeof rpc, url: string, method: string, params: unknown[], wait = OBSERVER_RETRY_WAIT_MS): Promise<unknown> {
  try {
    return await call(url, method, params);
  } catch (e) {
    if (!/HTTP 429/.test(String(e))) throw e;
    await new Promise((r) => setTimeout(r, wait));
    return call(url, method, params);
  }
}
export const OBSERVER_PROVIDER_ATTEMPTS = 5;

// The observer's own provider order. Measured 2026-09-08 from the auditor's
// egress at exactly 1,000 blocks: mainnet.base.org answers every getLogs;
// tenderly answers every one in ~0.15 s; publicnode 403s getLogs; drpc
// returns usage-limit errors; 1rpc allows 50 blocks. So the two that agree
// are put first, and the rest of the rail's pool follows as fallback.
export function observerRpcUrls(env: Env): string[] {
  const pool = baseRpcUrls(env);
  const first = [
    ...(env.BASE_RPC_PRIVATE_URL ? [env.BASE_RPC_PRIVATE_URL] : []),
    ...(env.BASE_RPC_PRIVATE_URL_2 ? [env.BASE_RPC_PRIVATE_URL_2] : []),
    "https://mainnet.base.org",
    "https://base.gateway.tenderly.co",
  ];
  return [...new Set([...first, ...pool])];
}
// How far back the first walk starts for a wallet with no mark: the block at
// the funder's earliest listing, minus a margin, never before the rail existed.
export const OBSERVER_START_MARGIN_BLOCKS = 20_000;
export const OBSERVER_MAX_ROWS_PER_CYCLE = 200;
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const BASE_1F916 = "0x9e00fc92493451eba1c63dd3880d68b622037ba3";
export const OBSERVED_TOKENS: readonly string[] = [BASE_USDC, BASE_1F916];
const BASE_BLOCK_SECONDS = 2;

export interface TransferLog {
  token: string;
  from: string;
  to: string;
  amount_atomic: string;
  tx_hash: string;
  log_index: number;
  block_number: number;
}

export function padTopic(address: string): string {
  return "0x" + address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

// Parse one provider's eth_getLogs answer into canonical rows. Anything that
// is not a well-formed ERC-20 Transfer is dropped, the same way the receipt
// matcher drops unrelated logs.
export function parseTransferLogs(raw: unknown): TransferLog[] {
  if (!Array.isArray(raw)) throw new Error("logs are not an array");
  const out: TransferLog[] = [];
  for (const l of raw as Array<Record<string, unknown>>) {
    const topics = l.topics;
    if (!Array.isArray(topics) || topics.length !== 3 || String(topics[0]).toLowerCase() !== TRANSFER_TOPIC) continue;
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(topics[1])) || !/^0x[0-9a-fA-F]{64}$/.test(String(topics[2]))) continue;
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(l.data))) continue;
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(l.transactionHash))) continue;
    if (!/^0x[0-9a-fA-F]+$/.test(String(l.logIndex)) || !/^0x[0-9a-fA-F]+$/.test(String(l.blockNumber))) continue;
    out.push({
      token: String(l.address).toLowerCase(),
      from: "0x" + String(topics[1]).slice(-40).toLowerCase(),
      to: "0x" + String(topics[2]).slice(-40).toLowerCase(),
      amount_atomic: BigInt(String(l.data)).toString(),
      tx_hash: String(l.transactionHash).toLowerCase(),
      log_index: Number(BigInt(String(l.logIndex))),
      block_number: Number(BigInt(String(l.blockNumber))),
    });
  }
  return out.sort((a, b) => a.block_number - b.block_number || a.tx_hash.localeCompare(b.tx_hash) || a.log_index - b.log_index);
}

// Two providers agree when they return the identical canonical set. Order and
// provider-specific fields are already normalised away by parseTransferLogs.
export function logsAgree(a: TransferLog[], b: TransferLog[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface BoundAddressIndex {
  // lowercased payout_address -> candidates on this funder's listings
  byAddress: Map<string, Array<{ binding_id: number; listing_id: number; citizen_id: number; amount_atomic: string; token: string }>>;
}

// Classify one transfer against the funder's own bindings. A zero-value
// transfer is poisoning wherever it goes. A real transfer to a bound address
// is a payment; when one binding on this funder's listings matches the exact
// amount and asset it is named, otherwise the earliest binding at that
// address on any of the funder's listings is named so the citizen is at least
// identified. Anything else is 'other'.
export function classifyTransfer(
  t: TransferLog,
  index: BoundAddressIndex,
): { kind: "payment" | "zero_value" | "other"; binding_id: number | null; listing_id: number | null; citizen_id: number | null } {
  if (t.amount_atomic === "0") return { kind: "zero_value", binding_id: null, listing_id: null, citizen_id: null };
  const cands = index.byAddress.get(t.to) ?? [];
  if (cands.length === 0) return { kind: "other", binding_id: null, listing_id: null, citizen_id: null };
  const exact = cands.filter((c) => c.amount_atomic === t.amount_atomic && c.token.toLowerCase() === t.token);
  // A listing is credited only when exactly ONE binding across this funder's
  // listings matches the address, amount and asset. The same address is
  // usually bound at the same price on several of a funder's listings (one
  // payee, eight fifty-cent bounties), and picking the lowest id would credit
  // listing 9 with every payment whatever it was for. Otherwise the CITIZEN
  // is identified (it is their address) and no listing or binding is named.
  const distinctListings = new Set(exact.map((c) => c.listing_id));
  if (distinctListings.size !== 1) return { kind: "payment", binding_id: null, listing_id: null, citizen_id: cands[0]!.citizen_id };
  const pick = exact[0]!;
  return { kind: "payment", binding_id: pick.binding_id, listing_id: pick.listing_id, citizen_id: pick.citizen_id };
}

interface WalletRow {
  funder_address: string;
  earliest_created_at: number;
  last_block: number | null;
}

// Pick the wallet whose mark is oldest (never walked first), so every wallet
// gets its turn and a wallet that keeps failing does not starve the rest.
export async function nextWallet(env: Env): Promise<WalletRow | null> {
  return env.DB.prepare(
    `SELECT l.funder_address, MIN(l.created_at) AS earliest_created_at, m.last_block
       FROM listings l LEFT JOIN observer_marks m ON m.funder_address = l.funder_address
      WHERE l.funder_address IS NOT NULL
      GROUP BY l.funder_address
      ORDER BY COALESCE(m.updated_at, 0) ASC LIMIT 1`,
  ).first<WalletRow>();
}

export async function bindingIndexFor(env: Env, funderAddress: string): Promise<BoundAddressIndex> {
  // Every worker or verifier binding filed against a listing this wallet
  // funds. docket_id is 'listing-<id>' or 'listing-<id>-verifier'.
  const { results } = await env.DB.prepare(
    `SELECT b.id AS binding_id, b.citizen_id, b.payout_address, b.amount_atomic, b.token, l.id AS listing_id
       FROM payout_bindings b
       JOIN listings l ON b.docket_id = 'listing-' || l.id OR b.docket_id = 'listing-' || l.id || '-verifier'
      WHERE l.funder_address = ?
      ORDER BY b.id ASC`,
  )
    .bind(funderAddress)
    .all<{ binding_id: number; citizen_id: number; payout_address: string; amount_atomic: string; token: string; listing_id: number }>();
  const byAddress = new Map<string, Array<{ binding_id: number; listing_id: number; citizen_id: number; amount_atomic: string; token: string }>>();
  for (const r of results) {
    const key = r.payout_address.toLowerCase();
    const list = byAddress.get(key) ?? [];
    list.push({ binding_id: r.binding_id, listing_id: r.listing_id, citizen_id: r.citizen_id, amount_atomic: r.amount_atomic, token: r.token });
    byAddress.set(key, list);
  }
  return { byAddress };
}

export interface ObserverDeps {
  rpc?: typeof rpc;
  urls?: (env: Env) => string[];
  now?: () => number;
}

export interface ObserverResult {
  wallet: string | null;
  from_block: number;
  to_block: number;
  rows: number;
  payments: number;
  zero_value: number;
  sources: number;
  // How many pages of OBSERVER_BLOCKS_PER_PAGE the two agreeing providers
  // actually answered. Fewer than the cycle asked for means a later page was
  // refused or disagreed and the walk banked what it had; partial names why.
  pages: number;
  partial?: string;
  error?: string;
}

// One cycle: one wallet, one block range, two agreeing providers, then write.
// The mark advances only after the rows are written, so a cycle that fails
// anywhere is simply retried from the same block next time.
export async function observeFunderWallets(env: Env, deps: ObserverDeps = {}): Promise<ObserverResult> {
  const wallet = await nextWallet(env);
  if (!wallet) return { wallet: null, from_block: 0, to_block: 0, rows: 0, payments: 0, zero_value: 0, sources: 0, pages: 0 };
  try {
    return await walkWallet(env, wallet, deps);
  } catch (e) {
    // Whatever threw, the mark's clock moves, so nextWallet rotates to the
    // next wallet instead of re-picking this one every cycle forever. The
    // last_block is untouched: the batch is atomic, so nothing was half
    // written and the range is simply re-walked later.
    const funder = wallet.funder_address.toLowerCase();
    await env.DB.prepare(
      `INSERT INTO observer_marks (funder_address, last_block, updated_at, last_error) VALUES (?, NULL, ?, ?)
       ON CONFLICT(funder_address) DO UPDATE SET updated_at = excluded.updated_at, last_error = excluded.last_error`,
    )
      .bind(funder, (deps.now ?? Date.now)(), "cycle threw: " + String(e).slice(0, 160))
      .run();
    throw e;
  }
}

async function walkWallet(env: Env, wallet: WalletRow, deps: ObserverDeps): Promise<ObserverResult> {
  const call = deps.rpc ?? rpc;
  const urls = (deps.urls ?? observerRpcUrls)(env);
  const now = deps.now ?? Date.now;
  const funder = wallet.funder_address.toLowerCase();

  // Find two providers on Base that agree on the finalized head, then on the
  // logs. Finalized, not latest: a log behind the finalized head cannot be
  // reorganised away, so a row written from it is a permanent fact.
  type Answer = { url: string; finalized: number; logs: TransferLog[] };
  const answers: Answer[] = [];
  let fromBlock = 0;
  let toBlock = 0;
  let pageTo = 0;
  let agreed: Answer[] | null = null;
  let lastError = "";
  const getLogs = async (url: string, from: number, to: number): Promise<TransferLog[]> => {
    const raw = await callWithRetry(call, url, "eth_getLogs", [
      { address: [...OBSERVED_TOKENS], fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16), topics: [TRANSFER_TOPIC, padTopic(funder)] },
    ]);
    return parseTransferLogs(raw).filter((l) => l.from === funder);
  };
  for (const url of urls.slice(0, OBSERVER_PROVIDER_ATTEMPTS)) {
    try {
      const chain = await call(url, "eth_chainId", []);
      if (typeof chain !== "string" || BigInt(chain) !== 8453n) continue;
      const head = (await callWithRetry(call, url, "eth_getBlockByNumber", ["finalized", false])) as { number?: string; timestamp?: string } | null;
      if (!head || typeof head.number !== "string") continue;
      const finalized = Number(BigInt(head.number));
      // The range is fixed by the FIRST answering provider so every provider
      // is asked the same question; a later provider whose finalized head is
      // behind the range simply cannot agree, and the cycle waits.
      if (fromBlock === 0) {
        const start = wallet.last_block !== null
          ? wallet.last_block + 1
          : Math.max(1, finalized - Math.floor((now() - wallet.earliest_created_at) / 1000 / BASE_BLOCK_SECONDS) - OBSERVER_START_MARGIN_BLOCKS);
        fromBlock = start;
        toBlock = Math.min(finalized, start + blocksPerCycleCapped(env) - 1);
        // Every provider is asked for the FIRST page, never the whole stride.
        pageTo = Math.min(toBlock, fromBlock + OBSERVER_BLOCKS_PER_PAGE - 1);
      }
      if (finalized < toBlock) continue;
      if (fromBlock > toBlock) return { wallet: funder, from_block: fromBlock, to_block: toBlock, rows: 0, payments: 0, zero_value: 0, sources: 0, pages: 0 };
      const logs = await getLogs(url, fromBlock, pageTo);
      const answer = { url, finalized, logs };
      const twin = answers.find((a) => logsAgree(a.logs, logs));
      answers.push(answer);
      if (twin) {
        agreed = [twin, answer];
        break;
      }
    } catch (e) {
      lastError = String(e).slice(0, 120);
    }
  }
  if (!agreed) {
    // last_block stays NULL for a wallet never walked, so the start rule still
    // applies next cycle; on conflict only updated_at and last_error move.
    await env.DB.prepare(
      `INSERT INTO observer_marks (funder_address, last_block, updated_at, last_error) VALUES (?, NULL, ?, ?)
       ON CONFLICT(funder_address) DO UPDATE SET updated_at = excluded.updated_at, last_error = excluded.last_error`,
    )
      .bind(funder, now(), `no two providers agreed over ${pageTo - fromBlock + 1} blocks (${answers.length} answered)${lastError ? ": " + lastError : ""}`)
      .run();
    return { wallet: funder, from_block: fromBlock, to_block: pageTo, rows: 0, payments: 0, zero_value: 0, sources: answers.length, pages: 0, error: "no two providers agreed" };
  }

  // The rest of the stride, one OBSERVER_BLOCKS_PER_PAGE page at a time, asked
  // of the SAME two providers that agreed on page one. Each page has to agree
  // on its own: the two-operator rule is per range, not per cycle.
  //
  // PARTIAL PROGRESS IS KEPT. A page that is refused, or on which the two
  // disagree, ends the walk here rather than discarding the pages behind it.
  // That is the difference from the old one-question cycle, where a single 429
  // cost the whole stride: the mark now advances to the last block two
  // operators actually agreed on, and the next cycle resumes from there.
  const pageLogs: TransferLog[] = [...agreed[1]!.logs];
  let walkedTo = pageTo;
  let pages = 1;
  let partial = "";
  while (walkedTo < toBlock && pageLogs.length < OBSERVER_MAX_ROWS_PER_CYCLE) {
    const from = walkedTo + 1;
    const to = Math.min(toBlock, from + OBSERVER_BLOCKS_PER_PAGE - 1);
    let both: TransferLog[][];
    try {
      both = [await getLogs(agreed[0]!.url, from, to), await getLogs(agreed[1]!.url, from, to)];
    } catch (e) {
      partial = `page ${from}-${to} threw: ${String(e).slice(0, 100)}`;
      break;
    }
    if (!logsAgree(both[0]!, both[1]!)) {
      partial = `page ${from}-${to}: the two providers disagreed`;
      break;
    }
    // Pages are contiguous, ascending and disjoint, and parseTransferLogs
    // already sorts within a page, so the concatenation is globally ordered
    // and the cap below still cuts at a real boundary.
    pageLogs.push(...both[1]!);
    walkedTo = to;
    pages++;
  }

  const logs = pageLogs.slice(0, OBSERVER_MAX_ROWS_PER_CYCLE);
  // A page cut at the cap advances only to the last block fully covered, so
  // nothing in a partially read block is skipped.
  const coveredTo = logs.length === OBSERVER_MAX_ROWS_PER_CYCLE ? logs[logs.length - 1]!.block_number - 1 : walkedTo;
  const index = await bindingIndexFor(env, funder);
  let payments = 0;
  let zero = 0;
  const stamp = now();
  const covered = logs.filter((l) => l.block_number <= coveredTo);
  // ONE BATCH: every row and the mark commit together, or nothing does. A
  // cycle cut off mid-write (subrequest budget, a D1 hiccup) then leaves the
  // mark where it was and the next cycle re-walks the same range, which the
  // UNIQUE (tx_hash, log_index) makes idempotent. Counted before the batch
  // from what the table does not yet hold, since OR IGNORE reports no change.
  // D1 binds at most 100 parameters per statement, so the already-held check
  // runs in chunks; a page of 200 rows would otherwise throw before the batch.
  const held = new Set<string>();
  for (let i = 0; i < covered.length; i += 80) {
    const chunk = covered.slice(i, i + 80);
    const { results: heldRows } = await env.DB.prepare(`SELECT tx_hash, log_index FROM observed_transfers WHERE tx_hash IN (${chunk.map(() => "?").join(",")})`)
      .bind(...chunk.map((l) => l.tx_hash))
      .all<{ tx_hash: string; log_index: number }>();
    for (const r of heldRows) held.add(`${r.tx_hash}:${r.log_index}`);
  }
  const statements = covered.map((t) => {
    const c = classifyTransfer(t, index);
    if (!held.has(`${t.tx_hash}:${t.log_index}`)) {
      if (c.kind === "payment") payments++;
      if (c.kind === "zero_value") zero++;
    }
    return env.DB.prepare(
      `INSERT OR IGNORE INTO observed_transfers (funder_address, to_address, token, amount_atomic, tx_hash, log_index, block_number, kind, binding_id, listing_id, citizen_id, sources, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2, ?)`,
    ).bind(funder, t.to, t.token, t.amount_atomic, t.tx_hash, t.log_index, t.block_number, c.kind, c.binding_id, c.listing_id, c.citizen_id, stamp);
  });
  statements.push(
    env.DB.prepare(
      // last_error carries the partial reason when the stride was cut short.
      // A short walk is still progress and still writes its rows, so the mark
      // says BOTH how far it got and why it stopped rather than reading as a
      // clean full cycle.
      `INSERT INTO observer_marks (funder_address, last_block, updated_at, last_error, last_range_from, last_range_to, last_range_rows) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(funder_address) DO UPDATE SET last_block = excluded.last_block, updated_at = excluded.updated_at, last_error = excluded.last_error,
         last_range_from = excluded.last_range_from, last_range_to = excluded.last_range_to, last_range_rows = excluded.last_range_rows`,
    ).bind(funder, coveredTo, stamp, partial || null, fromBlock, coveredTo, covered.length),
  );
  await env.DB.batch(statements);
  return { wallet: funder, from_block: fromBlock, to_block: coveredTo, rows: covered.length, payments, zero_value: zero, sources: 2, pages, ...(partial ? { partial } : {}) };
}

// What the read surfaces serve. Kept here so every page that mentions an
// observed payment describes it the same way.
export const OBSERVED_PAYMENT_NOTE =
  "An observed payment is a USDC or 1F916 transfer this registry read off Base, from the wallet this listing names as its funder to an address a citizen bound on it, for exactly the bound amount and asset, where that address, amount and asset match a binding on no other listing of the same funder, returned identically by two providers in the registry's pool and behind the finalized head. It is not a receipt: nobody signed a statement about it, and it does not say which submission it was for. A transfer to a bound address for some other amount, or one that could belong to more than one of the funder's listings, is recorded against the citizen only, credited to no listing. A listing that names no funder wallet is never walked and serves null here, not zero. It is served so that money that moved is never invisible because a form was not filed.";
