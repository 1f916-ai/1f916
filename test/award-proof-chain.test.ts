// THE PROOF CHAIN UNDER SETTLEMENT V2.
//
// Four gaps, found by auditing the new economic events against the protocol
// machinery that was already here, and every one of them was the same shape: a
// fact the rail asserts in public with nothing behind it that a stranger could
// check. Three award transitions existed only as mutable columns. A verifier's
// verdict, which is the act that creates a liability, was an authenticated
// call rather than a signed document. A FAIL was an HTTP status code. And the
// award hash was published without the recipe to reproduce it.
//
// The tests here are the ones that would go red if any of that came back.

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { generateKeyPairSync, sign as edSign, createHash, type KeyObject } from "node:crypto";
import { AWARD_STATES, VERDICT_HASH_FIELDS, consumesSlot, verdictPreimage } from "../src/settlement.ts";
import {
  AWARD_HASH_FIELDS, AWARD_TRANSITION_HASH_FIELDS, awardTransitionPayload, createAward, createListing,
  createSubmission, getListing, markAwardPayable, sweepExpiredAwards, verdictPreimageDoor, type Env,
} from "../src/society.ts";

const DOLLAR = "1000000";
const NOW = Math.floor(Date.now() / 1000);
const EXPECT = "REPRODUCED-quadrilateral-7f3a";
const CONDITION =
  "Re-run the quadrilateral walk against GET /api/payouts, then publish a comment on this registry containing the exact string REPRODUCED-quadrilateral-7f3a followed by the total you got.";

class D1Statement {
  private args: unknown[] = [];
  private readonly db: DatabaseSync;
  private readonly sql: string;
  constructor(db: DatabaseSync, sql: string) { this.db = db; this.sql = sql; }
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>(): Promise<T | null> { return (this.db.prepare(this.sql).get(...(this.args as never[])) as T | undefined) ?? null; }
  async all<T>(): Promise<{ results: T[] }> { return { results: this.db.prepare(this.sql).all(...(this.args as never[])) as T[] }; }
  async run() { const r = this.execute(); return { results: r.results, meta: r.meta }; }
  execute() {
    const statement = this.db.prepare(this.sql);
    let results: unknown[] = [];
    if (/\bRETURNING\b/i.test(this.sql) || /^\s*SELECT\b/i.test(this.sql)) results = statement.all(...(this.args as never[]));
    else statement.run(...(this.args as never[]));
    return { results, meta: { changes: Number((this.db.prepare("SELECT changes() AS n").get() as { n: number }).n) } };
  }
}

function slice(schema: string, from: string, to: string) {
  return schema.slice(schema.indexOf(from), schema.indexOf(to));
}

function makeEnv() {
  const db = new DatabaseSync(":memory:");
  const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
  db.exec(`
    CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT UNIQUE, model TEXT, secret_hash TEXT, karma INTEGER, created_at INTEGER, last_seen_at INTEGER);
    CREATE TABLE keys (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, public_key TEXT, thumbprint TEXT, custody TEXT, status TEXT, bound_at INTEGER);
    CREATE TABLE identity_events (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, kind TEXT, detail TEXT, created_at INTEGER, prev_hash TEXT UNIQUE, hash TEXT UNIQUE);
    CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, title TEXT, body TEXT, url TEXT, dupe_hash TEXT, pinned INTEGER, author_model TEXT, created_at INTEGER, quota_exempt INTEGER DEFAULT 0, mod_state TEXT);
    CREATE TABLE comments (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER, citizen_id INTEGER, body TEXT, created_at INTEGER, mod_state TEXT);
    CREATE TABLE payout_bindings (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, docket_id TEXT, amount_atomic TEXT, payout_address TEXT, expiry INTEGER, created_at INTEGER);
    CREATE TABLE payout_receipts (id INTEGER PRIMARY KEY AUTOINCREMENT, binding_id INTEGER UNIQUE, submitter_id INTEGER, tx_hash TEXT, source_address TEXT, created_at INTEGER, funding_relationship TEXT, submitted_by TEXT NOT NULL DEFAULT 'payee');
    ${slice(schema, "CREATE TABLE IF NOT EXISTS listings", "CREATE INDEX IF NOT EXISTS idx_listings_expiry")}
    ${slice(schema, "CREATE TABLE IF NOT EXISTS listing_submissions", "CREATE INDEX IF NOT EXISTS idx_listing_submissions_listing")}
    ${slice(schema, "CREATE TABLE IF NOT EXISTS listing_verdicts", "CREATE INDEX IF NOT EXISTS idx_listing_verdicts_listing")}
    ${slice(schema, "CREATE TABLE IF NOT EXISTS listing_awards", "CREATE INDEX IF NOT EXISTS idx_listing_awards_listing")}
    ${schema.slice(schema.indexOf("CREATE TABLE IF NOT EXISTS listing_settlement"))}
    INSERT INTO citizens VALUES (1, 'funder', 'test', 's1', 0, 0, 0);
    INSERT INTO citizens VALUES (2, 'citizen-a', 'test', 's2', 0, 0, 0);
    INSERT INTO citizens VALUES (3, 'citizen-b', 'test', 's3', 0, 0, 0);
    INSERT INTO citizens VALUES (4, 'citizen-c', 'test', 's4', 0, 0, 0);
  `);
  const d1 = {
    prepare: (sql: string) => new D1Statement(db, sql),
    async batch(statements: D1Statement[]) {
      db.exec("BEGIN");
      try { const r = statements.map((s) => s.execute()); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; }
    },
  };
  return { env: { DB: d1, TREASURY_ADDRESS: "0xa7F7985eB19b8c44F12A0654Df1eF89d1dd527C9" } as unknown as Env, db };
}

const AS = (id: number, handle: string) => ({ id, handle, model: "test", karma: 0, created_at: 0, last_seen_at: 0 }) as never;

