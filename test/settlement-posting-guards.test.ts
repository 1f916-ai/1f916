// Posting-time refusals in src/settlement.ts that no test killed.
//
// The mutation audit of 2026-09-04 replaced each `throw new SocietyError(...)`
// in this file with `void new SocietyError(...)` one at a time and ran the
// suite. The guards below stayed green under that mutation: the sentence was
// still in the source, the refusal was gone, and nothing noticed. Each test
// here names the line it kills.
//
// The method for the escrow terms is one valid v3 body with one term removed
// or bent at a time, so a test proves the guard on THAT term rather than a
// body that fails for several reasons at once.

import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_ESCROW_VERIFIERS,
  MIN_CLAIM_GRACE_SECONDS,
  MockSettlementAdapter,
  assertLiabilityInvariant,
  listingEconomics,
  validateAutomaticCheck,
  validateSettlement,
  type SettlementInput,
} from "../src/settlement.ts";
import { BASE_USDC } from "../src/payouts.ts";
import { SocietyError } from "../src/society.ts";

const DOLLAR = "1000000";
const NOW = 1_800_000_000;
const EXPIRY = NOW + 7 * 86400;

const verifier = (n: number, cap = 1) => ({
  handle: `verifier-${n}`,
  // 16 to 64 chars of base64url is the shape the validator accepts.
  key_thumbprint: `thumb-${n}-`.padEnd(24, "x"),
  evm_address: "0x" + String(n).repeat(40).slice(0, 40),
  cap,
});

// A body validateSettlement accepts as settlement_version 3. Every escrow
// test below starts from this and breaks exactly one thing.
function v3(over: Partial<SettlementInput> = {}): SettlementInput {
  return {
    max_awards: 2,
    funding_mode: "funded",
    settlement_mode: "verifier",
    verifier_price_atomic: "100000",
    escrow_chain_id: 8453,
    escrow_address: "0x" + "b".repeat(40),
    escrow_token: BASE_USDC,
    verifiers: [verifier(1), verifier(2)],
    escrow_verifier_deadline: EXPIRY + 3600,
    escrow_claim_deadline: EXPIRY + 3600 + MIN_CLAIM_GRACE_SECONDS,
    ...over,
  };
}

function refused(body: SettlementInput, pattern: RegExp, why: string) {
  assert.throws(
    () => validateSettlement(body, EXPIRY, NOW),
    (e: unknown) => e instanceof SocietyError && e.status === 400 && pattern.test(e.message),
    why,
  );
}

test("the v3 fixture itself validates, so each refusal below is about the one term it bends", () => {
  const ok = validateSettlement(v3(), EXPIRY, NOW);
  assert.equal(ok.settlementVersion, 3);
  assert.equal(ok.escrowAddress, "0x" + "b".repeat(40));
  assert.equal(ok.escrowToken, BASE_USDC);
  assert.equal(ok.verifiers?.length, 2);
});

test("a funded listing must name the contract holding the money", () => {
  // KILLING MUTATION: src/settlement.ts, `throw new SocietyError(400, "a funded
  // listing must declare escrow_address ...")` -> `void new SocietyError(...)`.
  // The listing would then publish escrow terms with no escrow.
  refused(v3({ escrow_address: undefined }), /must declare escrow_address/, "no address, no listing");
  refused(v3({ escrow_address: "0x1234" }), /must declare escrow_address/, "a malformed address is not an address");
});

test("a funded listing must name the asset committed rather than assume it", () => {
  // KILLING MUTATION: src/settlement.ts, `throw new SocietyError(400, "a funded
  // listing must declare escrow_token ...")` -> `void ...`.
  refused(v3({ escrow_token: undefined }), /must declare escrow_token/, "no token, no listing");
  refused(v3({ escrow_token: "usdc" }), /must declare escrow_token/, "a symbol is not a contract address");
});

