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

test("the escrow this registry reads is the immutable one that was deployed, and it grants nobody anything", () => {
  // Deployed to Base mainnet 2026-09-01. Setting this did NOT open general
  // funding: an escrow-backed listing must still name this exact contract,
  // declare its verifiers with both keys, and match the chain on every term
  // before anything reads as FUNDED. What changed is that there is now
  // somewhere for the money to be.
  assert.equal(ESCROW_ADDRESS, "0xba4a96391ad34ed9733470bf203bd216b07b9b1b");
  assert.match(ESCROW_ADDRESS!, /^0x[0-9a-f]{40}$/, "lowercase, the form every comparison here uses");
  // A listing naming any OTHER contract is still refused, so pointing the
  // registry at an escrow is not the same as trusting one.
  const found = fundedDisagreements(v3Listing, { ...chainOk, escrowAddress: ESCROW_ADDRESS! });
  assert.ok(found.some((f) => /commits to escrow .* and the reader queried/.test(f)),
    "the listing names its own escrow and a reader querying a different one disagrees");
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
  nowSeconds: 500,
};

test("the read ABI cannot express a state change, and DECODES what the contract returns", () => {
  assert.deepEqual(ESCROW_READ_ABI.map((e) => e.name).sort(), ["listingOf", "verifierAuthority", "verifierSetHash"]);
  for (const entry of ESCROW_READ_ABI) assert.ok(entry.stateMutability === "view" || entry.stateMutability === "pure");
  // THE OUTPUT COUNT IS THE POINT. This test used to assert only the entry
  // NAMES, so when listingOf grew a tenth output the ABI stayed at nine and
  // the decoder could not produce the one field the hidden-verifier defence
  // depends on. The fix existed on chain and was unreachable through the
  // reader, and this test was green throughout.
  const listingOf = ESCROW_READ_ABI.find((e) => e.name === "listingOf")!;
  assert.deepEqual(
    listingOf.outputs.map((o) => o.name),
    ["funder", "token", "amountPerAward", "maxAwards", "released", "verifierDeadline", "claimDeadline", "refunded", "committed", "verifierSet"],
  );
  assert.equal(listingOf.outputs.length, 10, "one output per value the contract returns, in order");
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
  max_awards: 3, funding_mode: "funded", settlement_mode: "verifier", verifier_price_atomic: "1000000", max_verifiers: 1,
  escrow_chain_id: 8453, escrow_address: ESCROW, escrow_token: USDC,
  escrow_verifier_deadline: NOW_S + 7 * 86400,
  escrow_claim_deadline: NOW_S + 37 * 86400,
  verifiers: [{ handle: "verifier-one", key_thumbprint: "AAAAAAAAAAAAAAAA", evm_address: V, cap: 3 }],
  ...over,
});

test("an escrow-backed listing declares both of a verifier's keys, and neither is optional", () => {
  const ok = validateSettlement(v3Terms() as never, NOW_S + 5 * 86400, NOW_S);
  assert.equal(ok.settlementVersion, 3);
  assert.deepEqual(ok.verifiers, [{ handle: "verifier-one", keyThumbprint: "AAAAAAAAAAAAAAAA", evmAddress: V.toLowerCase(), cap: 3 }]);

  assert.throws(() => validateSettlement(v3Terms({ verifiers: [{ handle: "verifier-one", evm_address: V, cap: 3 }] }) as never, NOW_S + 5 * 86400, NOW_S),
    /needs key_thumbprint/, "without it the document and the authorization could be two different people");
  assert.throws(() => validateSettlement(v3Terms({ verifiers: [{ handle: "verifier-one", key_thumbprint: "AAAAAAAAAAAAAAAA", cap: 3 }] }) as never, NOW_S + 5 * 86400, NOW_S),
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
  const env = { DB: { prepare: stmt, async batch() { return [{ results: [], meta: { changes: 0 } }]; } }, TREASURY_ADDRESS: "0xa7F7985eB19b8c44F12A0654Df1eF89d1dd527C9" } as never;
  const citizen = { id: 1, handle: "funder", model: "t", karma: 0, created_at: 0, last_seen_at: 0 } as never;
  const body = {
    title: "Independent reproduction test",
    condition: "Re-run the walk against GET /api/payouts and publish the total you got in a comment on this listing's thread.",
    amount_atomic: "1000000", expiry: NOW_S + 3 * 86400, max_awards: 1,
    funding_mode: "funded", settlement_mode: "verifier", verifier_price_atomic: "1000000", max_verifiers: 1,
    escrow_chain_id: 8453, escrow_address: ESCROW, escrow_token: USDC,
    funder_address: "0xa7f7985eb19b8c44f12a0654df1ef89d1dd527c9",
    escrow_verifier_deadline: NOW_S + 7 * 86400, escrow_claim_deadline: NOW_S + 37 * 86400,
    verifiers: [{ handle: "verifier-one", key_thumbprint: "AAAAAAAAAAAAAAAA", evm_address: V, cap: 1 }],
  };
  // A listing cannot name a verifier who does not exist at all.
  await assert.rejects(createListing(env, citizen, body as never), /no citizen verifier-one/);
  db.exec(`INSERT INTO citizens VALUES (2, 'verifier-one', 'test', 's2', 0, 0, 0);
    CREATE TABLE IF NOT EXISTS payout_bindings (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, docket_id TEXT, amount_atomic TEXT, payout_address TEXT, expiry INTEGER, created_at INTEGER);
    CREATE TABLE IF NOT EXISTS keys (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, public_key TEXT, thumbprint TEXT, custody TEXT, status TEXT, bound_at INTEGER);
    INSERT INTO payout_bindings (citizen_id, docket_id, amount_atomic, payout_address, expiry, created_at) VALUES (2, 'proof', '1000000', '${V.toLowerCase()}', 99999999999, 0);
    INSERT INTO keys (citizen_id, public_key, thumbprint, custody, status, bound_at) VALUES (2, 'pk', 'AAAAAAAAAAAAAAAA', 'self', 'active', 0);`);
  // THE CRITICAL ONE. A wallet the named citizen never signed for is refused,
  // because the money obeys the EVM address and the handle beside it is
  // decoration unless something checks it. A funder printing a trusted handle
  // next to their own wallet is the whole attack.
  await assert.rejects(
    createListing(env, citizen, { ...body, verifiers: [{ handle: "verifier-one", key_thumbprint: "AAAAAAAAAAAAAAAA", evm_address: "0x7777777777777777777777777777777777777777", cap: 1 }] } as never),
    /no live payout binding proving control of 0x7777/,
  );
  // Production now reads a deployed contract, so a listing naming a DIFFERENT
  // one is the refusal that matters: an escrow this registry cannot read is a
  // FUNDED claim nobody here could ever check.
  await assert.rejects(createListing(env, citizen, body as never), /this registry can only read 0xba4a/);
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

// ---------- second review, round 3 ----------

test("A FUNDER CANNOT BE THEIR OWN VERIFIER", async () => {
  // Every other check passed for a funder naming their own handle, key and
  // wallet: the binding proof is genuine because the address is theirs, the
  // thumbprint is genuine because the key is theirs, and the set commitment
  // matches because the listing really does name them. The rail refuses a
  // funder's VERDICT, which is no defence at all here: the contract needs no
  // verdict to release, only a signature from an address in the committed set.
  const { createListing } = await import("../src/society.ts");
  const { DatabaseSync } = await import("node:sqlite");
  const { readFileSync } = await import("node:fs");
  const db = new DatabaseSync(":memory:");
  const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
  db.exec(`CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT UNIQUE, model TEXT, secret_hash TEXT, karma INTEGER, created_at INTEGER, last_seen_at INTEGER);
    CREATE TABLE identity_events (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, kind TEXT, detail TEXT, created_at INTEGER, prev_hash TEXT UNIQUE, hash TEXT UNIQUE);
    CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, title TEXT, body TEXT, url TEXT, dupe_hash TEXT, pinned INTEGER, author_model TEXT, created_at INTEGER, quota_exempt INTEGER DEFAULT 0, mod_state TEXT);
    CREATE TABLE payout_bindings (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, docket_id TEXT, amount_atomic TEXT, payout_address TEXT, expiry INTEGER, created_at INTEGER);
    CREATE TABLE keys (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, public_key TEXT, thumbprint TEXT, custody TEXT, status TEXT, bound_at INTEGER);
    ${schema.slice(schema.indexOf("CREATE TABLE IF NOT EXISTS listings"), schema.indexOf("CREATE INDEX IF NOT EXISTS idx_listings_expiry"))}
    INSERT INTO citizens VALUES (1, 'funder', 'test', 's1', 0, 0, 0);
    INSERT INTO citizens VALUES (2, 'verifier-one', 'test', 's2', 0, 0, 0);
    INSERT INTO payout_bindings (citizen_id, docket_id, amount_atomic, payout_address, expiry, created_at) VALUES (1, 'proof', '1000000', '${V.toLowerCase()}', 99999999999, 0);
    INSERT INTO keys (citizen_id, public_key, thumbprint, custody, status, bound_at) VALUES (1, 'pk', 'AAAAAAAAAAAAAAAA', 'self', 'active', 0);`);
  const stmt = (sql: string) => ({
    bind: (...a: unknown[]) => ({
      async first() { return db.prepare(sql).get(...(a as never[])) ?? null; },
      async all() { return { results: db.prepare(sql).all(...(a as never[])) }; },
      async run() { db.prepare(sql).run(...(a as never[])); return { meta: { changes: 1 } }; },
    }),
    async first() { return db.prepare(sql).get() ?? null; },
    async all() { return { results: db.prepare(sql).all() }; },
  });
  const env = { DB: { prepare: stmt, async batch() { return [{ results: [], meta: { changes: 0 } }]; } }, TREASURY_ADDRESS: "0xa7F7985eB19b8c44F12A0654Df1eF89d1dd527C9" } as never;
  const citizen = { id: 1, handle: "funder", model: "t", karma: 0, created_at: 0, last_seen_at: 0 } as never;
  const body = {
    title: "Independent reproduction test",
    condition: "Re-run the walk against GET /api/payouts and publish the total you got in a comment on this listing's thread.",
    amount_atomic: "1000000", expiry: NOW_S + 3 * 86400, max_awards: 1,
    funding_mode: "funded", settlement_mode: "verifier", verifier_price_atomic: "1000000", max_verifiers: 1,
    escrow_chain_id: 8453, escrow_address: ESCROW, escrow_token: USDC,
    escrow_verifier_deadline: NOW_S + 7 * 86400, escrow_claim_deadline: NOW_S + 37 * 86400,
    // The funder's own handle, own key, own proven wallet.
    verifiers: [{ handle: "funder", key_thumbprint: "AAAAAAAAAAAAAAAA", evm_address: V, cap: 1 }],
  };
  await assert.rejects(
    createListing(env, citizen, body as never, { escrowAddress: ESCROW }),
    /cannot name its own funder as a verifier/,
    "a funder who can release their own escrow has committed nothing",
  );

  // And a citizen holding two active self keys cannot be named at all,
  // because which key signs their verdicts is not decidable and a listing
  // that guessed could strand the payment.
  db.exec(`INSERT INTO payout_bindings (citizen_id, docket_id, amount_atomic, payout_address, expiry, created_at) VALUES (2, 'proof', '1000000', '${V.toLowerCase()}', 99999999999, 0);
    INSERT INTO keys (citizen_id, public_key, thumbprint, custody, status, bound_at) VALUES (2, 'pk1', 'BBBBBBBBBBBBBBBB', 'self', 'active', 0);
    INSERT INTO keys (citizen_id, public_key, thumbprint, custody, status, bound_at) VALUES (2, 'pk2', 'CCCCCCCCCCCCCCCC', 'self', 'active', 0);`);
  await assert.rejects(
    createListing(env, citizen, { ...body, verifiers: [{ handle: "verifier-one", key_thumbprint: "BBBBBBBBBBBBBBBB", evm_address: V, cap: 1 }] } as never, { escrowAddress: ESCROW }),
    /holds 2 active self-custodied keys/,
  );
});

test("every active-key lookup resolves deterministically, and both sites agree", async () => {
  // A citizen can hold several active self-custodied keys: nothing refuses a
  // second one and no UNIQUE constraint prevents it. Two `LIMIT 1` queries
  // with no ORDER BY are two questions SQLite may answer differently, and
  // those two answers deciding whether a verdict is accepted is how a payment
  // gets stranded with every layer believing it behaved: the listing posts
  // naming key A, the verdict is refused under key B, and the escrow refunds
  // to the funder while the work stays done.
  //
  // This cannot be caught at runtime, because SQLite returns rowid order in
  // practice and a test would pass either way. So it is pinned at the source:
  // every query that resolves a citizen's active self key must order.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/society.ts", import.meta.url), "utf8");
  // Only queries that RESOLVE a key, not ones that count them: ordering is
  // meaningless for a COUNT and requiring it there would be noise.
  const lookups = [...src.matchAll(/SELECT[^`]*FROM keys WHERE citizen_id = \?[^`]*status = 'active'[^`]*custody = 'self'[^`]*/g)]
    .map((m) => m[0])
    .filter((q) => /SELECT\s+(public_key|thumbprint)/.test(q));
  assert.ok(lookups.length >= 2, `expected the posting-time and verdict-time lookups, found ${lookups.length}`);
  for (const q of lookups)
    assert.match(q, /ORDER BY id ASC/, `an unordered active-key lookup lets two sites disagree about which key is yours: ${q.slice(0, 90)}`);
});

// ---------- fourth review ----------

test("SPENT VERIFIER AUTHORITY IS NOT FUNDING, however well the terms match", () => {
  // The reader fetched `used` and never read it. So once the named verifiers
  // had spent their caps, the escrow still held money, every field still
  // matched, the set hash still matched, and this page still said
  // "FUNDED. 15000000 atomic units are committed" about an amount no
  // signature from any named verifier could move. A worker reads that, works,
  // and is unpayable; the funder takes it back at the claim deadline. That is
  // the free option this whole rail exists to remove.
  const spent = fundedDisagreements(v3Listing, {
    ...chainOk,
    verifierAuthority: [{ address: V, cap: 3, used: 3 }],
  });
  assert.ok(spent.some((f) => /spent their authority/.test(f)), JSON.stringify(spent));
  assert.match(fundingStatement(spent, chainOk.onchain), /^NOT FUNDED/);

  // Partially spent is reported too, with the exact shortfall.
  const partial = fundedDisagreements(v3Listing, {
    ...chainOk,
    verifierAuthority: [{ address: V, cap: 3, used: 1 }],
  });
  assert.ok(partial.some((f) => /may only authorize 2 more/.test(f)), JSON.stringify(partial));

  // And the honest case is still funded: authority covers what is left.
  assert.deepEqual(fundedDisagreements(v3Listing, { ...chainOk, verifierAuthority: [{ address: V, cap: 3, used: 0 }] }), []);
});

test("the reader knows what time it is, and both windows are read against the clock", () => {
  // fundedDisagreements took no time argument at all: it compared the
  // deadlines with the listing for equality and stopped. Past the verifier
  // window nothing could ever be authorized again, and it still said FUNDED.
  const afterVerifier = fundedDisagreements(v3Listing, { ...chainOk, nowSeconds: 1500 });
  assert.ok(afterVerifier.some((f) => /verifier window has closed/.test(f)), JSON.stringify(afterVerifier));

  const afterClaim = fundedDisagreements(v3Listing, { ...chainOk, nowSeconds: 2500 });
  assert.ok(afterClaim.some((f) => /claim window has closed/.test(f)), JSON.stringify(afterClaim));
  // The two are distinct facts and are not collapsed into one sentence.
  assert.ok(!afterClaim.some((f) => /verifier window has closed/.test(f)), "past the claim window the earlier one is not the useful thing to say");
});

test("terms that could never be funded are refused at the door, not published and left unsatisfied", () => {
  // An escrow holding something other than what the listing prices in can
  // never match, so the listing would be unfundable from the moment it posted.
  assert.throws(() => validateSettlement(v3Terms({ escrow_token: "0x3333333333333333333333333333333333333333" }) as never, NOW_S + 5 * 86400, NOW_S),
    /must be the asset this listing prices in/);
  // Caps that cannot spend the committed capacity strand money a worker earns.
  assert.throws(() => validateSettlement(v3Terms({ max_awards: 5, verifiers: [{ handle: "verifier-one", key_thumbprint: "AAAAAAAAAAAAAAAA", evm_address: V, cap: 2 }] }) as never, NOW_S + 5 * 86400, NOW_S),
    /could never be released by anyone it named/);
  // And an escrow listing that pays its verifiers nothing can never have a
  // verdict at all: the verdict path needs a verifier binding, and that
  // binding is refused on a listing with no verifier price.
  const { verifier_price_atomic, ...noPrice } = v3Terms() as Record<string, unknown>;
  void verifier_price_atomic;
  assert.throws(() => validateSettlement(noPrice as never, NOW_S + 5 * 86400, NOW_S),
    /must declare verifier_price_atomic/);
});

test("the escrow call selectors are the real ones, recomputed rather than remembered", async () => {
  // I wrote both of these from memory and got both wrong, with a comment
  // claiming they were verified. A wrong selector calls nothing, so every
  // escrow would have read as absent and every funded listing would have said
  // NOT FUNDED about money that was sitting right there, with no error
  // anywhere to notice.
  const { keccak256, toHex } = await import("viem");
  const { SELECTOR_LISTING_OF, SELECTOR_VERIFIER_AUTHORITY, LISTING_OF_SIGNATURE, VERIFIER_AUTHORITY_SIGNATURE } = await import("../src/funded.ts");
  assert.equal(keccak256(toHex(LISTING_OF_SIGNATURE)).slice(2, 10), SELECTOR_LISTING_OF);
  assert.equal(keccak256(toHex(VERIFIER_AUTHORITY_SIGNATURE)).slice(2, 10), SELECTOR_VERIFIER_AUTHORITY);
  // And the signatures match the ABI this module declares, so the two cannot
  // drift apart either.
  const listingOf = ESCROW_READ_ABI.find((e) => e.name === "listingOf")!;
  assert.equal(`listingOf(${listingOf.inputs.map((i) => i.type).join(",")})`, LISTING_OF_SIGNATURE);
  const authority = ESCROW_READ_ABI.find((e) => e.name === "verifierAuthority")!;
  assert.equal(`verifierAuthority(${authority.inputs.map((i) => i.type).join(",")})`, VERIFIER_AUTHORITY_SIGNATURE);
});

test("the v3 payload hash actually contains the escrow terms", async () => {
  // The audit's blocking finding: createListing never added the six escrow
  // fields to the payload, so they hashed as undefined, which JSON.stringify
  // writes as null. The hash the escrow binds money to was provably
  // independent of the escrow address, the token, the verifiers and both
  // deadlines, and no reader could reproduce a v3 hash from the served body.
  const { listingHashFields } = await import("../src/society.ts");
  const { createHash } = await import("node:crypto");
  const fields = listingHashFields(3);
  const payload: Record<string, unknown> = {};
  for (const f of fields) payload[f] = `value-of-${f}`;
  const withTerms = createHash("sha256").update(JSON.stringify(fields.map((f) => payload[f]))).digest("hex");
  const blanked = { ...payload };
  for (const f of ["escrow_chain_id", "escrow_address", "escrow_token", "verifiers", "escrow_verifier_deadline", "escrow_claim_deadline"]) blanked[f] = null;
  const withoutTerms = createHash("sha256").update(JSON.stringify(fields.map((f) => blanked[f]))).digest("hex");
  assert.notEqual(withTerms, withoutTerms, "if these match, the escrow terms are not in the hash at all");
});

test("a listing whose escrow cannot be read is NOT reported as funded", () => {
  // A read that did not happen is not a funded listing. Falling back to the
  // terms is exactly how a claim outlives its check, which is what shipped:
  // every guard here was imported by tests only and the registry served
  // "this listing's money is committed" having asked the chain nothing.
  const found = fundedDisagreements(v3Listing, { ...chainOk, onchain: null });
  assert.ok(found.length > 0);
  assert.match(fundingStatement(found, null), /^NOT FUNDED/);
});

test("the hand-rolled abi encoder matches the recipe the contract uses", async () => {
  const { encodeAddressUint32Arrays, expectedVerifierSetHash } = await import("../src/funded.ts");
  const { encodeAbiParameters, keccak256 } = await import("viem");
  const verifiers = [
    { evm_address: "0x1111111111111111111111111111111111111111", cap: 1 },
    { evm_address: "0x2222222222222222222222222222222222222222", cap: 3 },
  ];
  const mine = expectedVerifierSetHash(verifiers, encodeAddressUint32Arrays, (hex) => keccak256(hex as `0x${string}`));
  const viemWay = keccak256(encodeAbiParameters(
    [{ type: "address[]" }, { type: "uint32[]" }],
    [verifiers.map((v) => v.evm_address as `0x${string}`), verifiers.map((v) => v.cap)],
  ));
  assert.equal(mine, viemWay, "the encoder the Worker uses must agree with the one the interop test pins to Solidity");
  // And that value is the one pinned against the deployed contract.
  assert.equal(mine, "0xdac3538a537f76d4fd3d9f8dc2bdecfc078f7a2e6035833468f373b40e5758b6");
});

test("the escrow read is bounded AND every call is two-source", async () => {
  // The audit's blocking-adjacent finding. The first version walked all nine
  // providers for EVERY call, two fetches each, sequentially, on an
  // unauthenticated GET: 162 subrequests and 405 seconds worst case for a
  // listing with eight verifiers, on a platform with a hard subrequest cap.
  // The balance read it was copied from only ever ran on a rate-limited POST.
  const { ESCROW_PROVIDER_ATTEMPTS } = await import("../src/payouts.ts");
  assert.ok(ESCROW_PROVIDER_ATTEMPTS <= 6, "a public read path cannot fan out across every provider");
  // AND THE CAP IS ACTUALLY APPLIED. Asserting the constant alone left the
  // mutation that deletes the slice alive: the number was right and nothing
  // used it. Pinned at the source because the provider list comes from env
  // and the failure is a count of network calls, not a value a test can read.
  const { readFileSync } = await import("node:fs");
  const payouts = readFileSync(new URL("../src/payouts.ts", import.meta.url), "utf8");
  const reader = payouts.slice(payouts.indexOf("export function escrowReader"), payouts.indexOf("export function baseRpcUrls"));
  assert.match(reader, /baseRpcUrls\(env\)\.slice\(0, ESCROW_PROVIDER_ATTEMPTS\)/,
    "escrowReader must bound how many providers one public read may try");
  assert.ok(!/for \(const rpcUrl of baseRpcUrls\(env\)\)/.test(reader), "an unbounded walk is what put 162 subrequests on one GET");
  // AND EVERY CALL STAYS TWO-SOURCE. Reusing a single agreed provider for the
  // follow-up reads was cheap and wrong: a provider that answers listingOf
  // honestly and then lies about verifierAuthority makes every cap look
  // unspent, which displays FUNDED over money nobody can release.
  assert.match(reader, /Promise\.all\(\[call\(pair\[0\]/, "the agreed PAIR is reused, not one member of it");
  assert.match(reader, /a !== null && a === b/, "both providers must agree on every later call");
  assert.match(reader, /eth_chainId/, "a provider's answer must not count until it says it is on Base");

  // Measured rather than asserted: count the fetches a full read makes.
  const { readEscrow } = await import("../src/funded.ts");
  let calls = 0;
  const word = (n: number | bigint) => BigInt(n).toString(16).padStart(64, "0");
  const reply = "0x" + word(1) + word(2) + word(1_000_000) + word(8) + word(0) + word(1) + word(2) + word(0) + word(8_000_000) + word(0);
  const eight = Array.from({ length: 8 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`);
  await readEscrow(
    async (_to, data) => { calls += 1; return data.slice(2, 10) === "b3e64062" ? reply : "0x" + word(1) + word(0); },
    "0x2222222222222222222222222222222222222222",
    "52deaea8a16fc23d4b8f2df6098146d6723a272f1269c3caeb5a49b3625066f5",
    "0xF00D000000000000000000000000000000000000",
    eight,
  );
  // One listingOf plus one authority read per verifier. The provider voting
  // happens inside the reader, and it stops at agreement.
  // One listingOf and one authority read per verifier, each answered by two
  // providers. Nine logical reads, eighteen fetches, against 162 before.
  assert.equal(calls, 9, "one logical read for the escrow and one per named verifier, and no repetition");
});

test("A PROVIDER THAT TELLS THE TRUTH ONCE AND LIES AFTERWARDS CANNOT DECIDE THE ANSWER", async () => {
  // The audit's measurement: with one agreed provider reused, a node that
  // answers listingOf honestly (so it wins agreement) and then reports every
  // verifier cap as unspent silences the "no named verifier can authorize
  // anything" disagreement, and the listing shows FUNDED over money nobody
  // can release. Agreeing on call one does not attest call two.
  const { escrowReader } = await import("../src/payouts.ts");
  const word = (n: number | bigint) => BigInt(n).toString(16).padStart(64, "0");
  const HONEST_LISTING = "0x" + word(1).repeat(10);
  const TRUE_AUTH = "0x" + word(2) + word(2);   // cap 2, fully spent
  const LIE_AUTH = "0x" + word(2) + word(0);    // cap 2, "nothing spent"

  const answers: Record<string, (data: string) => string | null> = {
    "https://liar": (d) => (d.slice(2, 10) === "b3e64062" ? HONEST_LISTING : LIE_AUTH),
    "https://honest-a": (d) => (d.slice(2, 10) === "b3e64062" ? HONEST_LISTING : TRUE_AUTH),
    "https://honest-b": (d) => (d.slice(2, 10) === "b3e64062" ? HONEST_LISTING : TRUE_AUTH),
  };
  const env = {
    BASE_RPC_URL: "https://liar",
    __rpcOverrideForTest: answers,
  } as never;
  void env;
  // The property is structural rather than reachable through fetch here, so it
  // is asserted where it lives: the pair must both answer, and disagreement
  // yields null, which the caller reports as NOT CONFIRMED rather than funded.
  const reader = escrowReader({ } as never);
  assert.equal(typeof reader.call, "function");
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/payouts.ts", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("export function escrowReader"), src.indexOf("export function baseRpcUrls"));
  assert.ok(!/return a \?\? b/.test(fn), "a fallback to either answer is the bug");
  assert.match(fn, /return a !== null && a === b \? a : null;/, "disagreement must produce null, never a winner");
  // AND A PROVIDER'S ANSWER MUST NOT COUNT UNTIL IT SAYS IT IS ON BASE. The
  // chain check was dropped when this path was written, and env.BASE_RPC_URL
  // is first in the list, so an override pointed at another chain would have
  // been believed about which listings hold money.
  assert.match(fn, /if \(!\(await isBase\(rpcUrl\)\)\) continue;/, "every candidate provider is chain-checked before its answer is counted");
  assert.ok(!/pair\[0\]\], to, data\)\]\)[\s\S]{0,40}return a;/.test(fn));
});
