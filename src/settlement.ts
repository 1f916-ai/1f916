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
import { BASE_CHAIN_ID, BASE_USDC } from "./payouts.ts";

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
  "promise: the funder has committed nothing; their settlement history is the only thing standing behind it. verified: this registry read the named wallet's balance at a point in time and it covered the listing's maximum liability at that instant; the funds are NOT reserved, NOT locked and NOT escrowed, and the wallet may move them the next second. funded: the listing's maximum liability is committed up front. On a settlement_version 3 listing that means an on-chain escrow named in this listing's own hashed terms, and `funding_status` on the listing response carries what the chain actually says: this registry reads it rather than repeating the claim. On the older adapter path it means a settlement adapter, and committed_atomic says how much and which adapter holds it.";

export const SETTLEMENT_MODE_NOTE =
  "Who decides that a submission is entitled to the amount. automatic: this registry evaluates a narrow declared check against state it can read itself, and no one judges the work; on a funded listing the money is released in the same request, which is the FUND -> SUBMIT -> PAID path. requester: the funder accepts, under the silence policy declared at posting time. verifier: a citizen holding a verifier binding filed on this listing before the verdict signs a pass or fail. IN ALL THREE, THE DECISION ITSELF MAKES THE AWARD PAYABLE: a verifier's pass is not a recommendation the funder then confirms, because a listing that declared a verifier and still required the funder to agree would have handed the funder a veto it never declared. The one award that is not born payable is a seat RESERVED before the work, which only a requester-settled listing can do and only when it declared award_ttl_seconds beforehand. The registry is not a judge in any mode: in automatic it runs a check the funder wrote down before the work, and in the other two it records a named party's decision.";

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
export const AWARD_STATES = ["awarded", "payable", "paid", "expired_unmet", "expired_unclaimed", "overdue_unpaid", "verification_failed"] as const;
export type AwardState = (typeof AWARD_STATES)[number];

// The two expirations are DIFFERENT ECONOMIC FACTS and are never one state.
//
//   expired_unmet       a seat was reserved and the condition was never met
//                       within award_ttl_seconds. Nothing was ever earned. The
//                       seat returns to the market, which is the whole point
//                       of reserving one with a clock on it.
//
//   expired_unclaimed   the condition WAS met, the entitlement existed, and it
//                       went unclaimed past the declared claim window. The
//                       money stops being outstanding because the listing said
//                       before the work that it would. The fact that this
//                       citizen earned it does not stop being true, and the
//                       slot does NOT return to the market, because the work
//                       was done and paying someone else for it would be a
//                       second liability for one piece of accepted work.
//
// This distinction is the difference between "they never earned it" and "they
// earned it and did not claim in time", and a rail that cannot tell those
// apart can make an earned obligation disappear by calling it not-selected.
const AWARD_TRANSITIONS: Record<AwardState, readonly AwardState[]> = {
    awarded: ["payable", "expired_unmet"],
  payable: ["paid", "expired_unclaimed", "overdue_unpaid"],
  // An overdue debt is still a debt. The only way out of it is paying, and
  // there is deliberately no path from here to any expiry: a deadline the
  // debtor controls cannot be the thing that cancels what they owe.
  overdue_unpaid: ["paid"],
  paid: [],
  expired_unmet: [],
  expired_unclaimed: [],
  // RESERVED, WITH NO IN-EDGE IN SETTLEMENT V2. Nothing transitions to it and
  // nothing may, which is why the row above for `awarded` does not list it.
  //
  // It exists because I built a verifier FAIL that moved an award here, and it
  // could never run: this state needs an award in `awarded`, only a RESERVED
  // seat is born `awarded`, and only a requester-settled listing may reserve.
  // A verifier listing therefore has no such row to fail. The real semantics
  // turned out cleaner than the diagram I was coding to: a verifier's PASS is
  // what CREATES the award, and a FAIL records a signed verdict and creates
  // nothing, so a failed candidate never consumes a slot and none has to be
  // returned. The state stays in AWARD_STATES and in the schema CHECK as
  // capacity for a future listing type that DOES reserve seats before a
  // verdict (buying attempts rather than outcomes), and removing it would cost
  // a migration to gain nothing. It must not be advertised as a V2 transition.
  verification_failed: [],
};

// Exported so the guard in test/award-proof-chain.test.ts can assert the
// reserved state has no in-edge against THIS table rather than a copy of it
// that could drift from it.
export const AWARD_TRANSITIONS_FOR_TEST: Record<string, readonly string[]> = AWARD_TRANSITIONS;

