// Settlement v2: what a listing can cost, and who is entitled.
//
// The defect these tests exist to make unrepeatable: 147 payout bindings and 5
// receipts, with no third number, read as 142 debts. A binding creates no
// liability, a submission creates no liability, and only an award does. Every
// test below fails if that stops being true.

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
  MockSettlementAdapter,
  assertAwardTransition,
  assertLiabilityInvariant,
  awardRefusal,
  commentIdFromArtifact,
  evaluateAutomaticCheck,
  listingEconomics,
  submissionState,
  validateAutomaticCheck,
  validateSettlement,
} from "../src/settlement.ts";

const DOLLAR = "1000000";

// ---------- the arithmetic, which is the whole point ----------

test("$1 x 3 awards, all three awarded, two paid, reads as capacity 0 and $1 still owed", () => {
  const e = listingEconomics({
    settlement_version: 2,
    amount_atomic: DOLLAR,
    max_awards: 3,
    awards: [{ state: "paid", amount_atomic: DOLLAR }, { state: "paid", amount_atomic: DOLLAR }, { state: "awarded", amount_atomic: DOLLAR }],
    open: true,
  });
  assert.equal(e.max_awards, 3);
  assert.equal(e.max_liability_atomic, "3000000");
  assert.equal(e.awarded_slots_used, 3);
  assert.equal(e.available_award_capacity, 0);
  assert.equal(e.amount_paid_atomic, "2000000");
  assert.equal(e.outstanding_awarded_atomic, "1000000");
  // The number the naive formula gets wrong. remaining_awards * award_amount
  // would be 0 here, and $1 is genuinely still owed.
  assert.equal(e.maximum_remaining_liability_atomic, "1000000");
  assert.notEqual(e.maximum_remaining_liability_atomic, String(Number(e.available_award_capacity) * Number(DOLLAR)));
  assertLiabilityInvariant(e);
});

test("capacity and money are separate: unawarded capacity is liability too", () => {
  const e = listingEconomics({
    settlement_version: 2, amount_atomic: DOLLAR, max_awards: 3,
    awards: [{ state: "awarded", amount_atomic: DOLLAR }],
    open: true,
  });
  assert.equal(e.available_award_capacity, 2, "one slot consumed of three");
  assert.equal(e.outstanding_awarded_atomic, "1000000", "the awarded slot is owed");
  assert.equal(e.maximum_remaining_liability_atomic, "3000000", "outstanding $1 plus two uncommitted slots at $1");
  assertLiabilityInvariant(e);
});

test("a $5 x 1 listing can never exceed $5 of liability no matter how many submissions or bindings exist", () => {
  // 100 submissions and 80 bindings are not represented in this input at all,
  // which is the structural answer to the whole complaint: they cannot change
  // the arithmetic because they are not part of it.
  const e = listingEconomics({
    settlement_version: 2, amount_atomic: "5000000", max_awards: 1,
    awards: [], open: true,
  });
  assert.equal(e.max_liability_atomic, "5000000");
  assert.equal(e.maximum_remaining_liability_atomic, "5000000");
  assert.equal(e.outstanding_awarded_atomic, "0");
  assert.equal(e.amount_paid_atomic, "0");
});

test("an expired award returns its slot and stops being owed; a closed listing offers no capacity", () => {
  const lapsed = listingEconomics({
    settlement_version: 2, amount_atomic: DOLLAR, max_awards: 2,
    awards: [{ state: "expired", amount_atomic: DOLLAR }], open: true,
  });
  assert.equal(lapsed.awarded_slots_used, 0, "an expired award consumes no slot");
  assert.equal(lapsed.outstanding_awarded_atomic, "0", "an expired award is not owed");
  assert.equal(lapsed.available_award_capacity, 2);

  const closed = listingEconomics({
    settlement_version: 2, amount_atomic: DOLLAR, max_awards: 3,
    awards: [{ state: "awarded", amount_atomic: DOLLAR }], open: false,
  });
  assert.equal(closed.available_award_capacity, 0, "a closed listing makes no new awards");
  assert.equal(closed.outstanding_awarded_atomic, "1000000", "but closing does not cancel an award already made");
  assert.equal(closed.maximum_remaining_liability_atomic, "1000000");
});

test("a listing posted before settlement v2 publishes nulls, never an invented cap, and is never a debt", () => {
  const e = listingEconomics({ settlement_version: 1, amount_atomic: DOLLAR, max_awards: 1, awards: [], open: true });
  assert.equal(e.max_liability_atomic, null);
  assert.equal(e.max_awards, null);
  assert.equal(e.available_award_capacity, null);
  assert.equal(e.maximum_remaining_liability_atomic, null);
  assert.equal(e.outstanding_awarded_atomic, "0", "no awards exist on a v1 listing, so nothing is outstanding");
  assert.match(e.note, /Nothing about a v1 listing is a debt/);
  assert.equal(awardRefusal({ settlement_version: 1, max_awards: 1, awards: [], open: true })?.includes("no award ledger"), true);
});

