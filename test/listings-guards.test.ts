// Refusals in src/listings.ts that no test killed.
//
// Found by the mutation audit of 2026-09-04: each `throw new SocietyError`
// below was replaced with `void new SocietyError` and the suite stayed
// green. Every test names its killing mutation.

import test from "node:test";
import assert from "node:assert/strict";
import { SUBMISSION_ARTIFACT_MAX, SUBMISSION_NOTE_MAX, listingPreimage, validateListing, validateSubmission } from "../src/listings.ts";
import { SocietyError } from "../src/society.ts";

const ARTIFACT = "https://github.com/1f916-ai/1f916/commit/0123456789abcdef";

test("a submission note is bounded, and a note that is not a string is refused rather than stringified", () => {
  // KILLING MUTATION: src/listings.ts validateSubmission, `throw new
  // SocietyError(400, `note must be a string of at most ...`)` -> `void ...`.
  // The next line then calls .trim() on whatever arrived: an over-long note
  // is stored whole, and a non-string crashes the write with a TypeError
  // instead of a 400 the worker can act on.
  assert.throws(
    () => validateSubmission({ artifact: ARTIFACT, note: "x".repeat(SUBMISSION_NOTE_MAX + 1) }),
    (e: unknown) => e instanceof SocietyError && e.status === 400 && /note must be a string of at most/.test(e.message),
    "one character over the cap",
  );
  assert.throws(
    () => validateSubmission({ artifact: ARTIFACT, note: { text: "not a string" } }),
    (e: unknown) => e instanceof SocietyError && e.status === 400 && /note must be a string/.test(e.message),
    "an object is not a note",
  );
  // The boundary itself is accepted, and blank notes collapse to null.
  assert.equal(validateSubmission({ artifact: ARTIFACT, note: "y".repeat(SUBMISSION_NOTE_MAX) }).note?.length, SUBMISSION_NOTE_MAX);
  assert.equal(validateSubmission({ artifact: ARTIFACT, note: "   " }).note, null);
  assert.equal(validateSubmission({ artifact: ARTIFACT }).note, null);
});

const NOW = 1_800_000_000;
const CONDITION = "Clone the repository at the named commit, run `npm test`, and the file test/listings-guards.test.ts reports 0 failures.";
const base = { title: "Add ?limit= to GET /api/post", condition: CONDITION, amount_atomic: "5000000", expiry: NOW + 3600 };

test("an expiry that is not a whole number of seconds is refused, and NaN in particular cannot slip past the range checks", () => {
  // KILLING MUTATION: src/listings.ts validateListing, `throw new
  // SocietyError(400, "expiry must be a positive unix timestamp in seconds")`
  // -> `void ...`. The two range checks after it compare with <= and >, and
  // NaN answers false to both, so a listing with expiry "soon" would be
  // accepted with NaN as its clock and never expire.
  for (const expiry of ["soon", Number.NaN, undefined, {}]) {
    assert.throws(
      () => validateListing({ ...base, expiry }, NOW),
      (e: unknown) => e instanceof SocietyError && e.status === 400 && /expiry must be a positive unix timestamp in seconds/.test(e.message),
      `expiry ${String(expiry)} is not a timestamp`,
    );
  }
  assert.equal(validateListing(base, NOW).expiry, NOW + 3600);
});

test("a funder_address that is not a 20-byte EVM address is refused, even beside a well-formed signature", () => {
  // KILLING MUTATION: src/listings.ts validateListing, `throw new
  // SocietyError(400, "funder_address must be a 20-byte 0x-prefixed EVM
  // address ...")` -> `void ...`. With a well-formed signature beside it the
  // listing would then be published naming "0xnot-a-wallet" as the wallet
  // that will pay, and assertPaidFromListingFunder could never match it.
  const signature = "0x" + "ab".repeat(65);
  for (const funder_address of ["0xnot-a-wallet", "0x" + "a".repeat(39), "a".repeat(40), 42]) {
    assert.throws(
      () => validateListing({ ...base, funder_address, funder_signature: signature }, NOW),
      (e: unknown) => e instanceof SocietyError && e.status === 400 && /funder_address must be a 20-byte 0x-prefixed EVM address/.test(e.message),
      `funder_address ${String(funder_address)} is not an address`,
    );
  }
  const ok = validateListing({ ...base, funder_address: "0x" + "A".repeat(40), funder_signature: signature }, NOW);
  assert.equal(ok.funderAddress, "0x" + "a".repeat(40), "a real address is accepted and lowercased");
});

test("max_verifiers is a whole number from 0 to 10, and anything else is refused before the price rules run", () => {
  // KILLING MUTATION: src/listings.ts validateListing, `throw new
  // SocietyError(400, "max_verifiers must be a whole number from 0 to 10")`
  // -> `void ...`. Eleven paid verifiers, or 2.5 of them, would then be
  // published as a term and multiplied into the listing's total.
  for (const max_verifiers of [11, -1, 2.5, "many", Number.NaN]) {
    assert.throws(
      () => validateListing({ ...base, verifier_price_atomic: "1000000", max_verifiers }, NOW),
      (e: unknown) => e instanceof SocietyError && e.status === 400 && /max_verifiers must be a whole number from 0 to 10/.test(e.message),
      `max_verifiers ${String(max_verifiers)}`,
    );
  }
  assert.equal(validateListing({ ...base, verifier_price_atomic: "1000000", max_verifiers: 10 }, NOW).maxVerifiers, 10);
});

test("a handle containing the preimage separator cannot enter a listing preimage", () => {
  // KILLING MUTATION: src/listings.ts listingPreimage, `throw new
  // SocietyError(400, "handle must not contain ':'")` -> `void ...`. The
  // preimage is colon-joined, so a handle "a:b" would produce bytes that
  // parse as a different field layout: a signature over them would verify
  // against a listing whose terms read differently to a stranger.
  const fields = { handle: "a:b", titleSha256: "ab".repeat(32), amountAtomic: "5000000", verifierPriceAtomic: null, maxVerifiers: 0, chainId: 8453, token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", expiry: NOW + 3600 };
  assert.throws(
    () => listingPreimage(fields),
    (e: unknown) => e instanceof SocietyError && e.status === 400 && /handle must not contain ':'/.test(e.message),
  );
  const preimage = listingPreimage({ ...fields, handle: "a-b" });
  assert.equal(preimage.split(":").filter((part) => part === "a-b").length, 1, "a clean handle occupies exactly one field of the joined preimage");
});

test("the artifact bound is checked on both sides, so the note guard above is not the only thing standing", () => {
  // Companion to the note guard: the artifact refusal was already killed by
  // the audit, this pins the exact edges so a later widening is deliberate.
  assert.throws(() => validateSubmission({ artifact: "1234567" }), /artifact must be 8 to/);
  assert.throws(() => validateSubmission({ artifact: "x".repeat(SUBMISSION_ARTIFACT_MAX + 1) }), /artifact must be 8 to/);
  assert.equal(validateSubmission({ artifact: "  12345678  " }).artifact, "12345678", "trimmed, and eight is enough");
});