// THE INVARIANT THAT DECIDES WHICH WAY A DEADLINE FALLS:
//
//   A deadline may extinguish an entitlement only when the party losing the
//   entitlement controls the action required to preserve it.
//
// So a lapsing clock is not one outcome, it is a question about who could
// still have acted. A worker who never supplied a payout destination failed at
// something only they could do, and their entitlement expires. A worker who
// supplied one has done everything available to them, and a funder who then
// lets the deadline pass has not extinguished anything: they are late. That
// second case is a debt, stays a debt, and lands on their record.
//
// Without this, payable_ttl_seconds hands every promise-listing funder a way
// to make an earned obligation disappear by doing nothing, which is the free
// option this rail exists to remove, wearing a clock.
// `workerReadyToBePaid` is LATCHED readiness, not a live lookup: once the
// payee has supplied a valid destination for this award it stays true even if
// that binding later expires or is replaced. A payer does not get the clock
// turned back because the payee changed their global payout settings after
// doing everything asked of them.
export function lapseStateFor(from: AwardState, workerReadyToBePaid: boolean): AwardState {
  if (from === "awarded") return "expired_unmet";
  if (from === "payable") return workerReadyToBePaid ? "overdue_unpaid" : "expired_unclaimed";
  throw new SocietyError(500, `an award in state ${from} does not lapse`);
}

// States that consume an award slot. Both expiries and an overdue debt keep
// theirs: in every one of them the work was accepted, and re-selling the seat
// would pay twice for one accepted piece of work.
//
// verification_failed would also return its seat, and it is reserved rather
// than reachable in V2 (see the transition table above). The rule is not
// "which outcome is nicer", it is whether the declared condition was ever
// satisfied: those are the two states where it demonstrably was not, so
// nothing was earned and the seat belongs back in the market. In every other
// state an entitlement existed at some point, and selling that seat again
// would pay twice for one accepted piece of work.
//
// In V2 a failed verification never reaches this function at all, because a
// verifier FAIL creates no award: the slot is never consumed, so it never has
// to be given back. The line below is kept correct for the day the reserved
// state acquires an in-edge.
export function consumesSlot(state: AwardState): boolean {
  return state !== "expired_unmet" && state !== "verification_failed";
}

// States that are money a funder currently owes. overdue_unpaid is in here on
// purpose and is the whole point of it existing: passing a payment deadline
// does not reduce the liability, it only records that it went unpaid on time.
export function isOutstanding(state: AwardState): boolean {
  return state === "awarded" || state === "payable" || state === "overdue_unpaid";
}

// Was this entitlement ever real? Permanent, and read off the state alone, so
// no read path can lose it.
export function wasEverPayable(award: { state: AwardState; payable_at: number | null }): boolean {
  return award.state !== "awarded" && award.state !== "expired_unmet" ? true : award.payable_at !== null;
}

export function assertAwardTransition(from: AwardState, to: AwardState): void {
  if (!AWARD_TRANSITIONS[from].includes(to))
    throw new SocietyError(409, `an award in state ${from} cannot become ${to}; ${from === "paid" ? "a paid award is final and cannot be paid twice" : `the reachable states from ${from} are ${AWARD_TRANSITIONS[from].join(", ") || "none"}`}`);
}

// The state of one SUBMISSION, which is what a reader actually asks about.
// Derived, never stored: storing it would let it disagree with the award rows.
export type SubmissionState = "submitted" | "awarded" | "payable" | "paid" | "not_selected" | "expired_unmet" | "expired_unclaimed" | "overdue_unpaid" | "verification_failed";

// NOT_SELECTED means one thing only: no award was ever made against this
// submission. A submission that was awarded and lapsed NEVER reads as
// not_selected, in either lapse. Collapsing those would let an expiry rewrite
// history into "they were never chosen", which is the failure this whole
// distinction exists to prevent.
export function submissionState(input: {
  award: { state: AwardState } | null;
  listingClosed: boolean;
}): SubmissionState {
  if (input.award === null) return input.listingClosed ? "not_selected" : "submitted";
  return input.award.state;
}

// WHO IS HOLDING UP SETTLEMENT, answerable from the ledger for any award that
// is owed. Derived, never stored, so it cannot drift from the rows it reads.
export type SettlementBlock = "waiting_for_payee" | "ready_to_pay" | "payer_late" | "payee_route_lapsed" | null;