test("an escrow deadline in the past, or not a timestamp at all, is refused at the door", () => {
  // KILLING MUTATION: src/settlement.ts, `throw new SocietyError(400,
  // `${name} must be a unix timestamp in the future`)` -> `void ...`. A
  // listing could then publish a verifier window that had already closed
  // when it was posted: money committed against a verdict nobody could sign.
  refused(v3({ escrow_verifier_deadline: NOW - 1 }), /escrow_verifier_deadline must be a unix timestamp in the future/, "a verifier deadline already passed");
  refused(v3({ escrow_claim_deadline: NOW - 1 }), /escrow_claim_deadline must be a unix timestamp in the future/, "a claim deadline already passed");
  refused(v3({ escrow_verifier_deadline: "soon" }), /escrow_verifier_deadline must be a unix timestamp in the future/, "prose is not a clock");
  refused(v3({ escrow_claim_deadline: 1.5 }), /escrow_claim_deadline must be a unix timestamp in the future/, "a fraction is not a unix timestamp");
});

test("more verifiers than the escrow can hold is refused before any of them is examined", () => {
  // KILLING MUTATION: src/settlement.ts, `throw new SocietyError(400, `at most
  // ${MAX_ESCROW_VERIFIERS} verifiers`)` -> `void ...`. The registry would
  // then publish a verifier set the contract cannot represent, so the
  // verifierSet hash could never match on chain and the listing could never
  // read as funded, while every one of the nine looked legitimately named.
  const nine = Array.from({ length: MAX_ESCROW_VERIFIERS + 1 }, (_, i) => verifier(i + 1));
  refused(v3({ max_awards: nine.length, verifiers: nine }), new RegExp(`at most ${MAX_ESCROW_VERIFIERS} verifiers`), "nine verifiers where eight is the cap");
  // Exactly the cap is fine, so the guard is the count and not the shape.
  const eight = nine.slice(0, MAX_ESCROW_VERIFIERS);
  assert.equal(validateSettlement(v3({ max_awards: eight.length, verifiers: eight }), EXPIRY, NOW).verifiers?.length, MAX_ESCROW_VERIFIERS);
});

test("a verifier entry without a citizen handle is refused, because the protocol verdict has to be signed by somebody", () => {
  // KILLING MUTATION: src/settlement.ts, `throw new SocietyError(400, "each
  // verifier needs the handle of the citizen ...")` -> `void ...`. An entry
  // with no handle would then pass on to the thumbprint check with handle ""
  // and, given a thumbprint and an address, be recorded as a verifier the
  // society cannot name.
  const nameless = { ...verifier(1), handle: undefined };
  refused(v3({ verifiers: [nameless, verifier(2)] }), /each verifier needs the handle/, "no handle at all");
  refused(v3({ verifiers: [{ ...verifier(1), handle: "Not A Handle" }, verifier(2)] }), /each verifier needs the handle/, "a string outside the handle class");
});

test("funding_mode and settlement_mode are closed lists, and a word outside them is refused rather than stored", () => {
  // KILLING MUTATIONS: src/settlement.ts, `throw new SocietyError(400,
  // `funding_mode must be one of ...`)` -> `void ...`, and the same for
  // `settlement_mode must be one of ...`. Both modes are hashed into the
  // listing payload and drive every later branch (who may award, whether
  // money is released in-request), so an unknown word would publish a
  // listing that no branch handles and no reader can interpret.
  assert.throws(
    () => validateSettlement({ funding_mode: "gift" }, EXPIRY, NOW),
    (e: unknown) => e instanceof SocietyError && e.status === 400 && /funding_mode must be one of promise, verified, funded/.test(e.message),
  );
  assert.throws(
    () => validateSettlement({ settlement_mode: "vibes" }, EXPIRY, NOW),
    (e: unknown) => e instanceof SocietyError && e.status === 400 && /settlement_mode must be one of automatic, requester, verifier/.test(e.message),
  );
  // Case matters: the stored value is compared byte-for-byte downstream.
  assert.throws(() => validateSettlement({ funding_mode: "Funded" }, EXPIRY, NOW), /funding_mode must be one of/);
  assert.throws(() => validateSettlement({ settlement_mode: "REQUESTER" }, EXPIRY, NOW), /settlement_mode must be one of/);
  const ok = validateSettlement({ funding_mode: "promise", settlement_mode: "requester" }, EXPIRY, NOW);
  assert.equal(ok.fundingMode, "promise");
  assert.equal(ok.settlementMode, "requester");
});

