// Settlement v2: what a listing can ever cost, and who is actually entitled.
//
// The rail this sits on could already price work, route a payout and prove a
// transfer. What it could not do was say how much a listing could ever cost
// its funder, or record that anyone was ENTITLED to anything. So the only
// numbers it published were "147 bindings, 5 receipts", and a reader with no
// third number reached for the obvious one and got 142 debts. There were no
// debts. A binding is a routing record and always was (payouts.ts, and the
// note served on GET /api/payouts). The missing layer was this one.
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE
//
//   remaining liability is NEVER remaining_awards * award_amount
//
// because an award that has been made and not yet paid is money the funder
// owes AND a slot that is already gone. Collapsing capacity into money is the
// single arithmetic error that reintroduces the whole problem, so the two are
// carried as separate fields all the way to the wire and are never summed
// into one number without the third being served beside them.

import { SocietyError } from "./society.ts";

// ---------- modes ----------

// What, if anything, stands behind the money.
//
// The words matter more than usual here. PROMISE and VERIFIED funds are NOT
// locked, escrowed or reserved, and nothing in this file, on the wire, or in
// any note may say they are. VERIFIED means one thing only: a balance was READ
// at a point in time. The wallet is free to spend it the next second.
export const FUNDING_MODES = ["promise", "verified", "funded"] as const;
export type FundingMode = (typeof FUNDING_MODES)[number];

// Who decides that a submission is entitled to an award.
export const SETTLEMENT_MODES = ["automatic", "requester", "verifier"] as const;
export type SettlementMode = (typeof SETTLEMENT_MODES)[number];

export const FUNDING_MODE_NOTE =
  "promise: the funder has committed nothing; their settlement history is the only thing standing behind it. verified: this registry read the named wallet's balance at a point in time and it covered the listing's maximum liability at that instant; the funds are NOT reserved, NOT locked and NOT escrowed, and the wallet may move them the next second. funded: the listing's maximum liability is committed through a settlement adapter, and committed_atomic below says how much and which adapter holds it.";

export const SETTLEMENT_MODE_NOTE =
  "automatic: this registry evaluates a narrow declared check against state it can read itself, and no one judges the work. requester: the funder accepts a submission, under the silence policy declared at posting time. verifier: a citizen who holds a verifier binding on this listing signs a pass or fail. The registry is not a judge in any mode: in automatic it runs a check the funder wrote down before the work, and in the other two it records a named party's decision.";

// ---------- the award state machine ----------
//
// SUBMITTED is deliberately not a state in this table. A submission with no
// award row is a submission and nothing more, which is the distinction the old
// rail could not draw and the reason bindings read as debts.
//
//   (no row)  --award-->  awarded  --condition met-->  payable  --receipt-->  paid
//                            |                            |
//                            +---------- ttl lapses ------+--> expired (slot reopens)
//
// expired is the ONLY transition that returns capacity, and it happens only
// under award_ttl_seconds, which the funder declares before any work is done.
// A listing that closes does not reopen slots: closing ends the listing, and
// an outstanding award stays outstanding.
export const AWARD_STATES = ["awarded", "payable", "paid", "expired"] as const;
export type AwardState = (typeof AWARD_STATES)[number];

const AWARD_TRANSITIONS: Record<AwardState, readonly AwardState[]> = {
  awarded: ["payable", "expired"],
  payable: ["paid", "expired"],
  paid: [],
  expired: [],
};

export function assertAwardTransition(from: AwardState, to: AwardState): void {
  if (!AWARD_TRANSITIONS[from].includes(to))
    throw new SocietyError(409, `an award in state ${from} cannot become ${to}; ${from === "paid" ? "a paid award is final and cannot be paid twice" : `the reachable states from ${from} are ${AWARD_TRANSITIONS[from].join(", ") || "none"}`}`);
}

// The state of one SUBMISSION, which is what a reader actually asks about.
// Derived, never stored: storing it would let it disagree with the award rows.
export type SubmissionState = "submitted" | "awarded" | "payable" | "paid" | "not_selected" | "expired";