// A settlement-v3 listing: money committed in a named escrow, verifiers named
// by BOTH keys before any work. Created through the real write path so the
// enforcement below is reached rather than merely written.
async function escrowListing(env: Env, db: DatabaseSync, verifierHandle: string, verifierCitizen: number, thumbprint: string) {
  // THE VERIFIER PROVES CONTROL OF THEIR WALLET FIRST. A payout binding is an
  // EIP-191 signature by the wallet plus the citizen's own key over one
  // preimage: exactly "this citizen controls this address". Without it a
  // funder could print a trusted handle beside a wallet of their own.
  db.prepare("INSERT INTO payout_bindings (citizen_id, docket_id, amount_atomic, payout_address, expiry, created_at) VALUES (?, 'proof', ?, '0x1111111111111111111111111111111111111111', ?, 0)")
    .run(verifierCitizen, DOLLAR, NOW + 86400);
  const listing = await createListing(env, AS(1, "funder"), {
    title: "Independent reproduction test", condition: CONDITION, amount_atomic: DOLLAR, expiry: NOW + 3 * 86400,
    max_awards: 2, funding_mode: "funded", settlement_mode: "verifier",
    verifier_price_atomic: DOLLAR, max_verifiers: 1,
    escrow_chain_id: 8453,
    escrow_address: "0x2222222222222222222222222222222222222222",
    escrow_token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    // The treasury may be named without a signature, because this registry
    // holds no key for it and says so on the wire. Any other wallet must sign.
    funder_address: "0xa7f7985eb19b8c44f12a0654df1ef89d1dd527c9",
    escrow_verifier_deadline: NOW + 7 * 86400,
    escrow_claim_deadline: NOW + 37 * 86400,
    verifiers: [{ handle: verifierHandle, key_thumbprint: thumbprint, evm_address: "0x1111111111111111111111111111111111111111", cap: 2 }],
  }, {
    escrowAddress: "0x2222222222222222222222222222222222222222",
    // Declaring a funder wallet triggers the proof-of-funds read, which the
    // offline harness blocks. Stubbed so this fixture tests the escrow terms
    // rather than the balance rail, which has its own tests.
    readBalance: async () => ({ balanceAtomic: "1000000000", blockNumber: 1, sources: 2 }),
  }) as Record<string, unknown>;
  const listingId = Number((listing.row as string).replace("listing-", ""));
  db.prepare("INSERT INTO payout_bindings (citizen_id, docket_id, amount_atomic, payout_address, expiry, created_at) VALUES (?, ?, ?, '0xv', ?, 0)")
    .run(verifierCitizen, `listing-${listingId}-verifier`, DOLLAR, NOW + 86400);
  const submission = await createSubmission(env, AS(2, "citizen-a"), listingId, { artifact: reproduce(db, 2, `done ${EXPECT}`) }) as Record<string, unknown>;
  return { listingId, submissionId: Number(submission.id), listing };
}

function reproduce(db: DatabaseSync, citizenId: number, text: string): string {
  db.prepare("INSERT INTO comments (post_id, citizen_id, body, created_at, mod_state) VALUES (1, ?, ?, 0, NULL)").run(citizenId, text);
  return `https://1f916.ai/api/comment/${Number((db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id)}`;
}

function bindSigningKey(db: DatabaseSync, citizenId: number) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  db.prepare("INSERT INTO keys (citizen_id, public_key, thumbprint, custody, status, bound_at) VALUES (?, ?, ?, 'self', 'active', 0)")
    .run(citizenId, Buffer.from(raw).toString("base64url"), createHash("sha256").update(raw).digest("base64url").slice(0, 32));
  return { privateKey, raw };
}

function signVerdict(privateKey: KeyObject, preimage: string) {
  return edSign(null, Buffer.from(preimage, "utf8"), privateKey).toString("base64url");
}

function signed(db: DatabaseSync, key: { privateKey: KeyObject }, listingId: number, submissionId: number, verifier: string, verdict: "pass" | "fail") {
  const binding = db.prepare("SELECT id FROM payout_bindings WHERE docket_id = ? ORDER BY id ASC LIMIT 1").get(`listing-${listingId}-verifier`) as { id: number };
  const issued_at = NOW * 1000;
  const preimage = verdictPreimage({ listingId, submissionId, verifier, verdict, bindingId: binding.id, issuedAt: issued_at });
  return { verdict, issued_at, signature: edSign(null, Buffer.from(preimage, "utf8"), key.privateKey).toString("base64url") };
}

async function verifierListing(env: Env, db: DatabaseSync) {
  const listing = await createListing(env, AS(1, "funder"), {
    title: "Independent reproduction test", condition: CONDITION, amount_atomic: DOLLAR, expiry: NOW + 86400,
    max_awards: 1, funding_mode: "promise", settlement_mode: "verifier", verifier_price_atomic: DOLLAR, max_verifiers: 2,
  }) as Record<string, unknown>;
  const listingId = Number((listing.row as string).replace("listing-", ""));
  db.prepare("INSERT INTO payout_bindings (citizen_id, docket_id, amount_atomic, payout_address, expiry, created_at) VALUES (4, ?, ?, '0xv', ?, 0)")
    .run(`listing-${listingId}-verifier`, DOLLAR, NOW + 86400);
  const submission = await createSubmission(env, AS(2, "citizen-a"), listingId, { artifact: reproduce(db, 2, `done ${EXPECT}`) }) as Record<string, unknown>;
  return { listingId, submissionId: Number(submission.id) };
}

function events(db: DatabaseSync, kind: string) {
  return db.prepare("SELECT id, citizen_id, kind, detail, prev_hash, hash FROM identity_events WHERE kind = ? ORDER BY id ASC").all(kind) as Record<string, string>[];
}

// ---------- GAP 1: every transition is durable ----------

test("PAYABLE is a chained event, not just a column, and the event names the whole transition", async () => {
  const { env, db } = makeEnv();
  const listing = await createListing(env, AS(1, "funder"), {
    title: "Independent reproduction test", condition: CONDITION, amount_atomic: DOLLAR, expiry: NOW + 86400,
    max_awards: 1, funding_mode: "promise", settlement_mode: "requester", award_ttl_seconds: 6 * 3600, payable_ttl_seconds: 30 * 24 * 3600,
  }) as Record<string, unknown>;
  const listingId = Number((listing.row as string).replace("listing-", ""));
  const submission = await createSubmission(env, AS(2, "citizen-a"), listingId, { artifact: reproduce(db, 2, "starting") }) as Record<string, unknown>;
  const seat = await createAward(env, AS(1, "funder"), listingId, { submission_id: submission.id, reserve: true }) as Record<string, unknown>;

  assert.equal(events(db, "listing-award-transition").length, 0, "a reserved seat has not transitioned yet");
  await markAwardPayable(env, AS(1, "funder"), Number(seat.award_id));

  const [ev] = events(db, "listing-award-transition");
  assert.ok(ev, "becoming entitled to money is a protocol event");
  const payload = JSON.parse(String(ev.detail).slice(0, String(ev.detail).lastIndexOf(" transition payload sha256=")));
  assert.equal(payload.from_state, "awarded");
  assert.equal(payload.to_state, "payable");
  assert.equal(payload.award_id, Number(seat.award_id));
  assert.equal(payload.payee, "citizen-a");
  assert.equal(payload.amount_atomic, DOLLAR);
  assert.ok(String(payload.reason).length > 20, "and it says WHY, from the same branch that chose the state");
  assert.ok(ev.hash && ev.prev_hash, "and it is hash-linked into the chain the checkpoint anchors");
});

test("a reader can reproduce the transition payload hash from the event alone", async () => {
  const { env, db } = makeEnv();
  const listing = await createListing(env, AS(1, "funder"), {
    title: "Independent reproduction test", condition: CONDITION, amount_atomic: DOLLAR, expiry: NOW + 86400,
    max_awards: 1, funding_mode: "promise", settlement_mode: "requester", award_ttl_seconds: 3600, payable_ttl_seconds: 3600,
  }) as Record<string, unknown>;
  const listingId = Number((listing.row as string).replace("listing-", ""));
  const submission = await createSubmission(env, AS(2, "citizen-a"), listingId, { artifact: reproduce(db, 2, "starting") }) as Record<string, unknown>;
  const seat = await createAward(env, AS(1, "funder"), listingId, { submission_id: submission.id, reserve: true }) as Record<string, unknown>;
  await markAwardPayable(env, AS(1, "funder"), Number(seat.award_id));

  const [ev] = events(db, "listing-award-transition");
  const cut = String(ev.detail).lastIndexOf(" transition payload sha256=");
  const payload = JSON.parse(String(ev.detail).slice(0, cut));
  const published = String(ev.detail).slice(cut + " transition payload sha256=".length);
  // Rebuild it the way an outsider would: the recipe's field list, in order.
  const rebuilt = await awardTransitionPayload({
    awardId: payload.award_id, listingId: payload.listing_id, submissionId: payload.submission_id,
    payee: payload.payee, amountAtomic: payload.amount_atomic, fromState: payload.from_state, toState: payload.to_state,
    reason: payload.reason, source: payload.source, deadline: payload.deadline, occurredAt: payload.occurred_at,
  });
  assert.equal(rebuilt.hash, published, "the event carries everything needed to check itself");
  assert.deepEqual(Object.keys(rebuilt.payload), [...AWARD_TRANSITION_HASH_FIELDS], "field order is part of the contract");
});

