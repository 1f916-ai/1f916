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
  consumesSlot,
  isOutstanding,
  lapseStateFor,
  submissionState,
  validateAutomaticCheck,
  validateSettlement,
  wasEverPayable,
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

test("the two expirations are different economic facts, and only one returns a slot", () => {
  // A reserved seat nobody delivered on: nothing was earned, seat comes back.
  const unmet = listingEconomics({
    settlement_version: 2, amount_atomic: DOLLAR, max_awards: 2,
    awards: [{ state: "expired_unmet", amount_atomic: DOLLAR }], open: true,
  });
  assert.equal(unmet.awarded_slots_used, 0, "an unmet seat consumes no slot");
  assert.equal(unmet.outstanding_awarded_atomic, "0", "nothing was earned, so nothing is owed");
  assert.equal(unmet.expired_unclaimed_atomic, "0", "and nothing was earned-then-unclaimed");
  assert.equal(unmet.available_award_capacity, 2, "the seat is back on the market");

  // An entitlement that WAS earned and went unclaimed: the money stops being
  // owed, the slot stays spent, and the fact is reported on its own line.
  const unclaimed = listingEconomics({
    settlement_version: 2, amount_atomic: DOLLAR, max_awards: 2,
    awards: [{ state: "expired_unclaimed", amount_atomic: DOLLAR }], open: true,
  });
  assert.equal(unclaimed.awarded_slots_used, 1, "an earned entitlement keeps its slot; the work was accepted");
  assert.equal(unclaimed.available_award_capacity, 1);
  assert.equal(unclaimed.outstanding_awarded_atomic, "0", "past its declared claim window it is no longer owed");
  assert.equal(unclaimed.expired_unclaimed_atomic, DOLLAR, "and it is never invisible: it has its own line");
  assert.notEqual(unclaimed.expired_unclaimed_atomic, unmet.expired_unclaimed_atomic, "the two expiries can never be read as the same fact");

  const lapsed = unmet;

  const closed = listingEconomics({
    settlement_version: 2, amount_atomic: DOLLAR, max_awards: 3,
    awards: [{ state: "awarded", amount_atomic: DOLLAR }], open: false,
  });
  assert.equal(closed.available_award_capacity, 0, "a closed listing makes no new awards");
  assert.equal(closed.outstanding_awarded_atomic, "1000000", "but closing does not cancel an award already made");
  assert.equal(closed.maximum_remaining_liability_atomic, "1000000");
});

test("a listing posted before settlement v2 publishes nulls, never an invented cap, and never a verdict on its history", () => {
  const e = listingEconomics({ settlement_version: 1, amount_atomic: DOLLAR, max_awards: 1, awards: [], open: true });
  assert.equal(e.max_liability_atomic, null);
  assert.equal(e.max_awards, null);
  assert.equal(e.available_award_capacity, null);
  assert.equal(e.maximum_remaining_liability_atomic, null);
  assert.equal(e.outstanding_awarded_atomic, "0", "no awards exist on a v1 listing, so nothing is outstanding");
  // And the zero says what kind of zero it is. An empty ledger is not an
  // audit finding, and the note must not let a reader turn it into one.
  assert.match(e.note, /NOT DERIVABLE/);
  assert.match(e.note, /UNKNOWN TO THIS REGISTRY rather than zero/);
  assert.match(e.note, /makes no claim in either direction/);
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
  assert.throws(() => assertAwardTransition("expired_unclaimed", "paid"), /cannot become paid/);
  assert.throws(() => assertAwardTransition("expired_unmet", "payable"), /cannot become payable/);
  // A reserved seat can only ever lapse unmet; an entitlement can only ever
  // lapse unclaimed. No caller gets to choose the flattering one.
  assert.equal(lapseStateFor("awarded"), "expired_unmet");
  assert.equal(lapseStateFor("payable"), "expired_unclaimed");
  assert.throws(() => lapseStateFor("paid"), /does not lapse/);
});