export function submissionState(input: {
  award: { state: AwardState } | null;
  listingClosed: boolean;
}): SubmissionState {
  if (input.award === null) return input.listingClosed ? "not_selected" : "submitted";
  // An expired award returned its slot; the submission is back to being work
  // nobody selected, and saying "expired" tells the reader which of the two
  // happened. Never "paid" and never "awarded": both would be false.
  return input.award.state === "expired" ? "expired" : input.award.state;
}

export const SUBMISSION_STATE_NOTE =
  "submitted: handed in, no award, no entitlement, and no liability of any kind. awarded: an award slot is consumed and this amount is outstanding. payable: the declared settlement condition is satisfied and release may be called. paid: a payout receipt is joined to this award. not_selected: the listing closed without awarding this submission, which is not a judgment of the work. expired: an award was made and lapsed unpaid under the listing's declared award_ttl_seconds, returning its slot. A submission is never money owed; only an award in state awarded or payable is.";

// ---------- the arithmetic ----------

export interface AwardRow {
  state: AwardState;
  amount_atomic: string;
}

export interface ListingEconomicsInput {
  settlement_version: number;
  amount_atomic: string;
  max_awards: number;
  awards: readonly AwardRow[];
  // open for new awards: not expired, not withdrawn, not moderated
  open: boolean;
}

export interface ListingEconomics {
  settlement_version: number;
  award_amount_atomic: string | null;
  max_awards: number | null;
  max_liability_atomic: string | null;
  awarded_slots_used: number | null;
  available_award_capacity: number | null;
  amount_paid_atomic: string;
  outstanding_awarded_atomic: string;
  maximum_remaining_liability_atomic: string | null;
  note: string;
}

const V1_NOTE =
  "This listing was posted before settlement v2 and carries no award ledger and no declared award cap, so this registry does not know what its maximum liability was and will not invent one: max_liability_atomic, max_awards and available_award_capacity are null rather than guessed. amount_paid_atomic counts receipts joined to awards, and a v1 listing has no awards, so it is 0 here even where money moved; the payment record for these listings is the bindings and receipts below, exactly where it always was. Nothing about a v1 listing is a debt.";

const V2_NOTE =
  "Three separate quantities, and the separation is the point. available_award_capacity is how many awards this listing may still make. outstanding_awarded_atomic is money already awarded and not yet paid. maximum_remaining_liability_atomic is the sum of the two: outstanding plus capacity times the award amount. Do NOT compute remaining liability as available_award_capacity times award_amount: that omits awards already made, which is how an awarded-but-unpaid slot disappears from the books. Submissions and payout bindings appear in NEITHER: a submission is work handed in and a binding is a routing record, and no number of either changes what this listing can cost.";

export function listingEconomics(input: ListingEconomicsInput): ListingEconomics {
  const paid = sumAtomic(input.awards.filter((a) => a.state === "paid"));
  // Outstanding is awarded + payable. Not paid (money moved), not expired
  // (the award lapsed and the slot came back).
  const outstanding = sumAtomic(input.awards.filter((a) => a.state === "awarded" || a.state === "payable"));
  // Anything that is not literally 2 or more is treated as v1 and publishes
  // nulls. A missing or malformed version must fail SAFE, because the unsafe
  // direction here is inventing a cap and a liability for a listing whose
  // funder declared neither.
  if (!(Number(input.settlement_version) >= 2)) {
    return {
      settlement_version: input.settlement_version,
      award_amount_atomic: null,
      max_awards: null,
      max_liability_atomic: null,
      awarded_slots_used: null,
      available_award_capacity: null,
      amount_paid_atomic: paid.toString(),
      outstanding_awarded_atomic: outstanding.toString(),
      maximum_remaining_liability_atomic: null,
      note: V1_NOTE,
    };
  }
  const award = BigInt(input.amount_atomic);
  const maxLiability = award * BigInt(input.max_awards);
  // A slot is consumed by any award that has not expired. expired is the only
  // state that gives one back.
  const slotsUsed = input.awards.filter((a) => a.state !== "expired").length;
  // A closed listing offers no capacity. Its outstanding awards remain
  // outstanding: closing the listing does not cancel what was already awarded.
  const capacity = input.open ? Math.max(0, input.max_awards - slotsUsed) : 0;
  const remaining = outstanding + BigInt(capacity) * award;
  return {
    settlement_version: input.settlement_version,
    award_amount_atomic: input.amount_atomic,
    max_awards: input.max_awards,
    max_liability_atomic: maxLiability.toString(),
    awarded_slots_used: slotsUsed,
    available_award_capacity: capacity,
    amount_paid_atomic: paid.toString(),
    outstanding_awarded_atomic: outstanding.toString(),
    maximum_remaining_liability_atomic: remaining.toString(),
    note: V2_NOTE,
  };
}