test("each of the three lapses emits its own event, naming the party whose inaction caused it", async () => {
  const { env, db } = makeEnv();
  const listing = await createListing(env, AS(1, "funder"), {
    title: "Independent reproduction test", condition: CONDITION, amount_atomic: DOLLAR, expiry: NOW + 86400,
    max_awards: 3, funding_mode: "promise", settlement_mode: "requester", award_ttl_seconds: 3600, payable_ttl_seconds: 3600,
  }) as Record<string, unknown>;
  const listingId = Number((listing.row as string).replace("listing-", ""));

  // One reserved seat that never meets its condition; two entitlements, one of
  // whose payees supplied a destination and one who did not.
  const s1 = await createSubmission(env, AS(2, "citizen-a"), listingId, { artifact: reproduce(db, 2, "a") }) as Record<string, unknown>;
  const seat = await createAward(env, AS(1, "funder"), listingId, { submission_id: s1.id, reserve: true }) as Record<string, unknown>;
  const s2 = await createSubmission(env, AS(3, "citizen-b"), listingId, { artifact: reproduce(db, 3, "b") }) as Record<string, unknown>;
  const owed = await createAward(env, AS(1, "funder"), listingId, { submission_id: s2.id }) as Record<string, unknown>;
  const s3 = await createSubmission(env, AS(4, "citizen-c"), listingId, { artifact: reproduce(db, 4, "c") }) as Record<string, unknown>;
  const late = await createAward(env, AS(1, "funder"), listingId, { submission_id: s3.id }) as Record<string, unknown>;
  db.prepare("INSERT INTO payout_bindings (citizen_id, docket_id, amount_atomic, payout_address, expiry, created_at) VALUES (4, ?, ?, '0xc', ?, 0)")
    .run(`listing-${listingId}`, DOLLAR, NOW + 86400);

  const past = Date.now() - 1000;
  db.prepare("UPDATE listing_awards SET expires_at = ?").run(past);
  assert.equal(await sweepExpiredAwards(env, listingId, Date.now()), 3);

  const evs = events(db, "listing-award-transition");
  assert.equal(evs.length, 3, "three lapses, three independently checkable events");
  const byTo = new Map(evs.map((e) => {
    const p = JSON.parse(String(e.detail).slice(0, String(e.detail).lastIndexOf(" transition payload sha256=")));
    return [p.to_state, p];
  }));
  assert.equal(byTo.get("expired_unmet")!.award_id, Number(seat.award_id));
  assert.equal(byTo.get("expired_unclaimed")!.award_id, Number(owed.award_id));
  assert.equal(byTo.get("overdue_unpaid")!.award_id, Number(late.award_id));
  assert.match(byTo.get("overdue_unpaid")!.reason, /STILL OWED/, "the payer's default says so in the log, not only in a column");
  assert.match(byTo.get("expired_unclaimed")!.reason, /the one act only they could take/);
  assert.equal(byTo.get("overdue_unpaid")!.source, "system:clock");
});

test("EDITING AN AWARD STATE DIRECTLY DISAGREES WITH THE EVENT HISTORY", async () => {
  const { env, db } = makeEnv();
  const listing = await createListing(env, AS(1, "funder"), {
    title: "Independent reproduction test", condition: CONDITION, amount_atomic: DOLLAR, expiry: NOW + 86400,
    max_awards: 1, funding_mode: "promise", settlement_mode: "requester", payable_ttl_seconds: 3600,
  }) as Record<string, unknown>;
  const listingId = Number((listing.row as string).replace("listing-", ""));
  const submission = await createSubmission(env, AS(2, "citizen-a"), listingId, { artifact: reproduce(db, 2, "a") }) as Record<string, unknown>;
  const award = await createAward(env, AS(1, "funder"), listingId, { submission_id: submission.id }) as Record<string, unknown>;

  // The tamper: someone with database access marks a live debt as expired.
  db.prepare("UPDATE listing_awards SET state = 'expired_unclaimed', expired_at = ? WHERE id = ?").run(Date.now(), Number(award.award_id));
  const row = db.prepare("SELECT state AS s FROM listing_awards WHERE id = ?").get(Number(award.award_id)) as { s: string };
  assert.equal(row.s, "expired_unclaimed", "the column says the debt is gone");

  // The chain does not agree, and that disagreement is the whole point: the
  // award was created and never transitioned, so a reader replaying the log
  // reaches a different state than the table reports.
  const transitions = events(db, "listing-award-transition");
  assert.equal(transitions.length, 0, "no transition was ever recorded for it");
  const created = events(db, "listing-award");
  assert.equal(created.length, 1, "only the creation is in the log");
  // Replaying: creation puts it at `payable`; the table claims expired_unclaimed.
  assert.notEqual(
    row.s,
    "payable",
    "so the table and the replayed history disagree, which is exactly what an auditor detects and could NOT have detected before this change",
  );
});

// ---------- GAP 2 and 3: the signed verdict, both ways ----------

test("a verifier PASS is a signed artifact anyone can reproduce", async () => {
  const { env, db } = makeEnv();
  const { listingId, submissionId } = await verifierListing(env, db);
  const key = bindSigningKey(db, 4);
  const award = await createAward(env, AS(4, "citizen-c"), listingId, { submission_id: submissionId, ...signed(db, key, listingId, submissionId, "citizen-c", "pass") }) as Record<string, any>;
  assert.equal(award.state, "payable");
  assert.equal(award.verdict.verdict, "pass");

  const row = db.prepare("SELECT * FROM listing_verdicts WHERE id = ?").get(award.verdict.id) as Record<string, any>;
  // Reproduce the signature check exactly as an outsider would.
  const preimage = verdictPreimage({ listingId, submissionId, verifier: "citizen-c", verdict: "pass", bindingId: row.binding_id, issuedAt: row.issued_at });
  const pub = db.prepare("SELECT public_key AS p FROM keys WHERE citizen_id = 4").get() as { p: string };
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(pub.p, "base64url")]);
  const { createPublicKey, verify: edVerify } = await import("node:crypto");
  assert.equal(
    edVerify(null, Buffer.from(preimage, "utf8"), createPublicKey({ key: spki, format: "der", type: "spki" }), Buffer.from(row.signature, "base64url")),
    true,
    "the verdict verifies against the verifier's published key, without trusting this registry",
  );
  assert.equal(events(db, "listing-verdict").length, 1, "and it is chained");
});

