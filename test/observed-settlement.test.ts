// Paid is observed, not filed (migration 0063): the settler, the paid ping,
// the wallet that rides with the submission, and the rail rings the doorbell.
//
// Guarantees and the mutation that kills each:
// 1. An observed payment matching one worker binding on a requester-settled
//    v2 listing, by a payee who submitted, becomes an award born paid against
//    the observed transfer. Mutation: in settleOneObserved return decline(...)
//    before the INSERT -> "settles" goes red.
// 2. A verifier-settled listing is NEVER settled by payment. Mutation: delete
//    the settlement_mode !== "requester" refusal -> "verifier" goes red.
// 3. A payee with no submission is paid, not awarded. Mutation: delete the
//    `if (!submission)` refusal -> "no submission" goes red (the INSERT would
//    throw on NOT NULL submission_id, but only after a chained event; the test
//    asserts no award AND the note).
// 4. An open award for the payee is CLOSED, not duplicated. Mutation: delete
//    the `if (open)` branch -> "closes" goes red on the UNIQUE(listing_id,
//    submission_id) path returning a decline instead of a paid award.
// 5. A spent listing (max_awards consumed by someone else) is not awarded
//    again. Mutation: drop the COUNT(*) guard from the INSERT -> red.
// 6. A submission carrying `payout` is refused whole when the payout is bad,
//    and nothing is written. Mutation: move validatePayoutBinding below the
//    submission INSERT -> "nothing written" goes red.
// 7. A 'mine' doorbell rings when a rail_events row lands for its citizen.
//    Mutation: delete the rail_events EXISTS clause from MINE_DUE_SQL -> red.
// 8. The paid ping refuses strangers, is idempotent for a known hash, and
//    spends the per-citizen budget only on unknown hashes. Mutation: delete the
//    `if (!isFunder && !bound)` refusal -> "stranger" goes red.
// 9. The schema refuses a paid award with neither settlement fact and one
//    with both. Mutation: drop either CHECK from listing_awards -> red.
// 10. The payout read models (GET /api/payouts, GET /api/payout-bindings/:id)
//    carry the observed settlement beside the receipt slot, as the listing
//    view does. Mutation: drop the observed_transfers join from listPayouts,
//    or the observed query from getPayoutBinding -> "read models" goes red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createSubmission, getPayoutBinding, listPayouts, railEventsFor, railHead, recordPaidPing, settleObservedPayments, SocietyError, type Env } from "../src/society.ts";
import { ringDoorbells } from "../src/doorbell.ts";
import { payoutPreimage } from "../src/payouts.ts";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const FUNDER = "0x3853965505b92bcef5b6a20fcca65c758f76736a";
const PAYEE = "0xd962bf2b962263ab155f55fa0c5fb02252fca5d9";
const tx = (n: number) => "0x" + n.toString(16).padStart(64, "0");

const FUNDER_ID = 1;
const WORKER_ID = 2;
const OTHER_ID = 3;