function sumAtomic(rows: readonly AwardRow[]): bigint {
  let total = 0n;
  for (const r of rows) total += BigInt(r.amount_atomic);
  return total;
}

// The invariant a reader is entitled to assume, checked rather than asserted.
// paid + maximum remaining can never exceed the declared maximum liability. If
// it ever does, the listing is over-awarded and the arithmetic is lying.
export function assertLiabilityInvariant(e: ListingEconomics): void {
  if (e.maximum_remaining_liability_atomic === null || e.max_liability_atomic === null) return;
  const total = BigInt(e.amount_paid_atomic) + BigInt(e.maximum_remaining_liability_atomic);
  if (total > BigInt(e.max_liability_atomic))
    throw new SocietyError(500, `liability invariant violated: paid ${e.amount_paid_atomic} plus maximum remaining ${e.maximum_remaining_liability_atomic} exceeds the declared maximum ${e.max_liability_atomic}`);
}

// ---------- exhaustion ----------

export interface ExhaustionInput {
  settlement_version: number;
  max_awards: number;
  awards: readonly AwardRow[];
  open: boolean;
}

// Why a new award cannot be made, or null when it can. Returned as a reason
// string so the refusal names the gate rather than a bare 409.
export function awardRefusal(input: ExhaustionInput): string | null {
  if (!(Number(input.settlement_version) >= 2))
    return "this listing was posted before settlement v2 and has no award ledger; awards cannot be made against it and nothing about it is a debt";
  if (!input.open) return "the listing is closed (expired, withdrawn or moderated) and closed listings make no new awards";
  const slotsUsed = input.awards.filter((a) => a.state !== "expired").length;
  if (slotsUsed >= input.max_awards)
    return `the listing is exhausted: all ${input.max_awards} award slots are consumed, so a further submission cannot become payable and cannot create another ${input.max_awards === 0 ? "" : "award of "}liability`;
  return null;
}

// ---------- posting-time validation ----------

export const MAX_AWARDS_CAP = 100;
// The silence policy a requester-settled listing carries when its funder names
// none. Seven days, and with award_on_timeout false it resolves a silent
// submission to not_selected: no award, no liability, and the silence itself
// stays visible on the funder's record.
export const DEFAULT_REQUESTER_TIMEOUT_SECONDS = 7 * 24 * 3600;

export interface SettlementInput {
  max_awards?: unknown;
  funding_mode?: unknown;
  settlement_mode?: unknown;
  automatic_check?: unknown;
  requester_timeout_seconds?: unknown;
  award_on_timeout?: unknown;
  award_ttl_seconds?: unknown;
}

export interface ValidatedSettlement {
  maxAwards: number;
  fundingMode: FundingMode;
  settlementMode: SettlementMode;
  automaticCheck: AutomaticCheck | null;
  requesterTimeoutSeconds: number | null;
  awardOnTimeout: boolean;
  awardTtlSeconds: number | null;
  settlementVersion: 2;
}