export function settlementBlock(award: {
  state: AwardState;
  ready_at: number | null;
  live_route: boolean;
}): SettlementBlock {
  if (award.state === "overdue_unpaid") return "payer_late";
  if (award.state !== "payable") return null;
  // EFFECTIVE readiness, the same definition the lapse rule uses: latched, or
  // a live route that has not been written down yet. Two definitions of ready
  // in one codebase is how a read and a write come to disagree about whose
  // fault a missed deadline was.
  if (award.ready_at == null && !award.live_route) return "waiting_for_payee";
  // Latched ready, but the destination they gave has since lapsed or been
  // withdrawn without replacement. The debt and the readiness both stand; this
  // says only that a payer trying to send right now has nowhere to send it.
  // It is reported, never used to rewrite history or reduce a liability.
  return award.live_route ? "ready_to_pay" : "payee_route_lapsed";
}

export const SETTLEMENT_BLOCK_NOTE =
  "Who settlement is waiting on, for an award that is owed. waiting_for_payee: the entitlement exists and the payee has not yet supplied a payout destination, which is the one act only they can take; the payer's clock has not started. ready_to_pay: the payee supplied a valid destination, readiness is latched against this award with the route it named, and the payer's payment deadline is running. payer_late: the deadline passed with the payee ready, so the amount is still owed and the lateness is the payer's. payee_route_lapsed: readiness is latched and the debt stands, and the destination the payee gave has since expired or been replaced, so a payer sending right now has nowhere to send it; this NEVER un-latches readiness, reduces the liability, or saves a payer from becoming overdue. null: nothing is owed on this award.";

export const SUBMISSION_STATE_NOTE =
  "submitted: handed in, no award, no entitlement, no liability of any kind. awarded: a slot is reserved for this citizen and the amount is outstanding, but the declared condition is not satisfied yet. payable: the declared condition IS satisfied and this citizen is entitled to the amount. paid: a payout receipt is joined to the award. not_selected: NO AWARD WAS EVER MADE against this submission and the listing closed, which is not a judgment of the work. expired_unmet: a reserved seat lapsed under the listing's declared award_ttl_seconds without the condition ever being met, so nothing was earned and the seat returned to the market. expired_unclaimed: this citizen WAS entitled to the amount and did not do the one thing only they could do, supply a payout destination, before the claim deadline the listing declared; the entitlement lapsed because of an action they controlled. overdue_unpaid: this citizen WAS entitled to the amount AND supplied a payout destination, so they had done everything available to them, and the payer did not settle by the deadline; THE AMOUNT IS STILL OWED, it stays in outstanding liability, and the missed deadline is on the payer's settlement history rather than the worker's. verification_failed: RESERVED AND NOT PRODUCED BY SETTLEMENT V2. No award transitions to it, because a verifier FAIL creates no award in the first place: the signed FAIL verdict is durable and retrievable, nothing is owed, and no award slot is consumed, so there is no award to move here. It is kept as schema capacity for a future listing type that reserves seats before a verdict. The non-paid outcomes are different economic facts about different parties and none of them is ever reported as not_selected. A submission is never money owed; only an award in state awarded, payable or overdue_unpaid is.";

// The signed verdict artifact. A verifier PASS creates a real liability, so
// the verdict cannot live only as an authenticated API call that left a state
// change behind: it is a portable document a stranger can verify without
// trusting this registry, exactly like a payout binding. FAIL is signed on the
// same terms, because a judgment that only gets recorded when it is favourable
// is not a judgment.
export const VERDICT_HASH_FIELDS = ["listing_id", "submission_id", "verifier", "verdict", "binding_id", "issued_at", "commit_nonce"] as const;

export const VERDICT_PREIMAGE_PREFIX = "1f916.verdict.v1";