test("an automatic_check on a listing that does not settle automatically is refused, not silently carried", () => {
  // KILLING MUTATION: src/settlement.ts, `throw new SocietyError(400,
  // "automatic_check is only meaningful with settlement_mode automatic")` ->
  // `void ...`. A requester-settled listing would then publish a check the
  // registry will never evaluate, and a worker reading the terms would
  // reasonably expect payment on meeting it.
  const check = { kind: "comment_artifact_contains", expect: "REPRODUCED-7f3a" };
  assert.throws(
    () => validateSettlement({ settlement_mode: "requester", automatic_check: check }, EXPIRY, NOW),
    (e: unknown) => e instanceof SocietyError && e.status === 400 && /automatic_check is only meaningful with settlement_mode automatic/.test(e.message),
  );
  assert.throws(() => validateSettlement({ settlement_mode: "verifier", automatic_check: check }, EXPIRY, NOW), /only meaningful with settlement_mode automatic/);
  assert.equal(validateSettlement({ settlement_mode: "requester" }, EXPIRY, NOW).automaticCheck, null);
});

test("requester_timeout_seconds is bounded to one hour through thirty days, and a value outside is refused", () => {
  // KILLING MUTATION: src/settlement.ts, `throw new SocietyError(400,
  // "requester_timeout_seconds must be a whole number of seconds from 3600
  // ...")` -> `void ...`. The clock is hashed into the listing terms, so a
  // one-second or ten-year timeout would be published as a term of the
  // listing, with the same served prose describing it as a bounded window.
  for (const requester_timeout_seconds of [0, 3599, 2592001, 1.5, "1 day", -86400]) {
    assert.throws(
      () => validateSettlement({ settlement_mode: "requester", requester_timeout_seconds }, EXPIRY, NOW),
      (e: unknown) => e instanceof SocietyError && e.status === 400 && /requester_timeout_seconds must be a whole number of seconds from 3600/.test(e.message),
      `requester_timeout_seconds ${String(requester_timeout_seconds)}`,
    );
  }
  assert.equal(validateSettlement({ settlement_mode: "requester", requester_timeout_seconds: 3600 }, EXPIRY, NOW).requesterTimeoutSeconds, 3600);
  assert.equal(validateSettlement({ settlement_mode: "requester", requester_timeout_seconds: 2592000 }, EXPIRY, NOW).requesterTimeoutSeconds, 2592000);
});

test("requester_timeout_seconds on a listing nobody's silence can settle is refused", () => {
  // KILLING MUTATION: src/settlement.ts, `throw new SocietyError(400,
  // "requester_timeout_seconds is only meaningful with settlement_mode
  // requester")` -> `void ...`. A verifier- or automatic-settled listing
  // would then publish a requester clock beside a mode in which no requester
  // ever decides, which is a term that describes nothing.
  for (const settlement_mode of ["verifier", "automatic"]) {
    const body = settlement_mode === "automatic"
      ? { settlement_mode, automatic_check: { kind: "comment_artifact_contains", expect: "REPRODUCED-7f3a" }, requester_timeout_seconds: 86400 }
      : { settlement_mode, requester_timeout_seconds: 86400 };
    assert.throws(
      () => validateSettlement(body, EXPIRY, NOW),
      (e: unknown) => e instanceof SocietyError && e.status === 400 && /requester_timeout_seconds is only meaningful with settlement_mode requester/.test(e.message),
      `settlement_mode ${settlement_mode}`,
    );
  }
  assert.equal(validateSettlement({ settlement_mode: "verifier" }, EXPIRY, NOW).requesterTimeoutSeconds, null, "and absent, the clock is null rather than defaulted");
});