test("an expired entitlement is never reported as not-selected, and its earning is permanent", () => {
  // The failure this exists to prevent: an expiry rewriting history into
  // "they were never chosen".
  assert.equal(submissionState({ award: { state: "expired_unclaimed" }, listingClosed: true }), "expired_unclaimed");
  assert.equal(submissionState({ award: { state: "expired_unmet" }, listingClosed: true }), "expired_unmet");
  assert.notEqual(submissionState({ award: { state: "expired_unclaimed" }, listingClosed: true }), "not_selected");
  // not_selected means one thing: no award was ever made.
  assert.equal(submissionState({ award: null, listingClosed: true }), "not_selected");
  // And the entitlement is readable off the row forever, in either direction.
  assert.equal(wasEverPayable({ state: "expired_unclaimed", payable_at: 1 }), true);
  assert.equal(wasEverPayable({ state: "paid", payable_at: 1 }), true);
  assert.equal(wasEverPayable({ state: "expired_unmet", payable_at: null }), false, "a seat that lapsed unmet never earned anything");
  assert.equal(consumesSlot("expired_unclaimed"), true);
  assert.equal(consumesSlot("expired_unmet"), false);
  assert.equal(isOutstanding("expired_unclaimed"), false, "past the declared window it is not still owed");
});

test("the four clocks are separate terms, and a claim window is refused where nothing can wait", () => {
  const full = validateSettlement({
    max_awards: 1, settlement_mode: "requester", submission_deadline: Math.floor(Date.now() / 1000) + 3600,
    award_ttl_seconds: 6 * 3600, payable_ttl_seconds: 30 * 24 * 3600, requester_timeout_seconds: 48 * 3600,
  });
  assert.equal(full.awardTtlSeconds, 6 * 3600, "how long a reserved seat may sit unmet");
  assert.equal(full.payableTtlSeconds, 30 * 24 * 3600, "how long an earned entitlement stays claimable");
  assert.equal(full.requesterTimeoutSeconds, 48 * 3600, "how long the requester has to decide");
  assert.ok(full.submissionDeadline, "and by when work may be handed in");
  // A claim window on a listing that pays the instant the check passes is a
  // clock on an instant: refused rather than stored and ignored.
  assert.throws(
    () => validateSettlement({ funding_mode: "funded", settlement_mode: "automatic", automatic_check: { kind: "comment_artifact_contains", expect: "REPRODUCED-7f3a" }, payable_ttl_seconds: 3600 }),
    /does not apply to a funded automatic listing/,
  );
  // A submission deadline cannot outlive the listing it is on.
  const now = Math.floor(Date.now() / 1000);
  assert.throws(() => validateSettlement({ submission_deadline: now + 7200 }, now + 3600, now), /after the listing's own expiry/);
});

// ---------- exhaustion ----------

test("exhaustion refuses a further award and says so in money terms", () => {
  const full = { settlement_version: 2, max_awards: 3, awards: [{ state: "paid" as const, amount_atomic: DOLLAR }, { state: "paid" as const, amount_atomic: DOLLAR }, { state: "awarded" as const, amount_atomic: DOLLAR }], open: true };
  // An exhausted listing stays exhausted when one of its awards was earned and
  // went unclaimed: that seat is spent, and re-selling it would pay twice for
  // one accepted piece of work.
  assert.match(awardRefusal({ ...full, awards: [{ state: "expired_unclaimed" as const, amount_atomic: DOLLAR }, { state: "paid" as const, amount_atomic: DOLLAR }, { state: "paid" as const, amount_atomic: DOLLAR }] }) ?? "", /exhausted/);
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
      `INSERT INTO listing_awards (listing_id, submission_id, citizen_id, amount_atomic, state, awarded_by, awarded_at, payable_at, receipt_id, paid_at, payload_hash, commit_nonce, created_at)
       VALUES (1, ?, 2, '1000000', ?, 'requester', 0, ?, ?, ?, ?, ?, 0)`,
    ).run(submissionId, receiptId === null ? "awarded" : "paid", receiptId === null ? null : 1, receiptId, receiptId === null ? null : 1, "h" + nonce, nonce);
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
      `INSERT INTO listing_awards (listing_id, submission_id, citizen_id, amount_atomic, state, awarded_by, awarded_at, payable_at, receipt_id, paid_at, payload_hash, commit_nonce, created_at)
       VALUES (1, ?, 2, '1000000', ?, 'requester', 0, 1, ?, ?, ?, ?, 0)`,
    ).run(Math.floor(Math.random() * 1e9), state, receiptId, paidAt, "h" + nonce, nonce);
  assert.throws(() => row("paid", null, 1, "p1"), /CHECK/, "paid with no receipt is not representable");
  assert.throws(() => row("awarded", 9, null, "p2"), /CHECK/, "a receipt on an unpaid award is not representable");
  assert.throws(() => row("paid", 9, null, "p3"), /CHECK/, "paid with no paid_at is not representable");
});