// The exact bytes a verifier signs. Built here and served by a pure GET so the
// verifier signs something they fetched rather than something they assembled
// from prose, which is the same rule the payout preimage follows.
// NO SERVER-GENERATED VALUE APPEARS HERE. The first version of this preimage
// included the row's commit_nonce, which this registry mints AFTER the request
// arrives: the verifier could not have signed it, so the signature could never
// have verified and the "required signature" would have been an unreachable
// branch pretending to be a guarantee. Every field below is one the signer
// either chose or can read before signing. commit_nonce still exists and still
// goes into the payload hash for row uniqueness; it is simply not part of what
// a human or agent puts their key to.
export function verdictPreimage(input: {
  listingId: number;
  submissionId: number;
  verifier: string;
  verdict: "pass" | "fail";
  bindingId: number;
  issuedAt: number;
}): string {
  return [
    VERDICT_PREIMAGE_PREFIX,
    input.listingId,
    input.submissionId,
    input.verifier,
    input.verdict,
    input.bindingId,
    input.issuedAt,
  ].join(":");
}

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
  // Earned, became payable, and lapsed unclaimed under the listing's declared
  // claim window. Never money still owed, and never evidence nothing was
  // earned. Its own line so it can be neither.
  expired_unclaimed_atomic: string;
  // Inside outstanding_awarded_atomic, not beside it: an overdue debt is a
  // debt. currently_due_atomic is the rest of it.
  overdue_unpaid_atomic: string;
  currently_due_atomic: string;
  maximum_remaining_liability_atomic: string | null;
  note: string;
}

const V1_NOTE =
  "This listing was posted before settlement v2 and carries no award ledger and no declared award cap, so this registry does not know what its maximum liability was and will not invent one: max_liability_atomic, max_awards and available_award_capacity are null rather than guessed. THE ZEROS ON THE ATOMIC LINES ARE SCOPED TO THE AWARD LEDGER, which for this listing is empty by construction, and they are not a finding that nothing was ever owed here. Liability on a settlement_version 1 listing is NOT DERIVABLE from its payout bindings, because a binding is a routing record that never recorded whether an award was made: whatever obligations existed here are UNKNOWN TO THIS REGISTRY rather than zero. amount_paid_atomic counts receipts joined to awards, and a v1 listing has no awards, so it is 0 here even where money moved; the payment record for these listings is the bindings and receipts below, exactly where it always was. What settlement v2 asserts about this listing is one thing only: it records no explicit v2 liability. It makes no claim in either direction about the history.";

const V2_NOTE =
  "Six separate quantities, and the separation is the point. outstanding_awarded_atomic is everything still owed, and it splits into currently_due_atomic and overdue_unpaid_atomic: overdue is owed AND already past a promised payment deadline, so it is reported apart without ever being deducted, because a payer cannot reduce a debt by missing its deadline. expired_unclaimed_atomic is money that WAS earned and became payable and then lapsed unclaimed under the claim window this listing declared before the work began: it is not still owed, and it is not evidence that nobody earned it. It is reported on its own line so that neither reading is available. available_award_capacity is how many awards this listing may still make. outstanding_awarded_atomic is money already awarded and not yet paid. maximum_remaining_liability_atomic is the sum of the two: outstanding plus capacity times the award amount. Do NOT compute remaining liability as available_award_capacity times award_amount: that omits awards already made, which is how an awarded-but-unpaid slot disappears from the books. Submissions and payout bindings appear in NEITHER: a submission is work handed in and a binding is a routing record, and no number of either changes what this listing can cost.";

export function listingEconomics(input: ListingEconomicsInput): ListingEconomics {
  const paid = sumAtomic(input.awards.filter((a) => a.state === "paid"));
  // Outstanding is awarded + payable + OVERDUE_UNPAID. Not paid (money moved),
  // and not either expiry (the listing said before the work what would end the
  // obligation, and it did). Overdue belongs here and the published derivation
  // must say so: a missed deadline is reported separately but never deducted,
  // or a payer would shrink a debt by ignoring it.
  const outstanding = sumAtomic(input.awards.filter((a) => isOutstanding(a.state)));
  // Earned, and lapsed because the WORKER did not do the one thing they
  // controlled. Its own line: an obligation existed and was extinguished by a
  // declared clock, and neither half may be invisible.
  const expiredUnclaimed = sumAtomic(input.awards.filter((a) => a.state === "expired_unclaimed"));
  // Earned, the worker was ready, and the PAYER missed the deadline. Still
  // owed, counted inside outstanding above, and reported separately so a
  // reader can see how much of what is owed is already late.
  const overdue = sumAtomic(input.awards.filter((a) => a.state === "overdue_unpaid"));
  // What is owed and not yet late.
  const currentlyDue = outstanding - overdue;
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
      expired_unclaimed_atomic: expiredUnclaimed.toString(),
      overdue_unpaid_atomic: overdue.toString(),
      currently_due_atomic: currentlyDue.toString(),
      maximum_remaining_liability_atomic: null,
      note: V1_NOTE,
    };
  }
  const award = BigInt(input.amount_atomic);
  const maxLiability = award * BigInt(input.max_awards);
  // expired_unmet is the ONLY state that returns a slot: nothing was earned
  // there. An unclaimed entitlement keeps its slot, because the work was
  // accepted and re-selling that seat would pay twice for one accepted piece
  // of work.
  const slotsUsed = input.awards.filter((a) => consumesSlot(a.state)).length;
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
    expired_unclaimed_atomic: expiredUnclaimed.toString(),
    overdue_unpaid_atomic: overdue.toString(),
    currently_due_atomic: currentlyDue.toString(),
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
    return "this listing was posted before settlement v2 and has no award ledger, so awards cannot be made against it; what it may have owed historically is not derivable from its payout bindings and this registry does not claim it was nothing";
  if (!input.open) return "the listing is closed (expired, withdrawn or moderated) and closed listings make no new awards";
  const slotsUsed = input.awards.filter((a) => consumesSlot(a.state)).length;
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