// ---------- submission states ----------

test("a submission with no award is submitted, and submitted is not owed", () => {
  assert.equal(submissionState({ award: null, listingClosed: false }), "submitted");
  assert.equal(submissionState({ award: null, listingClosed: true }), "not_selected");
  assert.equal(submissionState({ award: { state: "awarded" }, listingClosed: false }), "awarded");
  assert.equal(submissionState({ award: { state: "payable" }, listingClosed: false }), "payable");
  assert.equal(submissionState({ award: { state: "paid" }, listingClosed: true }), "paid");
  assert.equal(submissionState({ award: { state: "expired" }, listingClosed: false }), "expired");
});

test("the award state machine refuses to pay the same award twice", () => {
  assertAwardTransition("awarded", "payable");
  assertAwardTransition("payable", "paid");
  assert.throws(() => assertAwardTransition("paid", "paid"), /cannot be paid twice/);
  assert.throws(() => assertAwardTransition("paid", "payable"), /cannot become payable/);
  assert.throws(() => assertAwardTransition("expired", "paid"), /cannot become paid/);
});

// ---------- exhaustion ----------

test("exhaustion refuses a further award and says so in money terms", () => {
  const full = { settlement_version: 2, max_awards: 3, awards: [{ state: "paid" as const, amount_atomic: DOLLAR }, { state: "paid" as const, amount_atomic: DOLLAR }, { state: "awarded" as const, amount_atomic: DOLLAR }], open: true };
  assert.match(awardRefusal(full) ?? "", /exhausted/);
  assert.equal(awardRefusal({ ...full, awards: full.awards.slice(0, 2) }), null);
  assert.match(awardRefusal({ ...full, awards: [], open: false }) ?? "", /closed/);
});

// ---------- posting-time validation ----------

test("validateSettlement requires a finite cap and refuses silence-awards on unfunded listings", () => {
  const ok = validateSettlement({ max_awards: 3, funding_mode: "promise", settlement_mode: "requester", requester_timeout_seconds: 86400 });
  assert.equal(ok.maxAwards, 3);
  assert.equal(ok.settlementVersion, 2);
  assert.throws(() => validateSettlement({ max_awards: 0 }), /max_awards must be/);
  assert.throws(() => validateSettlement({ max_awards: 101 }), /max_awards must be/);
  assert.throws(() => validateSettlement({ settlement_mode: "automatic" }), /needs an automatic_check/);
  // A silence policy is always declared, and never a new required field:
  // making it mandatory would have broken every existing caller of POST /api/listings.
  assert.equal(validateSettlement({ settlement_mode: "requester" }).requesterTimeoutSeconds, 7 * 24 * 3600);
  assert.equal(validateSettlement({}).awardOnTimeout, false, "the default silence policy creates no liability");
  // The rule that stops silence-resolution from manufacturing a phantom debt.
  assert.throws(
    () => validateSettlement({ settlement_mode: "requester", requester_timeout_seconds: 86400, award_on_timeout: true, funding_mode: "promise" }),
    /allowed only on a funded listing/,
  );
});

test("the automatic check is narrow by construction and refuses any other kind", () => {
  const check = validateAutomaticCheck({ kind: "comment_artifact_contains", expect: "REPRODUCED-7f3a" });
  assert.equal(check.kind, "comment_artifact_contains");
  assert.throws(() => validateAutomaticCheck({ kind: "model_judges_quality", expect: "good work" }), /must be one of/);
  assert.throws(() => validateAutomaticCheck({ kind: "comment_artifact_contains", expect: "short" }), /8 to 200 characters/);
});

test("the automatic check reads only this registry's own rows, and every failure mode refuses the award", () => {
  const check = { kind: "comment_artifact_contains" as const, expect: "REPRODUCED-7f3a" };
  const base = { check, artifact: "https://1f916.ai/api/comment/34880", submitterId: 42 };
  const good = { id: 34880, citizen_id: 42, body: "I re-ran it. REPRODUCED-7f3a", mod_state: null };
  assert.equal(evaluateAutomaticCheck({ ...base, comment: good }).pass, true);
  assert.equal(evaluateAutomaticCheck({ ...base, comment: null }).pass, false);
  assert.equal(evaluateAutomaticCheck({ ...base, comment: { ...good, citizen_id: 43 } }).pass, false, "another citizen's comment is not this submitter's work");
  assert.equal(evaluateAutomaticCheck({ ...base, comment: { ...good, mod_state: "collapsed" } }).pass, false);
  assert.equal(evaluateAutomaticCheck({ ...base, comment: { ...good, body: "I re-ran it and it worked" } }).pass, false, "the declared string is absent");
  assert.equal(evaluateAutomaticCheck({ ...base, artifact: "https://example.com/proof", comment: good }).pass, false, "an off-registry artifact cannot be checked");
  assert.equal(commentIdFromArtifact("https://1f916.ai/api/comment/34880"), 34880);
  assert.equal(commentIdFromArtifact("c34880"), null);
});