test("an erased earning is not a bug to catch, it is a row the database refuses to hold", () => {
  const db = new DatabaseSync(":memory:");
  const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec(schema.slice(schema.indexOf("CREATE TABLE IF NOT EXISTS listing_awards"), schema.indexOf("CREATE INDEX IF NOT EXISTS idx_listing_awards_listing")));
  const insert = (state: string, payableAt: number | null, expiredAt: number | null, nonce: string) =>
    db.prepare(
      `INSERT INTO listing_awards (listing_id, submission_id, citizen_id, amount_atomic, state, awarded_by, awarded_at, payable_at, expired_at, payload_hash, commit_nonce, created_at)
       VALUES (1, ?, 2, '1000000', ?, 'requester', 0, ?, ?, ?, ?, 0)`,
    ).run(Math.floor(Math.random() * 1e9), state, payableAt, expiredAt, "h" + nonce, nonce);

  // The states that mean "this citizen earned it" cannot exist without the
  // moment they earned it. An expiry can end the obligation; it cannot make
  // the earning unrepresentable-in-reverse.
  assert.throws(() => insert("payable", null, null, "e1"), /CHECK/, "payable with no payable_at");
  assert.throws(() => insert("expired_unclaimed", null, 1, "e2"), /CHECK/, "an unclaimed entitlement that forgot it was ever earned");
  // And the reverse dressing-up is refused too.
  assert.throws(() => insert("expired_unmet", 5, 1, "e3"), /CHECK/, "an unmet seat cannot carry an earning it never had");
  // The retired single state cannot come back by accident.
  assert.throws(() => insert("expired", 5, 1, "e4"), /CHECK/, "'expired' is no longer a state: the two expiries are different facts");
  // Both legitimate rows are held.
  insert("expired_unclaimed", 5, 9, "ok1");
  insert("expired_unmet", null, 9, "ok2");
});

// The pure lapse decision, tested directly. The persisted sweep has its own
// SQL and its own test; this is the read model's copy of the same rule, and
// the first mutation sweep found that nothing exercised it: reverting the
// whole fix left every test green because they all ran the sweep first.
test("the lapse decision asks who could have acted, in both directions", () => {
  // The worker did the one thing only they can do. A missed payment deadline
  // is then the PAYER's, and nothing expires.
  assert.equal(lapseStateFor("payable", true), "overdue_unpaid");
  // The worker never supplied a destination. Their entitlement lapses.
  assert.equal(lapseStateFor("payable", false), "expired_unclaimed");
  // A reserved seat is about the work, not the money: readiness is irrelevant
  // and it lapses unmet either way.
  assert.equal(lapseStateFor("awarded", true), "expired_unmet");
  assert.equal(lapseStateFor("awarded", false), "expired_unmet");
  assert.throws(() => lapseStateFor("paid", true), /does not lapse/);
  assert.throws(() => lapseStateFor("overdue_unpaid", true), /does not lapse/, "an overdue debt has already lapsed as far as it can; it cannot expire");
  // And the two outcomes differ in the only way that matters economically.
  assert.equal(isOutstanding("overdue_unpaid"), true, "still owed");
  assert.equal(isOutstanding("expired_unclaimed"), false);
});