// THE FOUR CLOCKS, and they are four because they answer four different
// questions. Every one of them is declared in the listing before any work
// begins and is hashed into the listing payload, and a listing is immutable.
// That is the whole anti-retroactivity property: a funder cannot invent,
// shorten or attach an expiry after seeing the work, because doing so would
// have to change a payload hash that is already published and chained.
//
//   submission_deadline        by when work may be handed in
//   award_ttl_seconds          how long a RESERVED SEAT may sit before the
//                              condition is met, after which the seat returns
//                              to the market as expired_unmet
//   requester_timeout_seconds  how long the requester has to decide, then the
//                              predeclared silence rule applies
//   payable_ttl_seconds        how long an already-PAYABLE entitlement stays
//                              claimable, after which it is expired_unclaimed
//                              and the entitlement stays on the record forever
export interface SettlementInput {
  max_awards?: unknown;
  funding_mode?: unknown;
  settlement_mode?: unknown;
  automatic_check?: unknown;
  submission_deadline?: unknown;
  requester_timeout_seconds?: unknown;
  award_on_timeout?: unknown;
  award_ttl_seconds?: unknown;
  payable_ttl_seconds?: unknown;
  // Settlement v3, funded listings only.
  escrow_chain_id?: unknown;
  escrow_address?: unknown;
  escrow_token?: unknown;
  verifiers?: unknown;
  escrow_verifier_deadline?: unknown;
  escrow_claim_deadline?: unknown;
  // Read only to refuse an escrow listing that pays its verifiers nothing:
  // the verdict path needs a verifier binding and that binding needs a price.
  verifier_price_atomic?: unknown;
}

// ONE VERIFIER, TWO KEYS, ONE PERSON. A verifier signs the protocol verdict
// with their Ed25519 citizen key and the on-chain release with a secp256k1 EVM
// key, because the EVM cannot check Ed25519. Two keys naming two parties would
// mean the document the society reads and the authorization the money obeys
// are about different people, and nothing would notice.
//
// So both are declared per verifier, in the listing, hashed into its terms
// before any work begins, and the registry refuses a verdict whose signer does
// not hold the declared thumbprint.
export interface VerifierIdentity {
  handle: string;
  keyThumbprint: string;
  evmAddress: string;
  cap: number;
}

export interface ValidatedSettlement {
  maxAwards: number;
  fundingMode: FundingMode;
  settlementMode: SettlementMode;
  automaticCheck: AutomaticCheck | null;
  submissionDeadline: number | null;
  requesterTimeoutSeconds: number | null;
  awardOnTimeout: boolean;
  awardTtlSeconds: number | null;
  payableTtlSeconds: number | null;
  escrowChainId: number | null;
  escrowAddress: string | null;
  escrowToken: string | null;
  verifiers: VerifierIdentity[] | null;
  escrowVerifierDeadline: number | null;
  escrowClaimDeadline: number | null;
  settlementVersion: 2 | 3;
}

export const MAX_ESCROW_VERIFIERS = 8;

// Mirrors ListingEscrow.MIN_CLAIM_GRACE. Two days.
export const MIN_CLAIM_GRACE_SECONDS = 2 * 24 * 3600;

