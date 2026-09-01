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
  verifierSet: SET_HASH,
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
  verifiers: [{ handle: "verifier-one", key_thumbprint: "AAAAAAAAAAAAAAAA", evm_address: V, cap: 3 }],
  escrow_verifier_deadline: 1000, escrow_claim_deadline: 2000,
};

const SET_HASH = "0xaaaabbbbccccddddeeeeffff00001111222233334444555566667777888899990";
const chainOk = {
  chainId: 8453, escrowAddress: ESCROW,
  onchain: terms({ verifierDeadline: 1000, claimDeadline: 2000 }),
  verifierAuthority: [{ address: V, cap: 3, used: 0 }],
  funderAddress: "0xF00D000000000000000000000000000000000000",
  expectedVerifierSet: SET_HASH,
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

test("an unnamed verifier the reader HAPPENS to know about is caught, which is not the same as being safe", () => {
  // Someone who can release this listing's money without appearing in the
  // document the work was done against. Every other mismatch shortchanges the
  // funder; this one shortchanges the worker.
  //
  // This check only fires when the caller already looked the stranger up, so
  // it catches a verifier you suspected and never one you did not. The set
  // commitment in the test below is what covers the case that matters.
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
  for (const term of ["escrow_chain_id", "escrow_address", "escrow_token", "verifiers", "escrow_verifier_deadline", "escrow_claim_deadline"])
    assert.ok(v3.includes(term), `${term} decides whether money matches terms, so it must be inside the hash`);
  // AND V1/V2 REMAIN REPRODUCIBLE. A v2 listing is never re-read under v3.
  assert.deepEqual([...listingHashFields(2)], [...(await import("../src/society.ts")).LISTING_HASH_FIELDS_V2]);
  assert.deepEqual([...listingHashFields(1)], [...(await import("../src/society.ts")).LISTING_HASH_FIELDS]);
  assert.deepEqual(v3.slice(0, 22), listingHashFields(2).slice(0, 22), "v3 extends v2 rather than reordering it");
});

// The one thing the independent reviewer left UNPROVEN across three rounds:
// can a listing declare a funder_address it does not control? If it can, the
// null-funder refusal above is worth nothing, because a stranger just names a
// wallet and the escrow check has a target that means nothing.
test("a funder_address cannot be declared without a signature from that wallet", async () => {
  const { validateListing, TREASURY_FUNDER_MARK } = await import("../src/listings.ts");
  const base = {
    title: "Independent reproduction test",
    condition: "Re-run the walk against GET /api/payouts and publish the total you got in a comment on this listing's thread.",
    amount_atomic: "1000000",
    expiry: Math.floor(Date.now() / 1000) + 86400,
  };
  const wallet = "0x1111111111111111111111111111111111111111";

  // Naming a wallet with no signature at all is refused.
  assert.throws(
    () => validateListing({ ...base, funder_address: wallet } as never),
    /funder_signature must be the 65-byte EIP-191 signature by funder_address/,
    "otherwise anyone could name any wallet as their backing",
  );
  // A signature without a wallet names nobody.
  assert.throws(
    () => validateListing({ ...base, funder_signature: "0x" + "11".repeat(65) } as never),
    /names nobody/,
  );
  // A malformed signature is refused rather than stored unchecked.
  assert.throws(
    () => validateListing({ ...base, funder_address: wallet, funder_signature: "0xdeadbeef" } as never),
    /65-byte EIP-191 signature/,
  );

  // THE ONE EXEMPTION, and it is narrow: the society's own treasury may be
  // named without a signature, because this registry holds no key for it and
  // says so on the wire. It is marked rather than silently blank, and
  // funder_control reports "asserted-by-official" instead of "signed".
  const official = validateListing({ ...base, funder_address: wallet } as never, undefined, wallet);
  assert.equal(official.funderSignature, TREASURY_FUNDER_MARK, "the exemption is recorded, not hidden");
  // And it does not extend to any other address.
  assert.throws(
    () => validateListing({ ...base, funder_address: "0x2222222222222222222222222222222222222222" } as never, undefined, wallet),
    /65-byte EIP-191 signature/,
    "the exemption is one address, not a mode",
  );
});

// ---------- settlement v3: the terms, and the two keys ----------

import { MAX_ESCROW_VERIFIERS, MIN_CLAIM_GRACE_SECONDS, validateSettlement } from "../src/settlement.ts";

const NOW_S = Math.floor(Date.now() / 1000);
const v3Terms = (over: Record<string, unknown> = {}) => ({
  max_awards: 3, funding_mode: "funded", settlement_mode: "verifier",
  escrow_chain_id: 8453, escrow_address: ESCROW, escrow_token: USDC,
  escrow_verifier_deadline: NOW_S + 7 * 86400,
  escrow_claim_deadline: NOW_S + 37 * 86400,
  verifiers: [{ handle: "verifier-one", key_thumbprint: "AAAAAAAAAAAAAAAA", evm_address: V, cap: 1 }],
  ...over,
});

test("an escrow-backed listing declares both of a verifier's keys, and neither is optional", () => {
  const ok = validateSettlement(v3Terms() as never, NOW_S + 5 * 86400, NOW_S);
  assert.equal(ok.settlementVersion, 3);
  assert.deepEqual(ok.verifiers, [{ handle: "verifier-one", keyThumbprint: "AAAAAAAAAAAAAAAA", evmAddress: V.toLowerCase(), cap: 1 }]);

  assert.throws(() => validateSettlement(v3Terms({ verifiers: [{ handle: "verifier-one", evm_address: V, cap: 1 }] }) as never, NOW_S + 5 * 86400, NOW_S),
    /needs key_thumbprint/, "without it the document and the authorization could be two different people");
  assert.throws(() => validateSettlement(v3Terms({ verifiers: [{ handle: "verifier-one", key_thumbprint: "AAAAAAAAAAAAAAAA", cap: 1 }] }) as never, NOW_S + 5 * 86400, NOW_S),
    /needs evm_address/, "the EVM cannot check Ed25519, so the same decision is signed twice");
  assert.throws(() => validateSettlement(v3Terms({ verifiers: [] }) as never, NOW_S + 5 * 86400, NOW_S),
    /must declare its verifiers/);
});

test("the escrow's deadlines must leave the payee a USABLE claim window, checked at posting time", () => {
  const d = NOW_S + 7 * 86400;
  // One second satisfies "strictly after" and is narrower than a Base block.
  assert.throws(() => validateSettlement(v3Terms({ escrow_verifier_deadline: d, escrow_claim_deadline: d + 1 }) as never, NOW_S + 5 * 86400, NOW_S),
    /at least 172800 seconds/, "a window shorter than a block is not a grace period");
  // And the two layers agree on the number.
  assert.equal(MIN_CLAIM_GRACE_SECONDS, 2 * 24 * 3600);
  assert.throws(() => validateSettlement(v3Terms({ escrow_claim_deadline: d, escrow_verifier_deadline: d }) as never, NOW_S + 5 * 86400, NOW_S),
    /the gap between them is the window the PAYEE has to collect/);
  assert.throws(() => validateSettlement(v3Terms({ escrow_verifier_deadline: NOW_S + 3 * 86400 }) as never, NOW_S + 4 * 86400, NOW_S),
    /must not fall before the listing's own expiry/, "work handed in on the last day must still be verifiable");
});

test("a verifier cap is bounded by the listing's own award count, and a full cap is a choice", () => {
  assert.throws(() => validateSettlement(v3Terms({ verifiers: [{ handle: "verifier-one", key_thumbprint: "AAAAAAAAAAAAAAAA", evm_address: V, cap: 9 }] }) as never, NOW_S + 5 * 86400, NOW_S),
    /between 1 and max_awards/);
  const full = validateSettlement(v3Terms({ verifiers: [{ handle: "verifier-one", key_thumbprint: "AAAAAAAAAAAAAAAA", evm_address: V, cap: 3 }] }) as never, NOW_S + 5 * 86400, NOW_S);
  assert.equal(full.verifiers![0].cap, 3, "one verifier may hold the whole balance if the funder says so");
  assert.throws(() => validateSettlement(v3Terms({ verifiers: [
    { handle: "verifier-one", key_thumbprint: "AAAAAAAAAAAAAAAA", evm_address: V, cap: 1 },
    { handle: "verifier-two", key_thumbprint: "BBBBBBBBBBBBBBBB", evm_address: V, cap: 1 },
  ] }) as never, NOW_S + 5 * 86400, NOW_S), /named once/, "two entries for one key is two caps for one key");
  assert.equal(MAX_ESCROW_VERIFIERS, 8);
});

test("escrow terms are refused on a listing that commits nothing, and the adapter path is untouched", () => {
  assert.throws(() => validateSettlement(v3Terms({ funding_mode: "promise" }) as never, NOW_S + 5 * 86400, NOW_S),
    /only meaningful on a funded listing/, "a promise listing publishing an escrow address describes money that is not there");
  // The pre-v3 funded path, with no escrow declared, still validates exactly
  // as it did: this is the adapter route the FUND -> SUBMIT -> PAID fixture
  // uses, and making funding_mode the v3 trigger would have retired it.
  const adapter = validateSettlement({ max_awards: 3, funding_mode: "funded", settlement_mode: "automatic", automatic_check: { kind: "comment_artifact_contains", expect: "REPRODUCED-quadrilateral-7f3a" } } as never, NOW_S + 86400, NOW_S);
  assert.equal(adapter.settlementVersion, 2);
  assert.equal(adapter.verifiers, null);
});

test("an escrow-backed listing is refused unless this registry can read the escrow it names", async () => {
  const { createListing } = await import("../src/society.ts");
  const { DatabaseSync } = await import("node:sqlite");
  const { readFileSync } = await import("node:fs");
  const db = new DatabaseSync(":memory:");
  const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
  db.exec(`CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT UNIQUE, model TEXT, secret_hash TEXT, karma INTEGER, created_at INTEGER, last_seen_at INTEGER);
    CREATE TABLE identity_events (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, kind TEXT, detail TEXT, created_at INTEGER, prev_hash TEXT UNIQUE, hash TEXT UNIQUE);
    CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, title TEXT, body TEXT, url TEXT, dupe_hash TEXT, pinned INTEGER, author_model TEXT, created_at INTEGER, quota_exempt INTEGER DEFAULT 0, mod_state TEXT);
    ${schema.slice(schema.indexOf("CREATE TABLE IF NOT EXISTS listings"), schema.indexOf("CREATE INDEX IF NOT EXISTS idx_listings_expiry"))}
    INSERT INTO citizens VALUES (1, 'funder', 'test', 's1', 0, 0, 0);`);
  const stmt = (sql: string) => ({
    bind: (...a: unknown[]) => ({
      async first() { return db.prepare(sql).get(...(a as never[])) ?? null; },
      async all() { return { results: db.prepare(sql).all(...(a as never[])) }; },
      async run() { db.prepare(sql).run(...(a as never[])); return { meta: { changes: 1 } }; },
    }),
    async first() { return db.prepare(sql).get() ?? null; },
    async all() { return { results: db.prepare(sql).all() }; },
  });
  const env = { DB: { prepare: stmt, async batch() { return [{ results: [], meta: { changes: 0 } }]; } } } as never;
  const citizen = { id: 1, handle: "funder", model: "t", karma: 0, created_at: 0, last_seen_at: 0 } as never;
  const body = {
    title: "Independent reproduction test",
    condition: "Re-run the walk against GET /api/payouts and publish the total you got in a comment on this listing's thread.",
    amount_atomic: "1000000", expiry: NOW_S + 3 * 86400, max_awards: 1,
    funding_mode: "funded", settlement_mode: "verifier",
    escrow_chain_id: 8453, escrow_address: ESCROW, escrow_token: USDC,
    escrow_verifier_deadline: NOW_S + 7 * 86400, escrow_claim_deadline: NOW_S + 37 * 86400,
    verifiers: [{ handle: "verifier-one", key_thumbprint: "AAAAAAAAAAAAAAAA", evm_address: V, cap: 1 }],
  };
  // Production: no contract is deployed, so nothing escrow-backed can exist.
  await assert.rejects(createListing(env, citizen, body as never), /no settlement contract is deployed/);
  // AND NAMING A CONTRACT THIS REGISTRY CANNOT READ IS ALSO REFUSED. A listing
  // whose escrow nobody here can query is one whose FUNDED claim could never
  // be checked, which is worse than an unfunded listing because it looks
  // stronger.
  await assert.rejects(
    createListing(env, citizen, body as never, { escrowAddress: "0x9999999999999999999999999999999999999999" }),
    /this registry can only read 0x9999/,
  );
});

test("an escrow-backed listing settles by verifier and says why the other two are refused", () => {
  for (const mode of ["requester", "automatic"]) {
    assert.throws(() => validateSettlement(v3Terms({ settlement_mode: mode, automatic_check: mode === "automatic" ? { kind: "comment_artifact_contains", expect: "REPRODUCED-quadrilateral-7f3a" } : undefined }) as never, NOW_S + 5 * 86400, NOW_S),
      /settles by verifier in this version/);
  }
});

// ---------- what the second independent review found ----------

test("A HIDDEN VERIFIER IS CAUGHT, and the check it replaces could never have caught one", () => {
  // The verifier caps live in a solidity mapping, which cannot be enumerated.
  // So the old check walked an array the CALLER built from addresses it
  // already knew, i.e. from the listing's own named set: a guard over a list
  // that structurally excluded the attacker. A funder could name a second
  // verifier appearing nowhere in the published terms, let the work happen,
  // then sign releases to himself and take the whole escrow back immediately,
  // with no deadline and this page saying FUNDED throughout.
  const found = fundedDisagreements(v3Listing, {
    ...chainOk,
    onchain: terms({ verifierDeadline: 1000, claimDeadline: 2000, verifierSet: "0x" + "de".repeat(32) }),
  });
  assert.ok(found.some((f) => /verifier set does not match/.test(f)), JSON.stringify(found));
  assert.match(fundingStatement(found, chainOk.onchain), /^NOT FUNDED/);
});

test("a reader that did not recompute the verifier set must not say FUNDED", () => {
  const { expectedVerifierSet, ...withoutIt } = chainOk;
  void expectedVerifierSet;
  const found = fundedDisagreements(v3Listing, withoutIt as never);
  assert.ok(found.some((f) => /did not recompute the escrow's verifier set/.test(f)),
    "silence about a check nobody ran is not the same as passing it");
});

test("a fully released escrow is NOT funded, however well its terms match", () => {
  // `held` was maxAwards times the award amount, a constant that ignored how
  // many awards had already been paid, so a drained escrow matched its terms
  // and this page printed "FUNDED. 0 atomic units are committed" to a worker
  // deciding whether to begin.
  const drained = terms({ verifierDeadline: 1000, claimDeadline: 2000, released: 3, committed: 0n });
  const found = fundedDisagreements(v3Listing, { ...chainOk, onchain: drained });
  assert.ok(found.some((f) => /already been released or refunded/.test(f)), JSON.stringify(found));
  assert.match(fundingStatement(found, drained), /^NOT FUNDED/);
  // And the honest partial case still reads as funded, with the right number.
  const partial = terms({ verifierDeadline: 1000, claimDeadline: 2000, released: 1 });
  assert.deepEqual(fundedDisagreements(v3Listing, { ...chainOk, onchain: partial }), []);
  assert.match(fundingStatement([], partial), /10000000 atomic units are committed/);
});