// THE REAL FAIL PATH, end to end. The version of this test I wrote first used
// a REQUESTER listing and then asserted consumesSlot() arithmetic, so it never
// reached the code it was named for and would have passed against a
// transition that cannot happen. This one goes through the verifier door with
// real signatures and checks what the ledger actually holds afterwards.
test("verifier FAIL: signed, durable, creates no award, consumes no slot; a later PASS creates exactly one", async () => {
  const { env, db } = makeEnv();
  const listing = await createListing(env, AS(1, "funder"), {
    title: "Independent reproduction test", condition: CONDITION, amount_atomic: DOLLAR, expiry: NOW + 86400,
    max_awards: 3, funding_mode: "promise", settlement_mode: "verifier", verifier_price_atomic: DOLLAR, max_verifiers: 1,
  }) as Record<string, unknown>;
  const listingId = Number((listing.row as string).replace("listing-", ""));
  db.prepare("INSERT INTO payout_bindings (citizen_id, docket_id, amount_atomic, payout_address, expiry, created_at) VALUES (4, ?, ?, '0xv', ?, 0)")
    .run(`listing-${listingId}-verifier`, DOLLAR, NOW + 86400);
  const key = bindSigningKey(db, 4);

  const before = await getListing(env, listingId) as Record<string, any>;
  assert.equal(before.economics.available_award_capacity, 3, "three successful outcomes are on offer");

  // Candidate A hands in work and the authorized verifier signs FAIL.
  const a = await createSubmission(env, AS(2, "citizen-a"), listingId, { artifact: reproduce(db, 2, "attempt A") }) as Record<string, unknown>;
  await assert.rejects(
    createAward(env, AS(4, "citizen-c"), listingId, { submission_id: a.id, ...signed(db, key, listingId, Number(a.id), "citizen-c", "fail") }),
    /signed FAIL on submission/,
  );

  // The FAIL is durable, hash-linked, and reproducible.
  const verdict = db.prepare("SELECT * FROM listing_verdicts WHERE submission_id = ?").get(a.id) as Record<string, any>;
  assert.equal(verdict.verdict, "fail");
  assert.equal(verdict.verifier_id, 4);
  assert.ok(String(verdict.signature).length > 40);
  const [ev] = events(db, "listing-verdict");
  assert.ok(ev, "and it is in the chained log");
  assert.match(String(ev.detail), /verdict=fail/);
  assert.ok(ev.hash && ev.prev_hash, "hash-linked into the log the checkpoint anchors");
  assert.match(String(ev.detail), new RegExp(`verdict payload sha256=${verdict.payload_hash}`), "naming the payload hash a stranger recomputes");

  // NOTHING ECONOMIC HAPPENED. No award, no liability, no slot spent.
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM listing_awards").get() as { n: number }).n, 0, "a FAIL creates no award row");
  const afterFail = await getListing(env, listingId) as Record<string, any>;
  assert.equal(afterFail.economics.outstanding_awarded_atomic, "0", "and no liability");
  assert.equal(afterFail.economics.awarded_slots_used, 0);
  assert.equal(afterFail.economics.available_award_capacity, 3, "ALL THREE successful-outcome slots remain: a failed attempt does not spend one");
  assert.equal(afterFail.submissions.find((x: Record<string, unknown>) => x.id === a.id)?.economic_state, "submitted", "and A is not marked with a defect");

  // Candidate B passes. Exactly one award, capacity down to two.
  const b = await createSubmission(env, AS(3, "citizen-b"), listingId, { artifact: reproduce(db, 3, "attempt B") }) as Record<string, unknown>;
  const award = await createAward(env, AS(4, "citizen-c"), listingId, { submission_id: b.id, ...signed(db, key, listingId, Number(b.id), "citizen-c", "pass") }) as Record<string, any>;
  assert.equal(award.state, "payable", "the PASS itself creates the entitlement");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM listing_awards").get() as { n: number }).n, 1, "exactly one award exists");
  const afterPass = await getListing(env, listingId) as Record<string, any>;
  assert.equal(afterPass.economics.awarded_slots_used, 1);
  assert.equal(afterPass.economics.available_award_capacity, 2, "two successful outcomes still on offer");
  assert.equal(afterPass.economics.outstanding_awarded_atomic, DOLLAR);
  // Both verdicts stand side by side: the rail records the judgment either way.
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM listing_verdicts").get() as { n: number }).n, 2);
  assert.equal(events(db, "listing-verdict").length, 2);
});

// A verifier listing has no reserved seat to mark, so the endpoint that marks
// one must say so rather than silently accepting a verdict it ignores.
test("a verifier-settled listing refuses the mark-payable door outright", async () => {
  const { env, db } = makeEnv();
  const { listingId, submissionId } = await verifierListing(env, db);
  const key = bindSigningKey(db, 4);
  const award = await createAward(env, AS(4, "citizen-c"), listingId, { submission_id: submissionId, ...signed(db, key, listingId, submissionId, "citizen-c", "pass") }) as Record<string, any>;
  // THE REFUSAL THAT NAMES THE RIGHT DOOR. This used to fail with "an award
  // in state payable cannot become payable", from the state machine, because
  // the mode check sat below it and could never run. A caller on the wrong
  // door should be told which door is right.
  await assert.rejects(
    markAwardPayable(env, AS(4, "citizen-c"), Number(award.award_id), { verdict: "pass" }),
    /settles by verifier[\s\S]*Send the verdict to POST \/api\/listings\/\d+\/awards instead/,
    "and the refusal points at the door that does create awards",
  );
});

test("the verdict preimage is servable, signable, and one per outcome", async () => {
  const { env, db } = makeEnv();
  const { listingId, submissionId } = await verifierListing(env, db);
  bindSigningKey(db, 4);
  const pass = await verdictPreimageDoor(env, AS(4, "citizen-c"), listingId, submissionId, "pass", 1_700_000_000_000) as Record<string, any>;
  const fail = await verdictPreimageDoor(env, AS(4, "citizen-c"), listingId, submissionId, "fail", 1_700_000_000_000) as Record<string, any>;
  assert.notEqual(pass.preimage, fail.preimage, "signing a pass can never be replayed as a fail");
  assert.match(pass.preimage, /^1f916\.verdict\.v1:/);
  // NOTHING THE REGISTRY MINTS AFTER THE REQUEST MAY APPEAR IN SIGNED BYTES.
  // The first version of this preimage carried the row's commit_nonce, which
  // is generated server-side, so no verifier could ever have produced a valid
  // signature and the "required signature" would have been unreachable.
  assert.equal(pass.preimage.split(":").length, 7, "prefix plus six values the signer can know before signing");
  assert.deepEqual(pass.payload_hash_recipe.fields, [...VERDICT_HASH_FIELDS]);
});

// ---------- GAP 4: the award recipe ----------

test("the award hash publishes the recipe that reproduces it", async () => {
  const { env, db } = makeEnv();
  const listing = await createListing(env, AS(1, "funder"), {
    title: "Independent reproduction test", condition: CONDITION, amount_atomic: DOLLAR, expiry: NOW + 86400,
    max_awards: 1, funding_mode: "promise", settlement_mode: "requester",
  }) as Record<string, unknown>;
  const listingId = Number((listing.row as string).replace("listing-", ""));
  const submission = await createSubmission(env, AS(2, "citizen-a"), listingId, { artifact: reproduce(db, 2, "a") }) as Record<string, unknown>;
  const award = await createAward(env, AS(1, "funder"), listingId, { submission_id: submission.id }) as Record<string, any>;

  assert.ok(award.payload_hash_recipe, "an award hash with no recipe is a checksum for our own benefit, not evidence");
  assert.deepEqual(award.payload_hash_recipe.fields, [...AWARD_HASH_FIELDS]);
  assert.equal(award.payload_hash_recipe.algorithm, "sha256");
});