// The v3 half of validateSettlement, kept separate so the v2 path it does not
// touch stays exactly as it was.
export function validateEscrowTerms(body: SettlementInput, maxAwards: number, listingExpiry: number | undefined, nowSeconds: number) {
  const chainId = Number(body.escrow_chain_id);
  if (!Number.isSafeInteger(chainId) || chainId <= 0)
    throw new SocietyError(400, "a funded listing must declare escrow_chain_id: money committed on a chain nobody named is money a reader cannot find");
  const address = String(body.escrow_address ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address))
    throw new SocietyError(400, "a funded listing must declare escrow_address, the contract holding the money. It is hashed into the listing, so a funder cannot publish terms and then commit against a different contract.");
  const token = String(body.escrow_token ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(token))
    throw new SocietyError(400, "a funded listing must declare escrow_token: the asset committed, named rather than assumed");
  // THE ESCROW MUST HOLD WHAT THE LISTING PRICES IN. Accepting any token here
  // let a listing post terms that could never display as funded, because the
  // reader compares the two: a listing that is unfundable by construction
  // should be refused at the door rather than published and never satisfied.
  if (token !== BASE_USDC || chainId !== BASE_CHAIN_ID)
    throw new SocietyError(400, `escrow_token must be the asset this listing prices in, ${BASE_USDC} on chain ${BASE_CHAIN_ID}. An escrow holding something else can never match the terms published here, so the listing would be unfundable from the moment it was posted.`);

  const verifierDeadline = Number(body.escrow_verifier_deadline);
  const claimDeadline = Number(body.escrow_claim_deadline);
  for (const [name, value] of [["escrow_verifier_deadline", verifierDeadline], ["escrow_claim_deadline", claimDeadline]] as const)
    if (!Number.isSafeInteger(value) || value <= nowSeconds)
      throw new SocietyError(400, `${name} must be a unix timestamp in the future`);
  // THE SAME ORDERING THE CONTRACT ENFORCES, checked here so a funder learns
  // it at posting time rather than from a revert. The gap is the payee's, and
  // no verifier delay can consume it.
  // THE SAME MINIMUM THE CONTRACT ENFORCES. "Strictly after" is satisfied by
  // one second, and Base makes a block every two, so a listing could publish a
  // claim window narrower than a single block: a verdict signed at the last
  // legal instant would be uncollectable and the whole escrow would refund to
  // the funder. Checked in both layers, because a rule enforced only on chain
  // is one a funder discovers from a revert.
  if (claimDeadline > verifierDeadline && claimDeadline - verifierDeadline < MIN_CLAIM_GRACE_SECONDS)
    throw new SocietyError(400, `escrow_claim_deadline must leave the payee at least ${MIN_CLAIM_GRACE_SECONDS} seconds after escrow_verifier_deadline. A window shorter than that is not a grace period: a verdict signed at the last legal instant of the verifier window would be uncollectable, and the money would refund to the funder while the work stayed done.`);
  if (claimDeadline <= verifierDeadline)
    throw new SocietyError(400, "escrow_claim_deadline must be strictly after escrow_verifier_deadline: the gap between them is the window the PAYEE has to collect, and a listing that leaves none hands a slow verifier the power to run out the clock on work it already approved");
  if (listingExpiry !== undefined && verifierDeadline < listingExpiry)
    throw new SocietyError(400, "escrow_verifier_deadline must not fall before the listing's own expiry, or work handed in on the last day could never be verified");

  // A VERIFIER MUST BE ABLE TO BE PAID, or no verdict can ever exist. The
  // verdict path requires the verifier to hold a listing-<id>-verifier payout
  // binding, and that binding is refused when the listing declares no verifier
  // price. Without this, a funder could post an escrow listing on which no
  // named verifier could ever bind, so no protocol verdict could exist, so the
  // Ed25519 record the on-chain release is supposed to point at would be
  // unobtainable, exactly where the two-signatures-one-decision guarantee is
  // meant to hold.
  if (body.verifier_price_atomic === undefined || body.verifier_price_atomic === null)
    throw new SocietyError(400, "an escrow-backed listing must declare verifier_price_atomic: a verifier files a payout binding on this listing before they may sign a verdict, and that binding is refused on a listing that pays verifiers nothing. Without it no verdict could ever be recorded and the protocol record the on-chain release points at could not exist.");

  const raw = Array.isArray(body.verifiers) ? body.verifiers : null;
  if (raw === null || raw.length === 0)
    throw new SocietyError(400, "a funded listing must declare its verifiers: who may release this money is a term of the listing, fixed before the work, not a decision made afterwards");
  if (raw.length > MAX_ESCROW_VERIFIERS)
    throw new SocietyError(400, `at most ${MAX_ESCROW_VERIFIERS} verifiers`);
  const verifiers: VerifierIdentity[] = [];
  const seenAddresses = new Set<string>();
  const seenHandles = new Set<string>();
  for (const entry of raw as Record<string, unknown>[]) {
    const handle = String(entry?.handle ?? "");
    const keyThumbprint = String(entry?.key_thumbprint ?? "");
    const evmAddress = String(entry?.evm_address ?? "").toLowerCase();
    const cap = entry?.cap === undefined ? maxAwards : Number(entry.cap);
    if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(handle))
      throw new SocietyError(400, "each verifier needs the handle of the citizen who will sign the protocol verdict");
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(keyThumbprint))
      throw new SocietyError(400, `verifier ${handle} needs key_thumbprint, the Ed25519 citizen key that will sign the verdict. Without it the document the society reads and the authorization the money obeys could be two different people and nothing would notice.`);
    if (!/^0x[0-9a-f]{40}$/.test(evmAddress))
      throw new SocietyError(400, `verifier ${handle} needs evm_address, the wallet that will sign the on-chain release. The EVM cannot check Ed25519, so the same decision is signed twice and both keys are declared here.`);
    if (!Number.isSafeInteger(cap) || cap < 1 || cap > maxAwards)
      throw new SocietyError(400, `verifier ${handle} needs a cap between 1 and max_awards (${maxAwards}): how many awards this one key may EVER authorize. A verifier with the full cap can direct the entire committed balance, which is a legitimate choice for a small listing and must be a choice rather than a surprise.`);
    if (seenAddresses.has(evmAddress) || seenHandles.has(handle))
      throw new SocietyError(400, "a verifier may be named once: two entries for one party are two caps for one key");
    seenAddresses.add(evmAddress);
    seenHandles.add(handle);
    verifiers.push({ handle, keyThumbprint, evmAddress, cap });
  }
  // The same rule the contract enforces at funding, checked here so a funder
  // learns it at posting time rather than from a revert: caps that cannot
  // spend the committed capacity strand money a worker can earn.
  const capSum = verifiers.reduce((n, v) => n + v.cap, 0);
  if (capSum < maxAwards)
    throw new SocietyError(400, `the verifier caps sum to ${capSum} and this listing commits ${maxAwards} awards, so ${maxAwards - capSum} of them could never be released by anyone it named. Money nobody can authorize is not an offer: raise a cap, add a verifier, or lower max_awards.`);

  return { chainId, address, token, verifiers, verifierDeadline, claimDeadline };
}