function makeEnv(opts: { mode?: "requester" | "verifier"; version?: number; maxAwards?: number; submission?: boolean } = {}) {
  const { env, db } = sqliteTestEnv(SCHEMA);
  const nowS = Math.floor(Date.now() / 1000);
  const nowMs = Date.now();
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES
      (1, 'funder', 'm', 'a', 100, 100), (2, 'worker', 'm', 'b', 100, 100), (3, 'other', 'm', 'c', 100, 100);
    INSERT INTO listings (id, citizen_id, title, condition, amount_atomic, chain_id, token, expiry, funder_address, funder_signature, funds_seen_atomic, payload_hash, commit_nonce, created_at, settlement_version, settlement_mode, max_awards)
      VALUES (9, 1, 'bounty', '${"c".repeat(40)}', '500000', 8453, '${USDC}', ${nowS + 86400}, '${FUNDER}', '${"0x" + "1".repeat(130)}', '24000000', 'ph9', 'n9', ${nowMs - 1800000}, ${opts.version ?? 2}, '${opts.mode ?? "requester"}', ${opts.maxAwards ?? 1});
    INSERT INTO payout_bindings (id, citizen_id, docket_id, version, amount_atomic, chain_id, token, payout_address, expiry, wallet_signature, citizen_public_key, citizen_signature, citizen_key_thumbprint, citizen_key_custody, citizen_key_bound_at, authorization_verification, authorization_verified_at, docket_acceptance, docket_updated, docket_snapshot, preimage, authorization_hash, payload_hash, commit_nonce, created_at)
      VALUES (25, 2, 'listing-9', '1f916.payout.v1', '500000', 8453, '${USDC}', '${PAYEE}', ${nowS + 86400}, 'ws', 'pk', 'cs', 'tp', 'self', 1, 'valid-at-binding-event', 1, 'a', '0', '{}', 'pre', 'ah', 'ph25', 'n25', ${nowMs - 1200000});
  `);
  if (opts.submission !== false) {
    db.exec(`INSERT INTO listing_submissions (id, listing_id, citizen_id, artifact, note, payload_hash, commit_nonce, created_at) VALUES (70, 9, 2, 'https://example.test/first', NULL, 'sph70', 'sn70', ${nowMs - 900000});`);
  }
  return { env, db, nowMs };
}

// A transfer inside the binding's clock unless `at` says otherwise; `at: null`
// leaves the timestamp for the settler to fetch.
function observe(db: ReturnType<typeof makeEnv>["db"], n: number, amount = "500000", to = PAYEE, bindingId: number | null = 25, listingId: number | null = 9, citizenId: number | null = WORKER_ID, at: number | null | undefined = undefined) {
  const ts = at === undefined ? Math.floor(Date.now() / 1000) - 60 : at;
  db.prepare(
    `INSERT INTO observed_transfers (funder_address, to_address, token, amount_atomic, tx_hash, log_index, block_number, kind, binding_id, listing_id, citizen_id, sources, observed_at, block_timestamp)
     VALUES (?, ?, ?, ?, ?, 0, 50979500, 'payment', ?, ?, ?, 2, ?, ?)`,
  ).run(FUNDER, to, USDC, amount, tx(n), bindingId, listingId, citizenId, Date.now(), ts);
  return Number((db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
}

const award = (db: ReturnType<typeof makeEnv>["db"]) => db.prepare("SELECT id, state, submission_id, citizen_id, receipt_id, observed_transfer_id, paid_at, payable_at, awarded_by, awarded_by_citizen_id FROM listing_awards ORDER BY id").all() as Array<Record<string, unknown>>;
const settlementRow = (db: ReturnType<typeof makeEnv>["db"], id: number) => db.prepare("SELECT settled_award_id, settlement_checked_at, settlement_note FROM observed_transfers WHERE id = ?").get(id) as { settled_award_id: number | null; settlement_checked_at: number | null; settlement_note: string | null };

test("an exact observed payment on a requester-settled listing settles: award born paid against the observed transfer, latest submission, funder as decider", async () => {
  const { env, db, nowMs } = makeEnv();
  // A later resubmission: the funder paid for the fix, so the award names it.
  db.exec(`INSERT INTO listing_submissions (id, listing_id, citizen_id, artifact, note, payload_hash, commit_nonce, created_at) VALUES (71, 9, 2, 'https://example.test/fixed', NULL, 'sph71', 'sn71', ${nowMs - 600000});`);
  const otId = observe(db, 1);
  const out = await settleObservedPayments(env, nowMs);
  assert.deepEqual(out, { checked: 1, settled: 1, created: 1, closed: 0, declined: 0, deferred: 0 });
  const rows = award(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.state, "paid");
  assert.equal(rows[0]!.submission_id, 71, "the LATEST submission is what the funder paid for");
  assert.equal(rows[0]!.observed_transfer_id, otId);
  assert.equal(rows[0]!.receipt_id, null);
  assert.equal(rows[0]!.awarded_by, "requester");
  assert.equal(rows[0]!.awarded_by_citizen_id, FUNDER_ID, "the funder decided, by paying");
  assert.ok(rows[0]!.paid_at !== null && rows[0]!.payable_at !== null);
  const s = settlementRow(db, otId);
  assert.equal(s.settled_award_id, rows[0]!.id);
  assert.ok(s.settlement_checked_at !== null);
  // Chained evidence: an award event and no bare row.
  const events = db.prepare("SELECT kind, detail FROM identity_events WHERE citizen_id = 2 ORDER BY id").all() as Array<{ kind: string; detail: string }>;
  assert.ok(events.some((e) => e.kind === "listing-award" && /awarded BY PAYMENT/.test(e.detail)), "the chained event says the award came from the payment");
  // The rail told the payee, twice: payment.observed and award.paid (plus award.created).
  const rail = await railEventsFor(env, { id: WORKER_ID, handle: "worker" } as never, 0);
  assert.deepEqual(rail.events.map((e) => e.kind), ["award.created", "award.paid", "payment.observed"]);
  // A second cycle finds nothing: the row is checked.
  assert.deepEqual(await settleObservedPayments(env, nowMs + 1), { checked: 0, settled: 0, created: 0, closed: 0, declined: 0, deferred: 0 });
});

test("a verifier-settled listing is never settled by payment; the row stays an observed payment with the reason", async () => {
  const { env, db, nowMs } = makeEnv({ mode: "verifier" });
  const otId = observe(db, 2);
  const out = await settleObservedPayments(env, nowMs);
  assert.equal(out.declined, 1);
  assert.equal(award(db).length, 0, "no award on a verifier listing without a verifier's signature");
  assert.match(settlementRow(db, otId).settlement_note ?? "", /verifier mode/);
});

test("a settlement-version-1 listing has no ledger to write", async () => {
  const { env, db, nowMs } = makeEnv({ version: 1 });
  const otId = observe(db, 3);
  await settleObservedPayments(env, nowMs);
  assert.equal(award(db).length, 0);
  assert.match(settlementRow(db, otId).settlement_note ?? "", /predates settlement v2/);
});

test("a payee with no submission is paid, not awarded", async () => {
  const { env, db, nowMs } = makeEnv({ submission: false });
  const otId = observe(db, 4);
  await settleObservedPayments(env, nowMs);
  assert.equal(award(db).length, 0);
  assert.match(settlementRow(db, otId).settlement_note ?? "", /no submission/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM identity_events WHERE kind = 'listing-award'").get()!.n, 0, "no chained award event either");
});

test("an open award for the payee is closed by the observed transfer, not duplicated", async () => {
  const { env, db, nowMs } = makeEnv();
  db.exec(`INSERT INTO listing_awards (id, listing_id, submission_id, citizen_id, amount_atomic, state, awarded_by, awarded_by_citizen_id, awarded_at, payable_at, payload_hash, commit_nonce, created_at)
           VALUES (5, 9, 70, 2, '500000', 'payable', 'requester', 1, ${nowMs - 100000}, ${nowMs - 100000}, 'aph5', 'an5', ${nowMs - 100000});`);
  const otId = observe(db, 5);
  const out = await settleObservedPayments(env, nowMs);
  assert.deepEqual(out, { checked: 1, settled: 1, created: 0, closed: 1, declined: 0, deferred: 0 });
  const rows = award(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, 5);
  assert.equal(rows[0]!.state, "paid");
  assert.equal(rows[0]!.observed_transfer_id, otId);
  assert.ok(db.prepare("SELECT 1 FROM identity_events WHERE kind = 'listing-award-transition' AND detail LIKE '%system:observer%'").get(), "the transition is chained and names the observer as its source");
});

test("a listing whose award slots are spent by someone else is not awarded again; paid, not awarded", async () => {
  const { env, db, nowMs } = makeEnv();
  db.exec(`INSERT INTO listing_submissions (id, listing_id, citizen_id, artifact, note, payload_hash, commit_nonce, created_at) VALUES (72, 9, 3, 'https://example.test/other', NULL, 'sph72', 'sn72', ${nowMs - 500000});
           INSERT INTO listing_awards (id, listing_id, submission_id, citizen_id, amount_atomic, state, awarded_by, awarded_by_citizen_id, awarded_at, payable_at, payload_hash, commit_nonce, created_at)
           VALUES (6, 9, 72, 3, '500000', 'payable', 'requester', 1, ${nowMs - 100000}, ${nowMs - 100000}, 'aph6', 'an6', ${nowMs - 100000});`);
  const otId = observe(db, 6);
  const out = await settleObservedPayments(env, nowMs);
  assert.equal(out.declined, 1);
  assert.equal(award(db).length, 1, "the other citizen's award is the only one");
  assert.match(settlementRow(db, otId).settlement_note ?? "", /no free award slot/);
});

test("the ledger refuses a paid award with no settlement fact, and one with two", () => {
  const { db, nowMs } = makeEnv();
  const otId = observe(db, 7);
  db.exec("INSERT INTO payout_receipts (id, binding_id, submitter_id, tx_hash, transfer_log_index, source_address, transaction_sender, block_number, block_hash, block_timestamp, finalized_block_number, confirmations_at_recording, funder_address, funder_statement, funder_signature, funder_attestation_hash, payload_hash, checked_at, created_at, funding_relationship) VALUES (3, 25, 2, '" + tx(8) + "', 0, '" + FUNDER + "', '" + FUNDER + "', 1, '" + tx(9) + "', 1, 20, 19, '" + FUNDER + "', '1f916.payout-funder.v1:x', '" + "0x" + "a".repeat(130) + "', '" + "b".repeat(64) + "', 'rph3', 1, 1, 'independent')");
  const insert = (receipt: number | null, observed: number | null) =>
    db.prepare(`INSERT INTO listing_awards (listing_id, submission_id, citizen_id, amount_atomic, state, awarded_by, awarded_by_citizen_id, awarded_at, payable_at, receipt_id, observed_transfer_id, paid_at, payload_hash, commit_nonce, created_at)
                VALUES (9, 70, 2, '500000', 'paid', 'requester', 1, ?, ?, ?, ?, ?, ?, ?, ?)`).run(nowMs, nowMs, receipt, observed, nowMs, "p" + Math.random(), "n" + Math.random(), nowMs);
  assert.throws(() => insert(null, null), /CHECK/, "paid with no fact");
  assert.throws(() => insert(3, otId), /CHECK/, "paid with both facts");
  insert(null, otId);
  assert.equal(award(db).length, 1);
});

test("a submission carrying a bad payout is refused whole and nothing is written; a missing payout is reported, not refused", async () => {
  const { env, db } = makeEnv({ submission: false });
  const worker = { id: WORKER_ID, handle: "worker" } as never;
  await assert.rejects(
    createSubmission(env, worker, 9, { artifact: "https://example.test/work", payout: { address: PAYEE, expiry: Math.floor(Date.now() / 1000) + 3600, citizen_public_key: "nope", citizen_signature: "nope", signature: "0x" + "1".repeat(130) } }),
    (e: unknown) => e instanceof SocietyError && e.status === 400 && /payout refused, nothing recorded/.test(e.message),
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM listing_submissions").get()!.n, 0, "the submission was not written either");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM identity_events").get()!.n, 0, "and nothing was chained");
  await assert.rejects(createSubmission(env, worker, 9, { artifact: "https://example.test/work", payout: "not-an-object" }), /payout must be an object/);
  const ok = await createSubmission(env, worker, 9, { artifact: "https://example.test/work" });
  assert.equal(ok.submitted, true);
  assert.equal((ok.payout_binding as { filed: boolean }).filed, false);
  assert.match(String((ok.payout_binding as { note: string }).note), /No payout was sent/);
  // The funder heard about it.
  const rail = await railEventsFor(env, { id: FUNDER_ID, handle: "funder" } as never, 0);
  assert.deepEqual(rail.events.map((e) => [e.kind, e.ref_id]), [["submission.received", ok.id]]);
});

test("a 'mine' doorbell rings when the rail moves for its citizen, and stays silent for someone else's rail", async () => {
  const { env, db } = makeEnv();
  const nowMs = Date.now();
  db.exec(`
    INSERT INTO doorbells (citizen_id, url, status, challenge, last_event_id, created_at, verification_version, last_challenge_at, wake_on, last_listing_id, last_mention_id, last_rail_id)
      VALUES (2, 'https://worker.example/hook', 'active', 'ch', 0, ${nowMs}, 1, 0, 'mine', 0, 0, 0);
  `);
  const originalFetch = globalThis.fetch;
  let rings = 0;
  globalThis.fetch = (async () => { rings++; return new Response("", { status: 200 }); }) as typeof fetch;
  try {
    const ring = async () => ringDoorbells(env, 1, async () => "sig", "key", 0, 0, await railHead(env));
    assert.equal(await railHead(env), 0, "an empty stream has mark 0, not null");
    assert.deepEqual(await ring(), { due: 0, rung: 0, failed: 0, disabled: 0 }, "nothing on the rail: silent");
    db.exec(`INSERT INTO rail_events (citizen_id, kind, listing_id, ref_id, amount_atomic, token, created_at) VALUES (3, 'award.paid', 9, 1, '500000', '${USDC}', ${nowMs})`);
    assert.deepEqual(await ring(), { due: 0, rung: 0, failed: 0, disabled: 0 }, "someone else's rail event: silent");
    db.exec(`INSERT INTO rail_events (citizen_id, kind, listing_id, ref_id, amount_atomic, token, created_at) VALUES (2, 'award.paid', 9, 1, '500000', '${USDC}', ${nowMs})`);
    assert.deepEqual(await ring(), { due: 1, rung: 1, failed: 0, disabled: 0 }, "my rail event: ring");
    assert.equal(rings, 1);
    assert.deepEqual(await ring(), { due: 0, rung: 0, failed: 0, disabled: 0 }, "the rail mark advanced with the ring");
    assert.equal(db.prepare("SELECT last_rail_id FROM doorbells WHERE citizen_id = 2").get()!.last_rail_id, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the paid ping: strangers are refused, a known hash is free and idempotent, an unknown one spends budget and reads the chain", async () => {
  const { env, db, nowMs } = makeEnv();
  const funder = { id: FUNDER_ID, handle: "funder" } as never;
  const worker = { id: WORKER_ID, handle: "worker" } as never;
  const stranger = { id: OTHER_ID, handle: "other" } as never;
  await assert.rejects(recordPaidPing(env, stranger, 9, { tx_hash: tx(10) }), (e: unknown) => e instanceof SocietyError && e.status === 403);
  await assert.rejects(recordPaidPing(env, funder, 9, { tx_hash: "nope" }), /tx_hash must be/);
  // Unknown hash: the observer is asked, once, with the listing's funder wallet.
  const asked: string[] = [];
  const observeFake = async (_env: Env, funderAddress: string, txHash: string) => {
    asked.push(`${funderAddress}:${txHash}`);
    observe(db, 11);
    return { tx_hash: txHash, block_number: 1, transfers: [{ token: USDC, from: FUNDER, to: PAYEE, amount_atomic: "500000", tx_hash: txHash, log_index: 0, block_number: 1 }], rows_written: 1, payments: 1, sources: 2 };
  };
  const out = await recordPaidPing(env, funder, 9, { tx_hash: tx(11) }, { observe: observeFake });
  assert.deepEqual(asked, [`${FUNDER}:${tx(11)}`]);
  assert.equal(out.settled_here.length, 1, "the settler ran and closed it in the same call");
  assert.equal(award(db)[0]!.state, "paid");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM paid_pings").get()!.n, 1);
  // Known hash: no observer call, no budget spent, same answer.
  const again = await recordPaidPing(env, worker, 9, { tx_hash: tx(11) }, { observe: async () => { throw new Error("must not be called"); } });
  assert.equal(again.settled_here.length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM paid_pings").get()!.n, 1, "a known transaction costs no budget");
  // A transaction with no transfer from the funder wallet is refused with the reason.
  await assert.rejects(
    recordPaidPing(env, funder, 9, { tx_hash: tx(12) }, { observe: async (_e, _f, h) => ({ tx_hash: h, block_number: 1, transfers: [], rows_written: 0, payments: 0, sources: 2 }) }),
    /carries no USDC or 1F916 transfer FROM the listing's funder wallet/,
  );
  // Budget: the tenth unknown hash is refused.
  for (let i = 0; i < 8; i++) {
    await recordPaidPing(env, funder, 9, { tx_hash: tx(20 + i) }, { observe: async (_e, _f, h) => ({ tx_hash: h, block_number: 1, transfers: [{ token: USDC, from: FUNDER, to: PAYEE, amount_atomic: "1", tx_hash: h, log_index: 0, block_number: 1 }], rows_written: 0, payments: 0, sources: 2 }) });
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM paid_pings").get()!.n, 10);
  await assert.rejects(recordPaidPing(env, funder, 9, { tx_hash: tx(40) }, { observe: async () => { throw new Error("must not be called"); } }), (e: unknown) => e instanceof SocietyError && e.status === 429);
  void nowMs;
});

// 10. The prose a worker reads after submitting is emitted from the same
//     branch as the settlement regime. Mutation: replace `settledByPayment`
//     in createSubmission's `next` with `true` -> the verifier case goes red;
//     drop `settlementVersion` from the ladder condition -> the v1 case goes red.
test("what a worker is told after submitting branches on the listing's settlement regime, in the sentence and in the ladder", async () => {
  const worker = { id: WORKER_ID, handle: "worker" } as never;
  const step5 = (r: Awaited<ReturnType<typeof createSubmission>>) => r.next_actions.find((s) => s.step === 5)!;
  const requester = await createSubmission(makeEnv({ submission: false }).env, worker, 9, { artifact: "https://example.test/work" });
  assert.equal(step5(requester).optional, true, "requester + funder wallet + v2: settlement is automatic, the receipt is optional");
  assert.match(step5(requester).call ?? "", /\/api\/listings\/9\/paid/);
  const verifier = await createSubmission(makeEnv({ mode: "verifier", submission: false }).env, worker, 9, { artifact: "https://example.test/work" });
  assert.equal(step5(verifier).optional, false, "a verifier listing still needs the signed receipt");
  assert.equal(step5(verifier).action, "record_receipt");
  const v1 = await createSubmission(makeEnv({ version: 1, submission: false }).env, worker, 9, { artifact: "https://example.test/work" });
  assert.equal(step5(v1).optional, false, "a v1 listing has no award ledger to settle into");
});

// 11. The binding's clock bounds settlement exactly as it bounds a receipt.
//     Mutation: delete either timestamp refusal in settleOneObserved -> red.
// 12. One transfer settles one award across both facts. Mutation: delete the
//     payout_receipts lookup -> red.
// 13. A citizen is paid once per listing. Mutation: delete the alreadyPaid
//     refusal -> red.
// 14. A row with no timestamp is deferred, never settled on a guess, and
//     settles once two providers answer. Mutation: settle when the fetch
//     throws (drop the `continue`) -> red.
test("a transfer before the binding existed, or after it expired, is paid, not awarded", async () => {
  const early = makeEnv();
  const bindingCreatedS = Math.floor((early.nowMs - 1200000) / 1000);
  const idEarly = observe(early.db, 13, "500000", PAYEE, 25, 9, WORKER_ID, bindingCreatedS - 3600);
  await settleObservedPayments(early.env, early.nowMs);
  assert.equal(award(early.db).length, 0);
  assert.match(settlementRow(early.db, idEarly).settlement_note ?? "", /predates the binding/);
  const late = makeEnv();
  const idLate = observe(late.db, 14, "500000", PAYEE, 25, 9, WORKER_ID, Math.floor(late.nowMs / 1000) + 86400);
  await settleObservedPayments(late.env, late.nowMs);
  assert.equal(award(late.db).length, 0);
  assert.match(settlementRow(late.db, idLate).settlement_note ?? "", /after the binding expired/);
});

test("a transfer already recorded as a receipt is not settled a second time by the observer", async () => {
  const { env, db, nowMs } = makeEnv();
  db.exec("INSERT INTO payout_receipts (id, binding_id, submitter_id, tx_hash, transfer_log_index, source_address, transaction_sender, block_number, block_hash, block_timestamp, finalized_block_number, confirmations_at_recording, funder_address, funder_statement, funder_signature, funder_attestation_hash, payload_hash, checked_at, created_at, funding_relationship) VALUES (4, 25, 2, '" + tx(15) + "', 0, '" + FUNDER + "', '" + FUNDER + "', 1, '" + tx(16) + "', 1, 20, 19, '" + FUNDER + "', '1f916.payout-funder.v1:y', '" + "0x" + "c".repeat(130) + "', '" + "d".repeat(64) + "', 'rph4', 1, 1, 'independent')");
  db.exec(`INSERT INTO listing_awards (id, listing_id, submission_id, citizen_id, amount_atomic, state, awarded_by, awarded_by_citizen_id, awarded_at, payable_at, receipt_id, paid_at, payload_hash, commit_nonce, created_at)
           VALUES (7, 9, 70, 2, '500000', 'paid', 'requester', 1, ${nowMs - 100000}, ${nowMs - 100000}, 4, ${nowMs - 90000}, 'aph7', 'an7', ${nowMs - 100000});
           INSERT INTO listing_submissions (id, listing_id, citizen_id, artifact, note, payload_hash, commit_nonce, created_at) VALUES (73, 9, 2, 'https://example.test/again', NULL, 'sph73', 'sn73', ${nowMs - 50000});`);
  const otId = observe(db, 15);
  const out = await settleObservedPayments(env, nowMs);
  assert.equal(out.declined, 1);
  assert.equal(award(db).length, 1, "the receipt-settled award is the only one");
  assert.match(settlementRow(db, otId).settlement_note ?? "", /already recorded as receipt 4/);
});

test("pay, resubmit, pay again: the second payment is a payment and not a second award", async () => {
  const { env, db, nowMs } = makeEnv();
  observe(db, 17);
  await settleObservedPayments(env, nowMs);
  assert.equal(award(db).length, 1);
  db.exec(`INSERT INTO listing_submissions (id, listing_id, citizen_id, artifact, note, payload_hash, commit_nonce, created_at) VALUES (74, 9, 2, 'https://example.test/v2', NULL, 'sph74', 'sn74', ${nowMs - 1000});`);
  const second = observe(db, 18);
  const out = await settleObservedPayments(env, nowMs + 1);
  assert.equal(out.declined, 1);
  assert.equal(award(db).length, 1);
  assert.match(settlementRow(db, second).settlement_note ?? "", /already holds paid award/);
});

test("a row with no block timestamp is deferred until two providers answer, then settled under the clock", async () => {
  const { env, db, nowMs } = makeEnv();
  const otId = observe(db, 19, "500000", PAYEE, 25, 9, WORKER_ID, null);
  const failing = await settleObservedPayments(env, nowMs, { blockTimestamp: async () => { throw new Error("no two providers agreed"); } });
  assert.deepEqual(failing, { checked: 1, settled: 0, created: 0, closed: 0, declined: 0, deferred: 1 });
  assert.equal(award(db).length, 0);
  assert.equal(settlementRow(db, otId).settlement_checked_at, null, "deferred, not decided");
  let asked = 0;
  const ok = await settleObservedPayments(env, nowMs, { blockTimestamp: async () => { asked++; return Math.floor(nowMs / 1000) - 30; } });
  assert.equal(asked, 1);
  assert.equal(ok.settled, 1);
  assert.equal(db.prepare("SELECT block_timestamp FROM observed_transfers WHERE id = ?").get(otId)!.block_timestamp, Math.floor(nowMs / 1000) - 30, "the fetched timestamp is stored");
});

// 15. The wallet rides with the work, for real: a submission carrying a valid
//     payout (citizen Ed25519 + wallet EIP-191 over the canonical preimage)
//     records both, reports the binding, and says what settles it. When the
//     same address is already bound at this price on another listing of the
//     same funder, the sentence says the observer cannot match a payment and
//     step 5 stops being automatic. Mutation: drop `sameAddressElsewhere` from
//     the ladder condition, or hard-code 0 in createSubmission -> red.
test("submit-with-wallet files the binding in one request, and warns when the address is ambiguous across the funder's listings", async () => {
  const { env, db } = makeEnv({ submission: false });
  db.exec("DELETE FROM payout_bindings");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const b64url = Buffer.from(raw).toString("base64url");
  const thumbprint = createHash("sha256").update(raw).digest("base64url").slice(0, 32);
  db.prepare("INSERT INTO keys (citizen_id, public_key, thumbprint, custody, status, bound_at) VALUES (2, ?, ?, 'self', 'active', 0)").run(b64url, thumbprint);
  const wallet = privateKeyToAccount(generatePrivateKey());
  const address = wallet.address.toLowerCase();
  const expiry = Math.floor(Date.now() / 1000) + 3600;
  const worker = { id: WORKER_ID, handle: "worker" } as never;
  const payoutFor = async (listingId: number) => {
    const preimage = payoutPreimage({ handle: "worker", row: `listing-${listingId}`, amountAtomic: "500000", chainId: 8453, token: USDC, address, expiry });
    return {
      address, expiry, citizen_public_key: b64url,
      citizen_signature: Buffer.from(edSign(null, Buffer.from(preimage), privateKey)).toString("base64url"),
      signature: await wallet.signMessage({ message: preimage }),
    };
  };
  const first = await createSubmission(env, worker, 9, { artifact: "https://example.test/one", payout: await payoutFor(9) });
  assert.equal(first.submitted, true);
  assert.deepEqual({ filed: (first.payout_binding as { filed: boolean }).filed, address: (first.payout_binding as { address: string }).address }, { filed: true, address });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM payout_bindings WHERE citizen_id = 2 AND docket_id = 'listing-9'").get()!.n, 1, "one call, one binding");
  assert.match(String(first.next), /Nothing, provided this address at this price is bound on no other listing/);
  assert.equal(first.next_actions.find((x) => x.step === 5)!.optional, true);
  assert.equal(first.next_actions.find((x) => x.step === 3)!.state, "done");

  // The same funder's second listing at the same price, same address: the
  // observer cannot tell which listing a 500000 transfer is for.
  const nowS = Math.floor(Date.now() / 1000);
  db.exec(`INSERT INTO listings (id, citizen_id, title, condition, amount_atomic, chain_id, token, expiry, funder_address, funder_signature, funds_seen_atomic, payload_hash, commit_nonce, created_at, settlement_version, settlement_mode, max_awards)
    VALUES (10, 1, 'bounty two', '${"d".repeat(40)}', '500000', 8453, '${USDC}', ${nowS + 86400}, '${FUNDER}', '${"0x" + "2".repeat(130)}', '24000000', 'ph10', 'n10', ${Date.now() - 1000}, 2, 'requester', 1);`);
  const second = await createSubmission(env, worker, 10, { artifact: "https://example.test/two", payout: await payoutFor(10) });
  assert.equal((second.payout_binding as { filed: boolean }).filed, true);
  assert.match(String(second.next), /bound at this exact price on 1 other listing\(s\) of this funder/);
  assert.equal(second.next_actions.find((x) => x.step === 5)!.optional, false, "ambiguous address: settlement is not automatic");

  // The same authorization sent twice is reported, not duplicated.
  const again = await createSubmission(env, worker, 10, { artifact: "https://example.test/two-again", payout: await payoutFor(10) });
  assert.equal((again.payout_binding as { already_on_file: boolean }).already_on_file, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM payout_bindings WHERE citizen_id = 2").get()!.n, 2);
});

// 10. Both payout read models serve the observed settlement, so a binding paid
//     by an observed transfer is not served as unreceipted-and-payable while
//     GET /api/listings/:id serves it as paid (larry-synctzn, c68328 on #5873).
test("the payout read models carry the observed settlement beside the receipt slot, as the listing view does", async () => {
  const { env, db, nowMs } = makeEnv();
  const otId = observe(db, 21);
  await settleObservedPayments(env, nowMs);
  const awardId = Number(award(db)[0]!.id);
  const page = await listPayouts(env, "listing-9");
  assert.equal(page.bindings.length, 1);
  const row = page.bindings[0] as Record<string, unknown>;
  assert.equal(row.receipt_id, null, "no receipt was filed");
  assert.equal(row.settled_observed_transfer_id, otId);
  assert.equal(row.settled_award_id, awardId);
  assert.equal(row.observed_tx_hash, tx(21));
  assert.equal(row.observed_source, FUNDER);
  assert.equal(row.observed_block_number, 50979500);
  const record = await getPayoutBinding(env, 25);
  assert.equal(record.receipt, null);
  const settled = record.observed_settlement as Record<string, unknown>;
  assert.ok(settled, "the canonical record names the observed settlement");
  assert.equal(settled.observed_transfer_id, otId);
  assert.equal(settled.award_id, awardId);
  assert.equal(settled.tx_hash, tx(21));
  assert.equal(settled.source_address, FUNDER);
  assert.equal(settled.block_number, 50979500);
});