test("a submission_deadline that is not a unix timestamp is refused, and NaN cannot slip past the range checks", () => {
  // KILLING MUTATION: src/settlement.ts, `throw new SocietyError(400,
  // "submission_deadline must be a unix timestamp in seconds ...")` ->
  // `void ...`. The two comparisons after it are <= and >, both false for
  // NaN, so "next friday" would be stored as a deadline of NaN and no work
  // could ever be refused as late.
  for (const submission_deadline of ["next friday", Number.NaN, 0, -1, 1.5, {}]) {
    assert.throws(
      () => validateSettlement({ submission_deadline }, EXPIRY, NOW),
      (e: unknown) => e instanceof SocietyError && e.status === 400 && /submission_deadline must be a unix timestamp in seconds/.test(e.message),
      `submission_deadline ${String(submission_deadline)}`,
    );
  }
  assert.equal(validateSettlement({ submission_deadline: NOW + 3600 }, EXPIRY, NOW).submissionDeadline, NOW + 3600);
});

test("a submission_deadline already in the past is refused: a listing cannot open with its window closed", () => {
  // KILLING MUTATION: src/settlement.ts, `throw new SocietyError(400,
  // "submission_deadline must be in the future when the listing is posted")`
  // -> `void ...`. The deadline is a whole positive number, so the shape
  // check passes, and it is below the listing expiry, so the ordering check
  // passes: a listing would be published to which no work could ever be
  // handed in, while reading as open.
  for (const submission_deadline of [NOW, NOW - 1, NOW - 86400]) {
    assert.throws(
      () => validateSettlement({ submission_deadline }, EXPIRY, NOW),
      (e: unknown) => e instanceof SocietyError && e.status === 400 && /submission_deadline must be in the future when the listing is posted/.test(e.message),
      `submission_deadline ${submission_deadline - NOW}s from now`,
    );
  }
  assert.equal(validateSettlement({ submission_deadline: NOW + 1 }, EXPIRY, NOW).submissionDeadline, NOW + 1, "one second ahead is the future");
});

test("an automatic_check that is not an object, or is a string that is not JSON, is refused with the reason named", () => {
  // KILLING MUTATIONS: src/settlement.ts validateAutomaticCheck, `throw new
  // SocietyError(400, "automatic_check must be an object")` -> `void ...`
  // (the next line then reads .kind off null and dies with a TypeError), and
  // safeJson's `throw new SocietyError(400, "automatic_check must be valid
  // JSON")` -> `void ...` (the parse failure then surfaces as "must be an
  // object", which points the funder at the wrong fix).
  for (const value of [null, 42, "42", true, "\"a string\""]) {
    assert.throws(
      () => validateAutomaticCheck(value),
      (e: unknown) => e instanceof SocietyError && e.status === 400 && /automatic_check must be an object/.test(e.message),
      `automatic_check ${String(value)}`,
    );
  }
  assert.throws(
    () => validateAutomaticCheck("{not json"),
    (e: unknown) => e instanceof SocietyError && e.status === 400 && /automatic_check must be valid JSON/.test(e.message),
  );
  const ok = validateAutomaticCheck(JSON.stringify({ kind: "comment_artifact_contains", expect: "REPRODUCED-7f3a" }));
  assert.equal(ok.expect, "REPRODUCED-7f3a", "the stored JSON form round-trips");
});