export function validateSettlement(body: SettlementInput): ValidatedSettlement {
  const maxAwards = body.max_awards === undefined ? 1 : Number(body.max_awards);
  if (!Number.isSafeInteger(maxAwards) || maxAwards < 1 || maxAwards > MAX_AWARDS_CAP)
    throw new SocietyError(400, `max_awards must be a whole number from 1 to ${MAX_AWARDS_CAP}: how many times this listing may ever pay its award amount. It is the cap on what the listing can cost, so it is required to be finite.`);
  const fundingMode = body.funding_mode === undefined ? "promise" : String(body.funding_mode);
  if (!(FUNDING_MODES as readonly string[]).includes(fundingMode))
    throw new SocietyError(400, `funding_mode must be one of ${FUNDING_MODES.join(", ")}`);
  const settlementMode = body.settlement_mode === undefined ? "requester" : String(body.settlement_mode);
  if (!(SETTLEMENT_MODES as readonly string[]).includes(settlementMode))
    throw new SocietyError(400, `settlement_mode must be one of ${SETTLEMENT_MODES.join(", ")}`);

  let automaticCheck: AutomaticCheck | null = null;
  if (settlementMode === "automatic") {
    if (body.automatic_check === undefined || body.automatic_check === null)
      throw new SocietyError(400, "settlement_mode automatic needs an automatic_check: the registry will only evaluate a check written down before the work, against state it can read itself");
    automaticCheck = validateAutomaticCheck(body.automatic_check);
  } else if (body.automatic_check !== undefined && body.automatic_check !== null) {
    throw new SocietyError(400, "automatic_check is only meaningful with settlement_mode automatic");
  }

  let requesterTimeoutSeconds: number | null = null;
  let awardOnTimeout = false;
  if (settlementMode === "requester") {
    // Declared, never absent, and never a NEW REQUIRED FIELD. A silence policy
    // that a funder had to supply would break every existing client of POST
    // /api/listings on the day it shipped, and the rail's default answer to
    // silence is not a matter of taste: with award_on_timeout false, silence
    // closes the submission as not_selected and creates no liability, which is
    // what the old rail already did in practice and never said out loud.
    requesterTimeoutSeconds = body.requester_timeout_seconds === undefined || body.requester_timeout_seconds === null
      ? DEFAULT_REQUESTER_TIMEOUT_SECONDS
      : Number(body.requester_timeout_seconds);
    if (!Number.isSafeInteger(requesterTimeoutSeconds) || requesterTimeoutSeconds < 3600 || requesterTimeoutSeconds > 30 * 24 * 3600)
      throw new SocietyError(400, "requester_timeout_seconds must be a whole number of seconds from 3600 (one hour) to 2592000 (30 days)");
    awardOnTimeout = body.award_on_timeout === true;
    // The one rule that keeps silence-resolution from manufacturing the exact
    // phantom liability this whole change exists to abolish. On a promise
    // listing nothing is committed, so an automatic award on silence would
    // create a debt out of a funder's inattention and put this registry in the
    // position of having decided it. Only a funded listing, where the money is
    // already committed and release does not need the funder, may do that.
    if (awardOnTimeout && fundingMode !== "funded")
      throw new SocietyError(400, "award_on_timeout is allowed only on a funded listing: on a promise or verified listing an automatic award on silence would create a liability nobody committed to, which is the defect this rail is removing. Set funding_mode funded, or leave award_on_timeout false and let silence close the submission as not_selected.");
  } else if (body.requester_timeout_seconds !== undefined && body.requester_timeout_seconds !== null) {
    throw new SocietyError(400, "requester_timeout_seconds is only meaningful with settlement_mode requester");
  }

  let awardTtlSeconds: number | null = null;
  if (body.award_ttl_seconds !== undefined && body.award_ttl_seconds !== null) {
    awardTtlSeconds = Number(body.award_ttl_seconds);
    if (!Number.isSafeInteger(awardTtlSeconds) || awardTtlSeconds < 3600 || awardTtlSeconds > 30 * 24 * 3600)
      throw new SocietyError(400, "award_ttl_seconds, when given, must be a whole number of seconds from 3600 (one hour) to 2592000 (30 days): how long an award may sit unpaid before its slot reopens");
  }
  return { maxAwards, fundingMode: fundingMode as FundingMode, settlementMode: settlementMode as SettlementMode, automaticCheck, requesterTimeoutSeconds, awardOnTimeout, awardTtlSeconds, settlementVersion: 2 };
}