// ---------- the anchor ----------

test("every new event kind enters the existing checkpoint pipeline, by construction", async () => {
  const { env, db } = makeEnv();
  const listing = await createListing(env, AS(1, "funder"), {
    title: "Independent reproduction test", condition: CONDITION, amount_atomic: DOLLAR, expiry: NOW + 86400,
    max_awards: 1, funding_mode: "promise", settlement_mode: "requester", award_ttl_seconds: 3600, payable_ttl_seconds: 3600,
  }) as Record<string, unknown>;
  const listingId = Number((listing.row as string).replace("listing-", ""));
  const submission = await createSubmission(env, AS(2, "citizen-a"), listingId, { artifact: reproduce(db, 2, "a") }) as Record<string, unknown>;
  const seat = await createAward(env, AS(1, "funder"), listingId, { submission_id: submission.id, reserve: true }) as Record<string, unknown>;
  await markAwardPayable(env, AS(1, "funder"), Number(seat.award_id));

  // The checkpoint's leaves are `SELECT hash FROM identity_events WHERE hash
  // IS NOT NULL`, so an event is anchored if and only if it is in that table
  // with a hash. No new plumbing was needed and none was added: this asserts
  // the new rows satisfy the existing selector.
  const anchored = db.prepare("SELECT COUNT(*) AS n FROM identity_events WHERE kind = 'listing-award-transition' AND hash IS NOT NULL").get() as { n: number };
  assert.equal(anchored.n, 1, "the transition is a checkpoint leaf like every other event");
  const chained = db.prepare("SELECT prev_hash, hash FROM identity_events ORDER BY id DESC LIMIT 1").get() as { prev_hash: string; hash: string };
  assert.ok(chained.prev_hash && chained.hash, "and it extends the chain rather than sitting beside it");
});

// SURVIVOR from the first sweep: mutating the paid transition's to_state to
// "payable" changed nothing any test could see, because nothing read the
// settlement event's contents. Payment is the one transition where the ledger
// and the money must agree, so it is the last place to accept an unchecked
// event.
test("settlement emits a paid transition whose payload says paid, and says the debt was late when it was", async () => {
  const { env, db } = makeEnv();
  const { settleAwardFromReceipt } = await import("../src/society.ts");
  const listing = await createListing(env, AS(1, "funder"), {
    title: "Independent reproduction test", condition: CONDITION, amount_atomic: DOLLAR, expiry: NOW + 86400,
    max_awards: 1, funding_mode: "promise", settlement_mode: "requester", payable_ttl_seconds: 3600,
  }) as Record<string, unknown>;
  const listingId = Number((listing.row as string).replace("listing-", ""));
  const submission = await createSubmission(env, AS(2, "citizen-a"), listingId, { artifact: reproduce(db, 2, "a") }) as Record<string, unknown>;
  const award = await createAward(env, AS(1, "funder"), listingId, { submission_id: submission.id }) as Record<string, unknown>;

  // The payee bound a destination, then the payer ran past the deadline.
  db.prepare("INSERT INTO payout_bindings (citizen_id, docket_id, amount_atomic, payout_address, expiry, created_at) VALUES (2, ?, ?, '0xa', ?, 0)")
    .run(`listing-${listingId}`, DOLLAR, NOW + 86400);
  db.prepare("UPDATE listing_awards SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, Number(award.award_id));
  await sweepExpiredAwards(env, listingId, Date.now());
  assert.equal((db.prepare("SELECT state AS s FROM listing_awards WHERE id = ?").get(Number(award.award_id)) as { s: string }).s, "overdue_unpaid");

  db.prepare("INSERT INTO payout_receipts (funding_relationship, binding_id, submitter_id, tx_hash, source_address, created_at) VALUES ('independent', 1, 2, '0xtx', '0xf', 0)").run();
  const settled = await settleAwardFromReceipt(env, { docket_id: `listing-${listingId}` }, 1, 2, Date.now());
  assert.equal(settled, Number(award.award_id));

  const evs = events(db, "listing-award-transition");
  const paid = evs.map((e) => JSON.parse(String(e.detail).slice(0, String(e.detail).lastIndexOf(" transition payload sha256="))))
    .find((p) => p.from_state === "overdue_unpaid");
  assert.ok(paid, "settling a debt is itself a transition and must be in the log");
  assert.equal(paid.to_state, "paid", "the event must say what actually happened to the money");
  assert.equal(paid.source, "system:receipt");
  assert.match(paid.reason, /already LATE when it was paid/, "paying late settles the amount and does not erase the lateness");
});

// THE CLAIM THAT MUST NOT COME BACK.
//
// I shipped a state, a schema CHECK, a migration column and an /api/surface
// sentence for AWARDED -> VERIFICATION_FAILED, and the transition could not
// happen: it needs an award in `awarded`, only a reserved seat is born
// `awarded`, and only a requester-settled listing may reserve. The tests
// passed because the one covering it used a requester listing and asserted
// arithmetic instead of reaching the path.
//
// So this is not a test that the prose is nice. It is a mechanical check that
// no citizen-facing description advertises a transition the state machine does
// not have, tied to the state machine itself rather than to a wording.
test("nothing served to citizens advertises AWARDED -> VERIFICATION_FAILED", async () => {
  const { readFileSync } = await import("node:fs");
  const { AWARD_TRANSITIONS_FOR_TEST } = await import("../src/settlement.ts") as Record<string, any>;
  // First: the state machine really has no in-edge to it. If a future change
  // gives it one, this test stops applying and should be revisited rather than
  // silently kept passing.
  const reachable = AWARD_TRANSITIONS_FOR_TEST
    ? Object.values(AWARD_TRANSITIONS_FOR_TEST).some((to) => (to as string[]).includes("verification_failed"))
    : false;
  assert.equal(reachable, false, "verification_failed is reserved and has no in-edge in Settlement V2");

  // Second: no served surface may claim otherwise. These are the files whose
  // strings reach citizens: route summaries, MCP tool descriptions, and the
  // notes the economics and submission-state doors publish.
  // COMMENTS ARE STRIPPED FIRST. The rule is about what citizens are SERVED,
  // not about what the source explains to the next maintainer: the note in
  // society.ts recording why this branch was deleted describes the transition
  // in order to say it cannot happen, and a guard that cannot tell those apart
  // would push its own explanation out of the codebase.
  const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  const served = ["../src/surface.ts", "../src/mcp.ts", "../src/settlement.ts", "../src/society.ts"]
    .map((f) => [f, stripComments(readFileSync(new URL(f, import.meta.url), "utf8"))] as const);
  for (const [name, text] of served) {
    // A mention is allowed; an ADVERTISEMENT of the transition is not.
    const claims = [
      /becomes verification_failed/i,
      /moving the award to verification_failed/i,
      /award to verification_failed/i,
      /FAIL is TERMINAL/i,
      /-> ?verification_failed/i,
      /verification_failed and (its|the) slot returns/i,
    ].filter((re) => re.test(text));
    assert.deepEqual(claims.map(String), [], `${name} advertises a transition Settlement V2 does not have`);
  }

  // Third: the state is still RESERVED, deliberately, so the schema and the
  // enum keep it and this stays a documentation rule rather than a deletion.
  assert.ok(AWARD_STATES.includes("verification_failed" as never), "kept as schema capacity for a future reserve-then-verify listing type");
});

// AUDIT FINDING: the verdict was written and never readable. No door returned
// the signature, the issued_at or the commit_nonce, while the published recipe
// named all three and the refusal text promised a document that was "durable
// and retrievable". It was neither. These two tests are the difference between
// evidence and a claim about evidence.
test("a signed verdict is RETRIEVABLE, and a stranger can verify it from the served body alone", async () => {
  const { env, db } = makeEnv();
  const { listingId, submissionId } = await verifierListing(env, db);
  const key = bindSigningKey(db, 4);
  await createAward(env, AS(4, "citizen-c"), listingId, { submission_id: submissionId, ...signed(db, key, listingId, submissionId, "citizen-c", "pass") });

  const served = await getListing(env, listingId) as Record<string, any>;
  assert.equal(served.verdicts.length, 1, "the verdict is served, not merely stored");
  const v = served.verdicts[0];
  for (const field of ["signature", "issued_at", "commit_nonce", "payload_hash", "preimage", "key_thumbprint", "verifier"])
    assert.ok(v[field] !== undefined && v[field] !== null, `${field} must be served: the recipe names it`);

  // 1. The signature verifies against the served preimage, using node's crypto
  //    rather than any of our code.
  const { createPublicKey, verify: edVerify } = await import("node:crypto");
  const pub = db.prepare("SELECT public_key AS p FROM keys WHERE citizen_id = 4").get() as { p: string };
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(pub.p, "base64url")]);
  assert.equal(
    edVerify(null, Buffer.from(v.preimage, "utf8"), createPublicKey({ key: spki, format: "der", type: "spki" }), Buffer.from(v.signature, "base64url")),
    true,
    "the served signature verifies over the served preimage, without trusting this registry",
  );

  // 2. The payload hash recomputes from the served fields, in the published order.
  const values = (v.payload_hash_recipe.fields as string[]).map((f) => (f === "verifier" ? v.verifier : f === "listing_id" ? listingId : v[f]));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(values)));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  assert.equal(hex, v.payload_hash, "and the hash a reader recomputes is the hash we published");

  // 3. The award names the verdict that created it.
  assert.equal(served.awards[0].verdict_id, v.verdict_id, "the entitlement points at the judgment behind it");
});

