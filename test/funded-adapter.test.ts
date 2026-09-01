// The FUNDED adapter: what it may claim, and what it must refuse to claim.
//
// Nothing here moves money. The whole point of these tests is the opposite:
// that the registry's role in a funded listing stays "publish, hash, record"
// and that it refuses to display FUNDED for a listing whose on-chain money
// does not stand behind its own published terms.

import test from "node:test";
import assert from "node:assert/strict";
import { ESCROW_ADDRESS, ESCROW_NOTE, RELEASE_TYPE, fundingDisagreement, releaseDomain, releaseMessage, type EscrowTerms } from "../src/funded.ts";
import { VERDICT_HASH_FIELDS } from "../src/settlement.ts";

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const HASH = "52deaea8a16fc23d4b8f2df6098146d6723a272f1269c3caeb5a49b3625066f5";

const terms = (over: Partial<EscrowTerms> = {}): EscrowTerms => ({
  funder: "0xF00D000000000000000000000000000000000000",
  token: USDC,
  amountPerAward: 5_000_000n,
  maxAwards: 3,
  released: 0,
  verifierDeadline: 1,
  claimDeadline: 2,
  refunded: false,
  committed: 15_000_000n,
  ...over,
});

const listing = { payload_hash: HASH, amount_atomic: "5000000", max_awards: 3, token: USDC };

test("FUNDED is not reachable in production until a reviewed contract address exists", () => {
  // The flag that keeps the door shut is this one, and it is data rather than
  // a branch someone can forget: with no escrow address there is no contract
  // to read, so nothing can be displayed as funded.
  assert.equal(ESCROW_ADDRESS, null);
});

test("the escrow note states the custody property in the terms a reader can check", () => {
  for (const claim of [/no owner/, /no admin/, /no upgrade/, /holds no key/, /ORIGINAL funding address/, /never a parameter/])
    assert.match(ESCROW_NOTE, claim);
});

test("a listing whose on-chain money does not match its published terms is NOT funded", () => {
  assert.equal(fundingDisagreement(listing, terms()), null, "matching terms are funded");
  // Each of these is a listing that would otherwise display as FUNDED while
  // the money behind it says something different.
  assert.match(String(fundingDisagreement(listing, null)), /no escrow entry exists/);
  assert.match(String(fundingDisagreement(listing, terms({ amountPerAward: 1_000_000n, committed: 3_000_000n }))), /does not stand behind the terms/);
  assert.match(String(fundingDisagreement(listing, terms({ maxAwards: 1 }))), /does not stand behind the terms/);
  assert.match(String(fundingDisagreement(listing, terms({ token: "0x0000000000000000000000000000000000000001" }))), /holds 0x0+1 and this listing prices in/);
  assert.match(String(fundingDisagreement(listing, terms({ funder: "0x0000000000000000000000000000000000000000" }))), /no escrow entry/);
});

test("an escrow holding MORE than the terms is still a disagreement, not a bonus", () => {
  // Over-funding looks generous and is a mismatch: the contract will pay out
  // by its own terms, so the extra is money the listing never promised and
  // the funder cannot recover until the claim window closes. Publishing that
  // as simply FUNDED would misdescribe both sides.
  assert.match(String(fundingDisagreement(listing, terms({ maxAwards: 5, committed: 25_000_000n }))), /does not stand behind the terms/);
});

// THE JOIN BETWEEN THE TWO SIGNATURES.
test("the EIP-712 release carries the Ed25519 verdict's own payload hash, so both signatures name one decision", () => {
  const msg = releaseMessage({
    listingHash: HASH,
    awardId: "00".repeat(31) + "07",
    submissionHash: "11".repeat(32),
    payee: "0xBEEF000000000000000000000000000000000000",
    verdictPayloadHash: "ab".repeat(32),
    issuedAt: 1_700_000_000,
  });
  assert.equal(msg.verdictHash, "0x" + "ab".repeat(32), "unchanged, so the chain names the protocol verdict exactly");
  assert.equal(msg.listingHash, "0x" + HASH);
  // Every field of the on-chain authorization is also a field of, or is bound
  // to, the off-chain record: listing, submission, award, payee, verdict.
  assert.deepEqual(RELEASE_TYPE.Release.map((f) => f.name), ["listingHash", "awardId", "submissionHash", "payee", "verdictHash", "issuedAt"]);
  assert.ok(VERDICT_HASH_FIELDS.includes("listing_id" as never) && VERDICT_HASH_FIELDS.includes("submission_id" as never));
});

test("a malformed hash is refused rather than padded into a release", () => {
  const base = { listingHash: HASH, awardId: "00".repeat(32), submissionHash: "11".repeat(32), payee: "0xBEEF", verdictPayloadHash: "ab".repeat(32), issuedAt: 1 };
  assert.throws(() => releaseMessage({ ...base, listingHash: "deadbeef" }), /must be 32 bytes/);
  assert.throws(() => releaseMessage({ ...base, verdictPayloadHash: "" }), /must be 32 bytes/);
  assert.throws(() => releaseMessage({ ...base, awardId: "zz".repeat(32) }), /must be 32 bytes/);
});

test("the release domain is bound to Base and to one contract", () => {
  const d = releaseDomain("0x1111111111111111111111111111111111111111");
  assert.equal(d.chainId, 8453, "a signature for another chain is a different domain and will not verify");
  assert.equal(d.verifyingContract, "0x1111111111111111111111111111111111111111");
  assert.equal(d.name, "1F916 ListingEscrow");
});