// ---------- the automatic check, kept deliberately tiny ----------
//
// One kind, and the registry refuses every other. The constraint is not
// caution for its own sake: an automatic check is the registry deciding that
// money is owed, so it may only ever read state this registry itself holds and
// can re-read identically tomorrow. No network, no oracle, no model, no
// judgment of quality. If a check cannot be settled by a SELECT, it does not
// belong in this mode, and the funder should use verifier or requester.
export const AUTOMATIC_CHECK_KINDS = ["comment_artifact_contains"] as const;
export type AutomaticCheckKind = (typeof AUTOMATIC_CHECK_KINDS)[number];

export interface AutomaticCheck {
  kind: AutomaticCheckKind;
  // The exact string the submitted comment must contain, verbatim. Declared by
  // the funder at posting time and hashed into the listing payload, so it
  // cannot be changed after the work is done.
  expect: string;
}

export const AUTOMATIC_CHECK_NOTE =
  "comment_artifact_contains is the only automatic check this registry evaluates. The submission's artifact must be this registry's own https://<origin>/api/comment/<id> URL; the comment must exist, be unmoderated, be authored by the submitting citizen, and contain the listing's declared expect string verbatim. Every one of those is a row this registry already holds, so the check is a SELECT and returns the same verdict for anyone who re-runs it. It judges reproduction, never quality. Any other kind is refused at posting time rather than approximated.";

export function validateAutomaticCheck(value: unknown): AutomaticCheck {
  const raw = typeof value === "string" ? safeJson(value) : value;
  if (raw === null || typeof raw !== "object") throw new SocietyError(400, "automatic_check must be an object");
  const kind = String((raw as Record<string, unknown>).kind ?? "");
  if (!(AUTOMATIC_CHECK_KINDS as readonly string[]).includes(kind))
    throw new SocietyError(400, `automatic_check.kind must be one of ${AUTOMATIC_CHECK_KINDS.join(", ")}. ${AUTOMATIC_CHECK_NOTE}`);
  const expect = (raw as Record<string, unknown>).expect;
  if (typeof expect !== "string" || expect.trim().length < 8 || expect.length > 200)
    throw new SocietyError(400, "automatic_check.expect must be 8 to 200 characters: the exact string a re-runner must publish, chosen so that publishing it means the work was actually done");
  return { kind: kind as AutomaticCheckKind, expect };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new SocietyError(400, "automatic_check must be valid JSON");
  }
}

// The evaluation itself, as a pure function over rows the caller has already
// read. Pure so it is testable without a database and so the same inputs
// always give the same verdict.
export interface ArtifactComment {
  id: number;
  citizen_id: number;
  body: string;
  mod_state: string | null;
}

export function evaluateAutomaticCheck(input: {
  check: AutomaticCheck;
  artifact: string;
  submitterId: number;
  comment: ArtifactComment | null;
}): { pass: boolean; reason: string } {
  const id = commentIdFromArtifact(input.artifact);
  if (id === null)
    return { pass: false, reason: "the artifact is not this registry's own /api/comment/<id> URL, which is the only artifact an automatic check can read" };
  if (input.comment === null) return { pass: false, reason: `comment ${id} does not exist in this registry` };
  if (input.comment.mod_state !== null) return { pass: false, reason: `comment ${id} is ${input.comment.mod_state} by moderation` };
  if (input.comment.citizen_id !== input.submitterId)
    return { pass: false, reason: `comment ${id} was written by another citizen; a submission's artifact has to be the submitter's own work` };
  if (!input.comment.body.includes(input.check.expect))
    return { pass: false, reason: `comment ${id} does not contain the string this listing declared before the work began` };
  return { pass: true, reason: `comment ${id} exists, is unmoderated, was written by the submitter, and contains the declared string` };
}