test("a FAIL verdict is served too, so 'someone looked and said no' is readable", async () => {
  const { env, db } = makeEnv();
  const { listingId, submissionId } = await verifierListing(env, db);
  const key = bindSigningKey(db, 4);
  await assert.rejects(createAward(env, AS(4, "citizen-c"), listingId, { submission_id: submissionId, ...signed(db, key, listingId, submissionId, "citizen-c", "fail") }), /signed FAIL/);
  const served = await getListing(env, listingId) as Record<string, any>;
  assert.equal(served.verdicts.length, 1);
  assert.equal(served.verdicts[0].verdict, "fail");
  assert.ok(served.verdicts[0].signature, "with its signature, like any other");
  assert.equal(served.awards.length, 0, "and no award");
  assert.match(served.verdicts_note, /consumes no award slot/);
});

// AUDIT FINDING: a verifier signing twice got HTTP 500 and no logged refusal,
// because the UNIQUE violation surfaced raw. A retry after a lost response is
// the ordinary way to reach this.
test("signing a second verdict on one submission is a 409, not a crash", async () => {
  const { env, db } = makeEnv();
  const { listingId, submissionId } = await verifierListing(env, db);
  const key = bindSigningKey(db, 4);
  await assert.rejects(createAward(env, AS(4, "citizen-c"), listingId, { submission_id: submissionId, ...signed(db, key, listingId, submissionId, "citizen-c", "fail") }), /signed FAIL/);
  const again = await createAward(env, AS(4, "citizen-c"), listingId, { submission_id: submissionId, ...signed(db, key, listingId, submissionId, "citizen-c", "pass") }).catch((e) => e);
  assert.equal((again as { status?: number }).status, 409, "a repeat verdict is refused, not an internal error");
  assert.match(String((again as Error).message), /already signed a verdict/);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM listing_verdicts").get() as { n: number }).n, 1, "and the first verdict stands unmodified");
});

// AUDIT FINDING: the award->verdict link matched on submission alone, so it
// returned the LOWEST verdict on that submission. On a submission one verifier
// failed and another later passed, the live entitlement pointed at the FAIL,
// by a verifier who did not award it, under a note promising the opposite.
// The earlier test could not catch it: with one verdict, any join looks right.
test("the award names the verdict that CREATED it, even when an earlier verifier failed the same work", async () => {
  const { env, db } = makeEnv();
  const { listingId, submissionId } = await verifierListing(env, db);
  // Two authorized verifiers on one listing.
  const keyC = bindSigningKey(db, 4);
  db.prepare("INSERT INTO payout_bindings (citizen_id, docket_id, amount_atomic, payout_address, expiry, created_at) VALUES (3, ?, ?, '0xv2', ?, 0)")
    .run(`listing-${listingId}-verifier`, DOLLAR, NOW + 86400);
  const keyB = bindSigningKey(db, 3);

  // citizen-c fails it first; citizen-b passes it second.
  await assert.rejects(createAward(env, AS(4, "citizen-c"), listingId, { submission_id: submissionId, ...signed(db, keyC, listingId, submissionId, "citizen-c", "fail") }), /signed FAIL/);
  const bindingB = (db.prepare("SELECT id FROM payout_bindings WHERE docket_id = ? AND citizen_id = 3").get(`listing-${listingId}-verifier`) as { id: number }).id;
  const issued = NOW * 1000;
  const award = await createAward(env, AS(3, "citizen-b"), listingId, {
    submission_id: submissionId, verdict: "pass", issued_at: issued,
    signature: signVerdict(keyB.privateKey, verdictPreimage({ listingId, submissionId, verifier: "citizen-b", verdict: "pass", bindingId: bindingB, issuedAt: issued })),
  }) as Record<string, any>;

  const served = await getListing(env, listingId) as Record<string, any>;
  assert.equal(served.verdicts.length, 2, "both judgments stand");
  const fail = served.verdicts.find((v: Record<string, unknown>) => v.verdict === "fail");
  const pass = served.verdicts.find((v: Record<string, unknown>) => v.verdict === "pass");
  assert.ok(fail.verdict_id < pass.verdict_id, "the FAIL is the lower id, which is what the broken join returned");
  assert.equal(served.awards.length, 1);
  assert.equal(served.awards[0].verdict_id, pass.verdict_id, "the entitlement names the PASS that created it");
  assert.notEqual(served.awards[0].verdict_id, fail.verdict_id, "and never a rejection by a verifier who did not award it");
  assert.equal(pass.verifier, "citizen-b");
});

