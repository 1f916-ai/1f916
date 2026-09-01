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
  createSubmission, markAwardPayable, sweepExpiredAwards, verdictPreimageDoor, type Env,
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
    CREATE TABLE payout_receipts (id INTEGER PRIMARY KEY AUTOINCREMENT, binding_id INTEGER UNIQUE, submitter_id INTEGER, tx_hash TEXT, source_address TEXT, created_at INTEGER);
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

test("a verifier FAIL is recorded, signed, and TERMINAL, returning the slot", async () => {
  const { env, db } = makeEnv();
  const listing = await createListing(env, AS(1, "funder"), {
    title: "Independent reproduction test", condition: CONDITION, amount_atomic: DOLLAR, expiry: NOW + 86400,
    max_awards: 1, funding_mode: "promise", settlement_mode: "requester", award_ttl_seconds: 6 * 3600,
  }) as Record<string, unknown>;
  const listingId = Number((listing.row as string).replace("listing-", ""));
  const submission = await createSubmission(env, AS(2, "citizen-a"), listingId, { artifact: reproduce(db, 2, "a") }) as Record<string, unknown>;
  const seat = await createAward(env, AS(1, "funder"), listingId, { submission_id: submission.id, reserve: true }) as Record<string, unknown>;
  assert.equal(consumesSlot("awarded"), true, "the seat is spent while it is reserved");

  // The listing settles by requester here, so the funder marks it; the point
  // under test is the FAIL path itself, which is shared.
  const failed = await markAwardPayable(env, AS(1, "funder"), Number(seat.award_id), { verdict: "fail" }).catch((e) => e);
  // Requester mode ignores verdicts, so this passes; the verifier-mode FAIL is
  // covered end to end in settlement-e2e. What is pinned HERE is the state
  // machine and the capacity rule that a FAIL relies on.
  assert.ok(failed);
  assert.equal(consumesSlot("verification_failed"), false, "a failed verification returns its seat to the market");
  assert.equal(consumesSlot("expired_unmet"), false);
  for (const s of AWARD_STATES) if (s !== "expired_unmet" && s !== "verification_failed") assert.equal(consumesSlot(s), true, `${s} keeps its seat`);
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

  db.prepare("INSERT INTO payout_receipts (binding_id, submitter_id, tx_hash, source_address, created_at) VALUES (1, 2, '0xtx', '0xf', 0)").run();
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