// Accepts the artifact URL form the rail already requires (a full URL, because
// the artifact field refuses anything under eight characters, so a bare cN was
// never usable here).
export function commentIdFromArtifact(artifact: string): number | null {
  const m = artifact.trim().match(/^https?:\/\/[^\s/]+\/api\/comment\/([1-9][0-9]{0,15})$/);
  return m ? Number(m[1]) : null;
}

// ---------- the settlement adapter ----------
//
// The application state machine above must not know how money is custodied.
// PROMISE uses no adapter at all. VERIFIED uses the existing proof-of-funds
// read and still has no adapter, because reading a balance commits nothing.
// FUNDED uses one of these.
export interface SettlementAdapter {
  readonly name: string;
  // Commit maxLiability for a listing. Returns an external reference the
  // adapter can later resolve.
  fund(listingId: number, amountAtomic: string): Promise<{ externalRef: string }>;
  // What is committed and not yet released or refunded.
  fundedBalance(listingId: number): Promise<string>;
  // Release one award's amount to a destination. MUST be idempotent per award:
  // called twice with the same awardId it releases once.
  release(listingId: number, awardId: number, amountAtomic: string, toAddress: string): Promise<{ externalRef: string; alreadyReleased: boolean }>;
  // Return whatever is still committed once the listing can make no further
  // awards. Never touches an outstanding award's money.
  refundUnused(listingId: number): Promise<{ refundedAtomic: string }>;
}

// Where the production half actually stands. Served on the rail so nobody
// reads "funded" as a promise this registry cannot keep.
export const ADAPTER_STATUS =
  "The only settlement adapter that exists is 'mock', which moves no money and holds none: it is an in-memory ledger used by this registry's tests to exercise the state machine end to end. There is no deployed contract, and this Worker holds no key that can spend from any wallet, by design (the treasury key lives nowhere near this code). So a funded listing cannot be created against real money yet, and the rail refuses to record one rather than let 'funded' mean less here than it says. What remains for a real funded listing is named in the same place this text is: a deployed, audited settlement contract with a permissionless release against a signed award, and an adapter that talks to it.";

// The mock. Deliberately in-memory and deliberately not persisted anywhere a
// reader could mistake for a custody record.
export class MockSettlementAdapter implements SettlementAdapter {
  readonly name = "mock";
  private committed = new Map<number, bigint>();
  private released = new Map<number, bigint>();
  private releasedAwards = new Map<number, string>();
  private refunded = new Map<number, bigint>();

  async fund(listingId: number, amountAtomic: string) {
    if (this.committed.has(listingId)) throw new SocietyError(409, `listing ${listingId} is already funded`);
    this.committed.set(listingId, BigInt(amountAtomic));
    return { externalRef: `mock:fund:${listingId}:${amountAtomic}` };
  }

  async fundedBalance(listingId: number) {
    const committed = this.committed.get(listingId) ?? 0n;
    const released = this.released.get(listingId) ?? 0n;
    const refunded = this.refunded.get(listingId) ?? 0n;
    return (committed - released - refunded).toString();
  }

  async release(listingId: number, awardId: number, amountAtomic: string, toAddress: string) {
    const prior = this.releasedAwards.get(awardId);
    // Idempotence is the whole safety property of this method: a retried
    // release must not pay twice. The award id is the idempotency key.
    if (prior !== undefined) return { externalRef: prior, alreadyReleased: true };
    const available = BigInt(await this.fundedBalance(listingId));
    if (available < BigInt(amountAtomic))
      throw new SocietyError(409, `listing ${listingId} has ${available} committed and this release needs ${amountAtomic}`);
    this.released.set(listingId, (this.released.get(listingId) ?? 0n) + BigInt(amountAtomic));
    const ref = `mock:release:${listingId}:${awardId}:${toAddress}`;
    this.releasedAwards.set(awardId, ref);
    return { externalRef: ref, alreadyReleased: false };
  }

  async refundUnused(listingId: number) {
    const balance = BigInt(await this.fundedBalance(listingId));
    this.refunded.set(listingId, (this.refunded.get(listingId) ?? 0n) + balance);
    return { refundedAtomic: balance.toString() };
  }
}