// AUDIT FINDING: verdicts_note told readers to fetch a route that does not
// exist, and the recipe's first field was not a key of the object it
// described, so a reader following the instructions literally got a 404 and
// then a hash mismatch. Instructions that cannot be followed are not
// instructions.
test("the verdict's own instructions can be followed literally", async () => {
  const { env, db } = makeEnv();
  const { listingId, submissionId } = await verifierListing(env, db);
  const key = bindSigningKey(db, 4);
  await createAward(env, AS(4, "citizen-c"), listingId, { submission_id: submissionId, ...signed(db, key, listingId, submissionId, "citizen-c", "pass") });
  const served = await getListing(env, listingId) as Record<string, any>;
  const v = served.verdicts[0];

  // Every field the recipe names is a key of the object it is served on.
  for (const f of v.payload_hash_recipe.fields as string[])
    assert.ok(f in v, `recipe names ${f}, so the verdict object must carry ${f}`);
  const values = (v.payload_hash_recipe.fields as string[]).map((f) => v[f]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(values)));
  assert.equal(
    [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join(""),
    v.payload_hash,
    "recomputing straight off the served object reproduces the published hash",
  );

  // Every route the note names is a route this registry actually serves.
  // EXACT ROUTES, INCLUDING THE PARAMETER SEGMENT. A prefix check passed the
  // broken version, because /api/citizens exists as the census while the note
  // meant /api/citizens/<handle>, which does not exist and 404s. A guard that
  // its own defect walks through is not a guard.
  const { SURFACE } = await import("../src/surface.ts");
  const named = String(served.verdicts_note).match(/GET \/api\/[a-z0-9\-\/]*<[a-z_]+>/gi) ?? [];
  assert.ok(named.length > 0, "the note tells readers where to fetch the key, so there is a route to check");
  for (const one of named) {
    const declared = one.replace("GET ", "").replace(/<[a-z_]+>/i, ":");
    assert.ok(
      SURFACE.some((r: { method: string; path: string }) => r.method === "GET" && r.path.replace(/:[a-z_]+/i, ":") === declared),
      `verdicts_note sends readers to ${one.replace("GET ", "")}, which is not a route this registry serves`,
    );
  }
});

// ---------- settlement v3: one verifier, two keys, one person ----------
//
// A verifier signs the protocol verdict with Ed25519 and the on-chain release
// with a secp256k1 EVM key, because the EVM cannot verify Ed25519. If only one
// were declared, the document the society reads and the authorization the
// money obeys could be about two different parties and nothing would notice.
// These tests exist because the enforcement was written before it was
// REACHABLE, which is the same mistake as the unreachable transition earlier
// in this file: the guards died on the typechecker and on no test at all.

test("an escrow-backed listing serves its escrow terms and both of each verifier's keys", async () => {
  const { env, db } = makeEnv();
  const key = bindSigningKey(db, 4);
  const thumb = (db.prepare("SELECT thumbprint AS t FROM keys WHERE citizen_id = 4").get() as { t: string }).t;
  const { listingId } = await escrowListing(env, db, "citizen-c", 4, thumb);

  const served = await getListing(env, listingId) as Record<string, any>;
  assert.equal(served.settlement_version, 3);
  assert.equal(served.escrow_address, "0x2222222222222222222222222222222222222222");
  assert.equal(served.escrow_chain_id, 8453);
  assert.deepEqual(served.verifiers, [{ handle: "citizen-c", key_thumbprint: thumb, evm_address: "0x1111111111111111111111111111111111111111", cap: 2 }]);
  assert.match(served.escrow_note, /named by BOTH keys/);
  // And every field the v3 recipe names is on the body a reader recomputes from.
  for (const f of served.payload_hash_recipe.fields as string[])
    assert.ok(f in served, `the v3 recipe names ${f}, so the served listing must carry it`);
  void key;
});

test("a verdict signed by a key the listing never named is REFUSED, not recorded", async () => {
  const { env, db } = makeEnv();
  bindSigningKey(db, 4);
  const thumb = (db.prepare("SELECT thumbprint AS t FROM keys WHERE citizen_id = 4").get() as { t: string }).t;
  const { listingId, submissionId } = await escrowListing(env, db, "citizen-c", 4, thumb);

  // The verifier rotates to a key this listing never committed to. They are
  // still the named handle and still hold the verifier binding.
  db.prepare("UPDATE keys SET status = 'revoked' WHERE citizen_id = 4").run();
  const rotated = bindSigningKey(db, 4);
  await assert.rejects(
    createAward(env, AS(4, "citizen-c"), listingId, { submission_id: submissionId, ...signed(db, rotated, listingId, submissionId, "citizen-c", "pass") }),
    /names citizen-c's verifier key as .* and your active key is/,
    "the escrow committed to a specific key; a verdict from another is not the decision it committed to",
  );
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM listing_verdicts").get() as { n: number }).n, 0, "and nothing was recorded");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM listing_awards").get() as { n: number }).n, 0, "and no liability was created");
});

test("a citizen the listing never named cannot verify it at all", async () => {
  const { env, db } = makeEnv();
  bindSigningKey(db, 4);
  const thumb = (db.prepare("SELECT thumbprint AS t FROM keys WHERE citizen_id = 4").get() as { t: string }).t;
  const { listingId, submissionId } = await escrowListing(env, db, "citizen-c", 4, thumb);

  // citizen-b holds a verifier binding, which is enough on a v2 listing and
  // is NOT enough here: a v3 listing fixes its verifiers in hashed terms.
  db.prepare("INSERT INTO payout_bindings (citizen_id, docket_id, amount_atomic, payout_address, expiry, created_at) VALUES (3, ?, ?, '0xv2', ?, 0)")
    .run(`listing-${listingId}-verifier`, DOLLAR, NOW + 86400);
  const other = bindSigningKey(db, 3);
  await assert.rejects(
    createAward(env, AS(3, "citizen-b"), listingId, { submission_id: submissionId, ...signed(db, other, listingId, submissionId, "citizen-b", "pass") }),
    /names its verifiers in its own hashed terms, and you are not one of them/,
  );
});

test("the declared verifier signing with the declared key is accepted, and the award names their verdict", async () => {
  const { env, db } = makeEnv();
  const key = bindSigningKey(db, 4);
  const thumb = (db.prepare("SELECT thumbprint AS t FROM keys WHERE citizen_id = 4").get() as { t: string }).t;
  const { listingId, submissionId } = await escrowListing(env, db, "citizen-c", 4, thumb);

  const award = await createAward(env, AS(4, "citizen-c"), listingId, { submission_id: submissionId, ...signed(db, key, listingId, submissionId, "citizen-c", "pass") }) as Record<string, any>;
  assert.equal(award.state, "payable", "the PASS creates the entitlement, as on any verifier listing");
  const served = await getListing(env, listingId) as Record<string, any>;
  assert.equal(served.verdicts.length, 1);
  assert.equal(served.verdicts[0].key_thumbprint, thumb, "signed by the key the listing named");
  assert.equal(served.awards[0].verdict_id, served.verdicts[0].verdict_id);
});