test("award_ttl_seconds and payable_ttl_seconds, when given, are whole seconds inside their declared ranges", () => {
  // KILLING MUTATION: src/settlement.ts optionalWindow, `throw new
  // SocietyError(400, `${name}, when given, must be a whole number of
  // seconds ...`)` -> `void ...`. Both clocks are hashed into the listing
  // and drive sweepExpiredAwards; a one-second seat or a fractional claim
  // window would then be published as a term.
  const requester = { settlement_mode: "requester" } as const;
  for (const award_ttl_seconds of [0, 59, 30 * 24 * 3600 + 1, 1.5, "an hour"]) {
    assert.throws(
      () => validateSettlement({ ...requester, award_ttl_seconds }, EXPIRY, NOW),
      (e: unknown) => e instanceof SocietyError && e.status === 400 && /award_ttl_seconds, when given, must be a whole number of seconds from 60 to 2592000/.test(e.message),
      `award_ttl_seconds ${String(award_ttl_seconds)}`,
    );
  }
  for (const payable_ttl_seconds of [0, 59, 365 * 24 * 3600 + 1, 2.5, "a year"]) {
    assert.throws(
      () => validateSettlement({ ...requester, payable_ttl_seconds }, EXPIRY, NOW),
      (e: unknown) => e instanceof SocietyError && e.status === 400 && /payable_ttl_seconds, when given, must be a whole number of seconds from 60 to 31536000/.test(e.message),
      `payable_ttl_seconds ${String(payable_ttl_seconds)}`,
    );
  }
  const ok = validateSettlement({ ...requester, award_ttl_seconds: 60, payable_ttl_seconds: 365 * 24 * 3600 }, EXPIRY, NOW);
  assert.equal(ok.awardTtlSeconds, 60);
  assert.equal(ok.payableTtlSeconds, 365 * 24 * 3600);
});

test("the mock settlement adapter refuses to fund a listing twice, so a retried fund cannot double the committed balance", async () => {
  // KILLING MUTATION: src/settlement.ts MockSettlementAdapter.fund, `throw new
  // SocietyError(409, `listing ${listingId} is already funded`)` -> `void ...`.
  // The mock is the only adapter and the one every end-to-end test settles
  // through, so its accounting being silently wrong would make those tests
  // prove the wrong arithmetic.
  const adapter = new MockSettlementAdapter();
  await adapter.fund(7, "3000000");
  await assert.rejects(
    adapter.fund(7, "3000000"),
    (e: unknown) => e instanceof SocietyError && e.status === 409 && /listing 7 is already funded/.test(e.message),
  );
  assert.equal(await adapter.fundedBalance(7), "3000000", "the balance is what was committed once");
});

test("the liability invariant is checked, not assumed: an over-awarded ledger is a 500, never a quiet number", () => {
  // KILLING MUTATION: src/settlement.ts, `throw new SocietyError(500,
  // "liability invariant violated ...")` -> `void new SocietyError(...)`.
  // assertLiabilityInvariant is called on every served economics block, and
  // with the throw gone a listing whose awards exceed its declared maximum
  // would be served as if the arithmetic held.
  const sound = listingEconomics({
    settlement_version: 2, amount_atomic: DOLLAR, max_awards: 2,
    awards: [{ state: "paid", amount_atomic: DOLLAR }, { state: "awarded", amount_atomic: DOLLAR }], open: true,
  });
  assert.doesNotThrow(() => assertLiabilityInvariant(sound));
  // Over-awarded by hand: three dollars of awards against a two-dollar cap.
  // listingEconomics cannot produce this from the ledger (that is the point
  // of the slot guard), so the check is exercised on the served shape it
  // actually receives.
  const broken = { ...sound, amount_paid_atomic: "2000000", maximum_remaining_liability_atomic: "1000000", max_liability_atomic: "2000000" };
  assert.throws(
    () => assertLiabilityInvariant(broken),
    (e: unknown) => e instanceof SocietyError && e.status === 500 && /liability invariant violated/.test(e.message) && /exceeds the declared maximum 2000000/.test(e.message),
  );
  // Nulls (a pre-v2 listing) are not a violation; they are the absence of a claim.
  assert.doesNotThrow(() => assertLiabilityInvariant({ ...sound, max_liability_atomic: null, maximum_remaining_liability_atomic: null }));
});

// Keep the cap constants referenced so a later change to either shows up here.
void MAX_ESCROW_VERIFIERS;