// ---------- the settlement adapter ----------

test("the mock adapter releases once per award however many times release is called", async () => {
  const a = new MockSettlementAdapter();
  await a.fund(7, "3000000");
  assert.equal(await a.fundedBalance(7), "3000000");
  const first = await a.release(7, 101, DOLLAR, "0xabc");
  assert.equal(first.alreadyReleased, false);
  const second = await a.release(7, 101, DOLLAR, "0xabc");
  assert.equal(second.alreadyReleased, true, "a retried release must not pay twice");
  assert.equal(second.externalRef, first.externalRef);
  assert.equal(await a.fundedBalance(7), "2000000", "one release, not two");
  await a.release(7, 102, DOLLAR, "0xdef");
  await a.release(7, 103, DOLLAR, "0xghi");
  assert.equal(await a.fundedBalance(7), "0");
  await assert.rejects(() => a.release(7, 104, DOLLAR, "0xjkl"), /has 0 committed/);
});

test("refundUnused returns what is still committed and never an outstanding award's money", async () => {
  const a = new MockSettlementAdapter();
  await a.fund(9, "3000000");
  await a.release(9, 201, DOLLAR, "0xabc");
  const refund = await a.refundUnused(9);
  assert.equal(refund.refundedAtomic, "2000000");
  assert.equal(await a.fundedBalance(9), "0");
});

// ---------- the schema itself ----------

test("the award ledger cannot record two awards for one submission or two awards against one receipt", () => {
  const db = new DatabaseSync(":memory:");
  const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
  // The real DDL, with only the referenced tables stubbed so the CHECKs and
  // UNIQUEs under test are the ones production actually has.
  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec(schema.slice(schema.indexOf("CREATE TABLE IF NOT EXISTS listing_awards"), schema.indexOf("CREATE INDEX IF NOT EXISTS idx_listing_awards_listing")));
  const insert = (submissionId: number, receiptId: number | null, nonce: string) =>
    db.prepare(
      `INSERT INTO listing_awards (listing_id, submission_id, citizen_id, amount_atomic, state, awarded_by, awarded_at, receipt_id, paid_at, payload_hash, commit_nonce, created_at)
       VALUES (1, ?, 2, '1000000', ?, 'requester', 0, ?, ?, ?, ?, 0)`,
    ).run(submissionId, receiptId === null ? "awarded" : "paid", receiptId, receiptId === null ? null : 1, "h" + nonce, nonce);
  insert(1, null, "n1");
  assert.throws(() => insert(1, null, "n2"), /UNIQUE/, "one award per submission");
  insert(2, 500, "n3");
  assert.throws(() => insert(3, 500, "n4"), /UNIQUE/, "one receipt settles one award");
});

test("the paid state cannot exist without a receipt, and a receipt cannot exist without the paid state", () => {
  const db = new DatabaseSync(":memory:");
  const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
  // The real DDL, with only the referenced tables stubbed so the CHECKs and
  // UNIQUEs under test are the ones production actually has.
  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec(schema.slice(schema.indexOf("CREATE TABLE IF NOT EXISTS listing_awards"), schema.indexOf("CREATE INDEX IF NOT EXISTS idx_listing_awards_listing")));
  const row = (state: string, receiptId: number | null, paidAt: number | null, nonce: string) =>
    db.prepare(
      `INSERT INTO listing_awards (listing_id, submission_id, citizen_id, amount_atomic, state, awarded_by, awarded_at, receipt_id, paid_at, payload_hash, commit_nonce, created_at)
       VALUES (1, ?, 2, '1000000', ?, 'requester', 0, ?, ?, ?, ?, 0)`,
    ).run(Math.floor(Math.random() * 1e9), state, receiptId, paidAt, "h" + nonce, nonce);
  assert.throws(() => row("paid", null, 1, "p1"), /CHECK/, "paid with no receipt is not representable");
  assert.throws(() => row("awarded", 9, null, "p2"), /CHECK/, "a receipt on an unpaid award is not representable");
  assert.throws(() => row("paid", 9, null, "p3"), /CHECK/, "paid with no paid_at is not representable");
});
