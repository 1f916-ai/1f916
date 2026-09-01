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
    funder: "0xF00D000000000000000000000000000000000000",
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
  // THE FUNDER IS IN THE SIGNED BYTES. Escrows are keyed by (listingHash,
  // funder), so a signature naming only the hash would let the relayer choose
  // which escrow it spent: an attacker escrows the same listing with a token
  // he minted, collects verdicts against it, and replays them onto the honest
  // funder. A verifier must see whose money it is moving.
  assert.deepEqual(RELEASE_TYPE.Release.map((f) => f.name), ["listingHash", "funder", "awardId", "submissionHash", "payee", "verdictHash", "issuedAt"]);
  assert.equal(msg.funder, "0xF00D000000000000000000000000000000000000");
  assert.ok(VERDICT_HASH_FIELDS.includes("listing_id" as never) && VERDICT_HASH_FIELDS.includes("submission_id" as never));
});

test("a malformed hash is refused rather than padded into a release", () => {
  const base = { listingHash: HASH, funder: "0xF00D000000000000000000000000000000000000", awardId: "00".repeat(32), submissionHash: "11".repeat(32), payee: "0xBEEF", verdictPayloadHash: "ab".repeat(32), issuedAt: 1 };
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

// ---------- what may be displayed as FUNDED ----------

import { ESCROW_READ_ABI, fundedDisagreements, fundingStatement } from "../src/funded.ts";

const V = "0x1111111111111111111111111111111111111111";
const ESCROW = "0x2222222222222222222222222222222222222222";

const v3Listing = {
  payload_hash: HASH, amount_atomic: "5000000", max_awards: 3, token: USDC, chain_id: 8453,
  escrow_chain_id: 8453, escrow_address: ESCROW, escrow_token: USDC,
  verifier_evm_addresses: [V], verifier_caps: [3],
  verifier_key_thumbprints: ["thumb"], escrow_verifier_deadline: 1000, escrow_claim_deadline: 2000,
};

const chainOk = {
  chainId: 8453, escrowAddress: ESCROW,
  onchain: terms({ verifierDeadline: 1000, claimDeadline: 2000 }),
  verifierAuthority: [{ address: V, cap: 3, used: 0 }],
  funderAddress: "0xF00D000000000000000000000000000000000000",
};

test("the read ABI cannot express a state change", () => {
  assert.deepEqual(ESCROW_READ_ABI.map((e) => e.name).sort(), ["listingOf", "verifierAuthority"]);
  for (const entry of ESCROW_READ_ABI) assert.equal(entry.stateMutability, "view");
});

test("matching terms are FUNDED and the statement says who can move the money", () => {
  assert.deepEqual(fundedDisagreements(v3Listing, chainOk), []);
  const said = fundingStatement([], chainOk.onchain);
  assert.match(said, /^FUNDED\./);
  assert.match(said, /15000000 atomic units are committed/);
  assert.match(said, /this registry cannot move any of it/);
  assert.match(said, /anyone may relay it/);
});

test("A LISTING WITH NO DECLARED FUNDER WALLET IS NEVER FUNDED", () => {
  // Independent audit finding: with the funder guard written as
  // `if (funderAddress && ...)`, a listing that published none could be
  // escrowed by a stranger with exactly correct terms. Every other field
  // agreed, the site displayed FUNDED, and the unreleased remainder refunded
  // to the stranger rather than to the party the listing said was backing it.
  const found = fundedDisagreements(v3Listing, { ...chainOk, funderAddress: null });
  assert.ok(found.some((f) => /declares no funder wallet/.test(f)), JSON.stringify(found));
  assert.match(fundingStatement(found, chainOk.onchain), /^NOT FUNDED/);
});

test("a refunded escrow is caught by BOTH exported checks, not only the wider one", () => {
  // The narrow check is exported and used standalone, and it missed this, so
  // a caller reaching for it would print "FUNDED, 15000000 committed" about an
  // escrow that had already returned every atom to its funder.
  const refunded = terms({ refunded: true });
  assert.match(String(fundingDisagreement(listing, refunded)), /already been refunded/);
  assert.ok(fundedDisagreements(v3Listing, { ...chainOk, onchain: refunded }).length > 0);
});

test("every way the chain can disagree with the listing is caught and stated", () => {
  const cases: [string, typeof chainOk, RegExp][] = [
    ["wrong chain", { ...chainOk, chainId: 1 }, /commits to chain 8453 and the reader is on chain 1/],
    ["wrong contract", { ...chainOk, escrowAddress: "0x9999999999999999999999999999999999999999" }, /commits to escrow .* and the reader queried/],
    ["not funded at all", { ...chainOk, onchain: null }, /no escrow entry exists/],
    ["wrong amount", { ...chainOk, onchain: terms({ amountPerAward: 1n, verifierDeadline: 1000, claimDeadline: 2000 }) }, /does not stand behind the terms/],
    ["wrong token", { ...chainOk, onchain: terms({ token: "0x3333333333333333333333333333333333333333", verifierDeadline: 1000, claimDeadline: 2000 }) }, /prices in|commits to/],
    ["verifier deadline moved", { ...chainOk, onchain: terms({ verifierDeadline: 999, claimDeadline: 2000 }) }, /verifier deadline is 999/],
    ["claim deadline moved", { ...chainOk, onchain: terms({ verifierDeadline: 1000, claimDeadline: 1999 }) }, /claim deadline is 1999/],
    ["already refunded", { ...chainOk, onchain: terms({ verifierDeadline: 1000, claimDeadline: 2000, refunded: true }) }, /already been refunded/],
    ["named verifier has no authority", { ...chainOk, verifierAuthority: [] }, /no authority at all/],
    ["cap disagrees", { ...chainOk, verifierAuthority: [{ address: V, cap: 1, used: 0 }] }, /cap of 3 and the escrow gives it 1/],
    ["funder wallet disagrees", { ...chainOk, funderAddress: "0x4444444444444444444444444444444444444444" }, /funded by .* and this listing names funder wallet/],
  ];
  for (const [name, chain, expected] of cases) {
    const found = fundedDisagreements(v3Listing, chain);
    assert.ok(found.length > 0, `${name}: must not read as funded`);
    assert.ok(found.some((f) => expected.test(f)), `${name}: got ${JSON.stringify(found)}`);
    assert.match(fundingStatement(found, chain.onchain), /^NOT FUNDED/);
  }
});

test("AN UNNAMED VERIFIER WITH AUTHORITY IS THE DANGEROUS DIRECTION, and it is caught", () => {
  // Someone who can release this listing's money without appearing in the
  // document the work was done against. Every other mismatch shortchanges the
  // funder; this one shortchanges the worker.
  const stranger = "0x5555555555555555555555555555555555555555";
  const found = fundedDisagreements(v3Listing, {
    ...chainOk,
    verifierAuthority: [{ address: V, cap: 3, used: 0 }, { address: stranger, cap: 3, used: 0 }],
  });
  assert.ok(found.some((f) => /authorizes 0x5555.*and this listing never named them/i.test(f)), JSON.stringify(found));
});

test("a v3 listing hashes every term the escrow is checked against", async () => {
  const { listingHashFields } = await import("../src/society.ts");
  const v3 = listingHashFields(3);
  for (const term of ["escrow_chain_id", "escrow_address", "escrow_token", "verifier_evm_addresses", "verifier_caps", "verifier_key_thumbprints", "escrow_verifier_deadline", "escrow_claim_deadline"])
    assert.ok(v3.includes(term), `${term} decides whether money matches terms, so it must be inside the hash`);
  // AND V1/V2 REMAIN REPRODUCIBLE. A v2 listing is never re-read under v3.
  assert.deepEqual([...listingHashFields(2)], [...(await import("../src/society.ts")).LISTING_HASH_FIELDS_V2]);
  assert.deepEqual([...listingHashFields(1)], [...(await import("../src/society.ts")).LISTING_HASH_FIELDS]);
  assert.deepEqual(v3.slice(0, 22), listingHashFields(2).slice(0, 22), "v3 extends v2 rather than reordering it");
});