export function validateSettlement(body: SettlementInput, listingExpiry?: number, nowSeconds = Math.floor(Date.now() / 1000)): ValidatedSettlement {
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

  // A reserved seat's clock. Short by design: "you have six hours to do this
  // or the seat goes back on the market" is the case this exists for, so the
  // floor is minutes rather than an hour.
  const awardTtlSeconds = optionalWindow(body.award_ttl_seconds, "award_ttl_seconds", 60, 30 * 24 * 3600,
    "how long a RESERVED SEAT may sit before the declared condition is met. When it lapses the award becomes expired_unmet, nothing was earned, and the seat returns to the market.");
  // The claim window on an entitlement that already exists. When it lapses the
  // award becomes expired_unclaimed: the money stops being outstanding and the
  // record permanently keeps the fact that this citizen earned it.
  const payableTtlSeconds = optionalWindow(body.payable_ttl_seconds, "payable_ttl_seconds", 60, 365 * 24 * 3600,
    "how long an already-payable entitlement stays claimable. When it lapses the award becomes expired_unclaimed, which is a record that the amount WAS earned and went unclaimed, and is never reported as not_selected.");
  // A claim window on a listing that releases payment the moment it becomes
  // payable would be a clock on an instant. Refused rather than stored and
  // ignored, because a stored term that does nothing is a term a reader will
  // eventually rely on.
  if (payableTtlSeconds !== null && fundingMode === "funded" && settlementMode === "automatic")
    throw new SocietyError(400, "payable_ttl_seconds does not apply to a funded automatic listing: payment releases as soon as the declared check passes, so there is no window in which an entitlement sits unclaimed. Drop it, or use a settlement mode where someone has to act.");

  let submissionDeadline: number | null = null;
  if (body.submission_deadline !== undefined && body.submission_deadline !== null) {
    submissionDeadline = Number(body.submission_deadline);
    if (!Number.isSafeInteger(submissionDeadline) || submissionDeadline <= 0)
      throw new SocietyError(400, "submission_deadline must be a unix timestamp in seconds: the moment work stops being accepted, which is separate from the listing's own expiry");
    if (submissionDeadline <= nowSeconds)
      throw new SocietyError(400, "submission_deadline must be in the future when the listing is posted");
    // It may be EARLIER than the listing expiry, and usually is: "submit by
    // Sept 5, verifier decides within 48 hours" needs the listing to outlive
    // its own submission window so the deciding can happen inside it.
    if (listingExpiry !== undefined && submissionDeadline > listingExpiry)
      throw new SocietyError(400, `submission_deadline ${submissionDeadline} is after the listing's own expiry ${listingExpiry}; work cannot be handed in to a listing that has ended. Extend expiry, or bring the deadline in.`);
  }
  // ESCROW TERMS ARE FOR FUNDED LISTINGS AND NOTHING ELSE. A promise listing
  // that carried an escrow address would be publishing a commitment it does
  // not have, which is the exact confusion this rail exists to remove.
  const escrowFields = ["escrow_chain_id", "escrow_address", "escrow_token", "verifiers", "escrow_verifier_deadline", "escrow_claim_deadline"] as const;
  const suppliedEscrowFields = escrowFields.filter((f) => body[f] !== undefined && body[f] !== null);
  if (fundingMode !== "funded" && suppliedEscrowFields.length > 0)
    throw new SocietyError(400, `${suppliedEscrowFields.join(", ")} ${suppliedEscrowFields.length === 1 ? "is" : "are"} only meaningful on a funded listing: funding_mode ${fundingMode} commits nothing on chain, and publishing escrow terms beside it would describe money that is not there`);

  // V3 IS TRIGGERED BY ESCROW TERMS, NOT BY funding_mode ALONE. A funded
  // listing with no escrow declared is the adapter path, which production
  // refuses for want of an adapter and which the test fixtures exercise
  // against the in-memory mock. Making funding_mode the trigger would have
  // retired that path silently and broken the FUND -> SUBMIT -> PAID example
  // this rail was specified around.
  if (suppliedEscrowFields.length === 0)
    return { maxAwards, fundingMode: fundingMode as FundingMode, settlementMode: settlementMode as SettlementMode, automaticCheck, submissionDeadline, requesterTimeoutSeconds, awardOnTimeout, awardTtlSeconds, payableTtlSeconds, escrowChainId: null, escrowAddress: null, escrowToken: null, verifiers: null, escrowVerifierDeadline: null, escrowClaimDeadline: null, settlementVersion: 2 };

  // A funded listing settles by verifier in v1 of the contract: automatic
  // release needs a condition the chain itself can evaluate, and requester
  // release lets a funder hold committed money hostage by never signing.
  if (settlementMode !== "verifier")
    throw new SocietyError(400, `an ESCROW-BACKED listing settles by verifier in this version. automatic release would need a condition the CHAIN can check by itself, and anything else would put this registry's word in the middle of the money, which is the thing the escrow exists to avoid. requester release would let a funder hold committed money hostage by never signing.`);

  const escrow = validateEscrowTerms(body, maxAwards, listingExpiry, nowSeconds);
  return {
    maxAwards, fundingMode: fundingMode as FundingMode, settlementMode: settlementMode as SettlementMode, automaticCheck,
    submissionDeadline, requesterTimeoutSeconds, awardOnTimeout, awardTtlSeconds, payableTtlSeconds,
    escrowChainId: escrow.chainId, escrowAddress: escrow.address, escrowToken: escrow.token,
    verifiers: escrow.verifiers, escrowVerifierDeadline: escrow.verifierDeadline, escrowClaimDeadline: escrow.claimDeadline,
    settlementVersion: 3,
  };
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

function optionalWindow(value: unknown, name: string, min: number, max: number, meaning: string): number | null {
  if (value === undefined || value === null) return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new SocietyError(400, `${name}, when given, must be a whole number of seconds from ${min} to ${max}: ${meaning}`);
  return n;
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
  "The only settlement adapter that exists is 'mock', which moves no money and holds none: it is an in-memory ledger used by this registry's tests to exercise the state machine end to end. This Worker holds no key that can spend from any wallet, by design, and the treasury key lives nowhere near this code. THIS TEXT IS ABOUT THE ADAPTER PATH ONLY. There IS now a deployed settlement contract, and an ESCROW-BACKED listing (settlement_version 3) commits real money in it: that path names the contract in the listing's own hashed terms, and this registry reads the chain and serves the answer as funding_status rather than asserting it. What has no adapter is the older in-registry funded mode, which is what this refusal is about.";

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