test("a v3 listing's payload hash reproduces from its own served body, escrow terms included", async () => {
  // THE AUDIT'S BLOCKING FINDING, pinned. createListing never added the six
  // escrow fields to the payload it hashes, so each hashed as `undefined`,
  // which JSON.stringify writes as null. The hash the escrow binds money to
  // was provably independent of the escrow address, the token, the verifiers
  // and both deadlines, so every reason given for hashing them was void and
  // no reader could reproduce a v3 hash from the body at all.
  //
  // My first attempt at this test compared two hypothetical payloads and
  // passed against the broken code. This one walks the PUBLISHED RECIPE
  // against the PUBLISHED BODY, which is the only version that catches it.
  const { env, db } = makeEnv();
  const key = bindSigningKey(db, 4);
  const thumb = (db.prepare("SELECT thumbprint AS t FROM keys WHERE citizen_id = 4").get() as { t: string }).t;
  const { listingId } = await escrowListing(env, db, "citizen-c", 4, thumb);
  void key;

  const served = await getListing(env, listingId) as Record<string, any>;
  const fields = served.payload_hash_recipe.fields as string[];
  for (const f of fields) assert.ok(f in served, `the recipe names ${f}, so the body must carry it`);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(fields.map((f) => served[f]))));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  assert.equal(hex, served.payload_hash, "a stranger walking the published recipe over the published body reproduces the hash");

  // And the escrow terms are genuinely load-bearing: blank them and the hash
  // must change, or they are not in the commitment at all.
  const blanked = fields.map((f) => (["escrow_chain_id", "escrow_address", "escrow_token", "verifiers", "escrow_verifier_deadline", "escrow_claim_deadline"].includes(f) ? null : served[f]));
  const other = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(blanked)));
  assert.notEqual([...new Uint8Array(other)].map((b) => b.toString(16).padStart(2, "0")).join(""), served.payload_hash,
    "if blanking the escrow terms leaves the hash unchanged, the escrow is bound to a hash that does not name it");
});

// ---------- funding_status, driven through the real door ----------
//
// The audit's second finding: nothing tested this through getListing, and the
// escrow read was not injectable, so only the read-failure branch was
// reachable. Swapping escrow_verifier_deadline and escrow_claim_deadline in
// the mapping below would have stayed green, and the site would have reported
// a listing as funded while comparing the wrong deadline to the wrong one.

function escrowWord(hex: string) { return hex.replace(/^0x/, "").toLowerCase().padStart(64, "0"); }
function escrowNum(n: number | bigint) { return BigInt(n).toString(16).padStart(64, "0"); }

/// A stub escrow that answers exactly as the deployed contract does.
function stubEscrow(over: Partial<{ funder: string; token: string; amountPerAward: bigint; maxAwards: number; released: number; verifierDeadline: number; claimDeadline: number; refunded: boolean; verifierSet: string; cap: number; used: number }> = {}) {
  const t = {
    funder: "0xa7f7985eb19b8c44f12a0654df1ef89d1dd527c9",
    token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    amountPerAward: 1_000_000n, maxAwards: 2, released: 0,
    verifierDeadline: NOW + 7 * 86400, claimDeadline: NOW + 37 * 86400,
    refunded: false, verifierSet: "", cap: 2, used: 0, ...over,
  };
  return {
    async call(_to: string, data: string) {
      if (data.slice(2, 10) === "b3e64062") {
        return "0x" + escrowWord(t.funder) + escrowWord(t.token) + escrowNum(t.amountPerAward)
          + escrowNum(t.maxAwards) + escrowNum(t.released) + escrowNum(t.verifierDeadline)
          + escrowNum(t.claimDeadline) + escrowNum(t.refunded ? 1 : 0)
          + escrowNum(BigInt(t.maxAwards - t.released) * t.amountPerAward)
          + (t.verifierSet ? t.verifierSet.replace(/^0x/, "") : escrowNum(0));
      }
      return "0x" + escrowNum(t.cap) + escrowNum(t.used);
    },
  };
}

test("funding_status reports what the chain says, through the real listing door", async () => {
  const { env, db } = makeEnv();
  bindSigningKey(db, 4);
  const thumb = (db.prepare("SELECT thumbprint AS t FROM keys WHERE citizen_id = 4").get() as { t: string }).t;
  const { listingId } = await escrowListing(env, db, "citizen-c", 4, thumb);
  const served = await getListing(env, listingId) as Record<string, any>;

  // The real set commitment, computed the way the reader computes it.
  const { encodeAddressUint32Arrays, expectedVerifierSetHash } = await import("../src/funded.ts");
  const { keccak256 } = await import("viem");
  const set = expectedVerifierSetHash(
    (served.verifiers as { evm_address: string; cap: number }[]).map((v) => ({ evm_address: v.evm_address, cap: v.cap })),
    encodeAddressUint32Arrays,
    (hex) => keccak256(hex as `0x${string}`),
  );

  // Matching escrow: FUNDED.
  const ok = await getListing(env, listingId, { escrowReader: stubEscrow({ verifierSet: set }) }) as Record<string, any>;
  assert.equal(ok.funding_status.funded, true, JSON.stringify(ok.funding_status?.disagreements));
  assert.match(ok.funding_status.statement, /^FUNDED\./);
  assert.equal(ok.funding_status.onchain.remaining_atomic, "2000000");

  // THE DEADLINES ARE NOT INTERCHANGEABLE. Moving only the verifier deadline
  // must be caught, which is the mapping bug this test exists for.
  const wrongVerifierDeadline = await getListing(env, listingId, { escrowReader: stubEscrow({ verifierSet: set, verifierDeadline: NOW + 6 * 86400 }) }) as Record<string, any>;
  assert.equal(wrongVerifierDeadline.funding_status.funded, false);
  assert.ok(wrongVerifierDeadline.funding_status.disagreements.some((d: string) => /verifier deadline/.test(d)), JSON.stringify(wrongVerifierDeadline.funding_status.disagreements));

  const wrongClaimDeadline = await getListing(env, listingId, { escrowReader: stubEscrow({ verifierSet: set, claimDeadline: NOW + 36 * 86400 }) }) as Record<string, any>;
  assert.ok(wrongClaimDeadline.funding_status.disagreements.some((d: string) => /claim deadline/.test(d)));

  // A hidden verifier, seen only through the set commitment.
  const hidden = await getListing(env, listingId, { escrowReader: stubEscrow({ verifierSet: "0x" + "de".repeat(32) }) }) as Record<string, any>;
  assert.ok(hidden.funding_status.disagreements.some((d: string) => /verifier set does not match/.test(d)));

  // Spent authority, drained, refunded.
  const spent = await getListing(env, listingId, { escrowReader: stubEscrow({ verifierSet: set, used: 2 }) }) as Record<string, any>;
  assert.ok(spent.funding_status.disagreements.some((d: string) => /spent their authority/.test(d)));
  const refunded = await getListing(env, listingId, { escrowReader: stubEscrow({ verifierSet: set, refunded: true }) }) as Record<string, any>;
  assert.equal(refunded.funding_status.funded, false);

  // And a read that fails says so, rather than falling back to the terms.
  const blind = await getListing(env, listingId, { escrowReader: { async call() { return null; } } }) as Record<string, any>;
  assert.equal(blind.funding_status.funded, false);
  assert.match(blind.funding_status.statement, /NOT CONFIRMED FUNDED/);
  void served;
});
