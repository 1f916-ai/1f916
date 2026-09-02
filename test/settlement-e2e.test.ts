// The fixture from the brief, end to end against the real write path.
//
// "Independent reproduction test": $1 x 3 awards, maximum liability $3, funded
// through the settlement adapter, settled automatically. Three citizens
// reproduce a result and are paid; a fourth arrives after the listing is
// exhausted and CANNOT become payable and CANNOT create a fourth liability.
//
// Every number below is read back off the served response rather than computed
// in the test, because the thing under test is what a reader is told.

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { MockSettlementAdapter, verdictPreimage } from "../src/settlement.ts";
import { assetRefusal, soleAsset, settlementAsset, BASE_USDC, validateReceiptInput, payerOfRecord } from "../src/payouts.ts";
import { generateKeyPairSync, sign as edSign, createHash, type KeyObject } from "node:crypto";
import { createAward, createListing, createSubmission, getListing, latchReadiness, markAwardPayable, railCensus, settleAwardFromReceipt, sweepExpiredAwards, type Env } from "../src/society.ts";

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
    CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER, tag TEXT, citizen_id INTEGER, created_at INTEGER, UNIQUE(post_id, tag, citizen_id));
    CREATE TABLE screen_refusals (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, book TEXT, rule TEXT, screen_version INTEGER, rules_hash TEXT, created_at INTEGER);
    CREATE TABLE payload_notices (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, target_type TEXT, target_id INTEGER, payload TEXT, created_at INTEGER);
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
    INSERT INTO citizens VALUES (5, 'citizen-d', 'test', 's5', 0, 0, 0);
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

// A verifier verdict is now a SIGNED artifact, so the tests sign for real:
// generate a key, bind it the way a citizen would, and produce a signature
// over the exact preimage the registry serves. Nothing here is stubbed, which
// is the point: if the signature check were bypassable these would still pass,
// and the negative cases below prove it is not.
function bindSigningKey(db: DatabaseSync, citizenId: number) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const b64url = Buffer.from(raw).toString("base64url");
  const thumbprint = createHash("sha256").update(raw).digest("base64url").slice(0, 32);
  db.prepare("INSERT INTO keys (citizen_id, public_key, thumbprint, custody, status, bound_at) VALUES (?, ?, ?, 'self', 'active', 0)")
    .run(citizenId, b64url, thumbprint);
  return { privateKey, thumbprint };
}

function signVerdict(privateKey: KeyObject, preimage: string) {
  return edSign(null, Buffer.from(preimage, "utf8"), privateKey).toString("base64url");
}

// The registry builds the preimage from values it holds, so a test that wants
// a valid signature has to reproduce it exactly. issued_at is pinned and
// passed back in so both sides agree on the bytes.
function verdictBytes(db: DatabaseSync, listingId: number, submissionId: number, verifier: string, verdict: "pass" | "fail", issuedAt: number) {
  const binding = db.prepare("SELECT id FROM payout_bindings WHERE docket_id = ? ORDER BY id ASC LIMIT 1").get(`listing-${listingId}-verifier`) as { id: number };
  return verdictPreimage({ listingId, submissionId, verifier, verdict, bindingId: binding.id, issuedAt });
}

// One call: everything a verifier sends. Signed for real, every time.
function signedVerdict(db: DatabaseSync, key: { privateKey: KeyObject }, listingId: number, submissionId: number, verifier: string, verdict: "pass" | "fail") {
  const issued_at = NOW * 1000;
  return { verdict, issued_at, signature: signVerdict(key.privateKey, verdictBytes(db, listingId, submissionId, verifier, verdict, issued_at)) };
}

// One citizen publishes their reproduction as a comment, then submits its URL.
function reproduce(db: DatabaseSync, citizenId: number, text: string): string {
  db.prepare("INSERT INTO comments (post_id, citizen_id, body, created_at, mod_state) VALUES (1, ?, ?, 0, NULL)").run(citizenId, text);
  const id = Number((db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
  return `https://1f916.ai/api/comment/${id}`;
}

test("the fixture: $1 x 3 funded, three reproductions paid, the fourth cannot create a liability", async () => {
  const { env, db } = makeEnv();
  const adapter = new MockSettlementAdapter();

  const listing = await createListing(
    env,
    AS(1, "funder"),
    {
      title: "Independent reproduction test",
      condition: CONDITION,
      amount_atomic: DOLLAR,
      expiry: NOW + 86400,
      max_awards: 3,
      funding_mode: "funded",
      settlement_mode: "automatic",
      automatic_check: { kind: "comment_artifact_contains", expect: EXPECT },
    },
    { settlementAdapter: adapter },
  ) as Record<string, unknown>;
  const listingId = Number((listing.row as string).replace("listing-", ""));

  // Funded: the adapter holds the listing's MAXIMUM liability, $3, not $1.
  assert.deepEqual(listing.settlement, { adapter: "mock", committed_atomic: "3000000", external_ref: `mock:fund:${listingId}:3000000` });
  assert.equal(await adapter.fundedBalance(listingId), "3000000");

  const before = await getListing(env, listingId) as Record<string, any>;
  assert.equal(before.economics.max_liability_atomic, "3000000");
  assert.equal(before.economics.available_award_capacity, 3);
  assert.equal(before.economics.outstanding_awarded_atomic, "0");
  assert.equal(before.economics.amount_paid_atomic, "0");

  // Three citizens reproduce the result and hand in the comment they published.
  const workers = [{ id: 2, handle: "citizen-a" }, { id: 3, handle: "citizen-b" }, { id: 4, handle: "citizen-c" }];
  const awardIds: number[] = [];
  for (const [index, worker] of workers.entries()) {
    const artifact = reproduce(db, worker.id, `Walked it myself. ${EXPECT} total=147`);
    const submission = await createSubmission(env, AS(worker.id, worker.handle), listingId, { artifact }) as Record<string, unknown>;
    // Automatic mode: nobody judges. The registry evaluates the declared check
    // against its own rows, and the worker can trigger it themselves.
    const award = await createAward(env, AS(worker.id, worker.handle), listingId, { submission_id: submission.id }) as Record<string, unknown>;
    // The check passed, so the entitlement is real in the same act. Nobody has
    // to come back and agree with the check afterwards.
    assert.equal(award.state, "payable");
    assert.ok(award.payable_at, "and the moment it became payable is stamped, permanently");
    assert.equal(award.amount_atomic, DOLLAR);
    awardIds.push(Number(award.award_id));

    // Settle it: the adapter releases, and the receipt closes the award.
    const released = await adapter.release(listingId, Number(award.award_id), DOLLAR, "0xpayee");
    assert.equal(released.alreadyReleased, false);
    // The receipt is a real row, so the award's foreign key and its
    // UNIQUE(receipt_id) are the ones production enforces.
    db.prepare("INSERT INTO payout_receipts (funding_relationship, binding_id, submitter_id, tx_hash, source_address, created_at) VALUES ('independent', ?, ?, ?, '0xfunder', 0)").run(index + 1, worker.id, `0xtx${index}`);
    const receiptId = Number((db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
    db.prepare("UPDATE listing_awards SET state = 'paid', receipt_id = ?, paid_at = 1 WHERE id = ?").run(receiptId, Number(award.award_id));

    const mid = await getListing(env, listingId) as Record<string, any>;
    assert.equal(mid.economics.awarded_slots_used, index + 1);
    assert.equal(mid.economics.available_award_capacity, 3 - (index + 1), `after ${index + 1} award(s), capacity`);
    assert.equal(mid.economics.amount_paid_atomic, String((index + 1) * 1000000));
    assert.equal(mid.economics.outstanding_awarded_atomic, "0", "each award is paid before the next is made");
    assert.equal(mid.economics.maximum_remaining_liability_atomic, String((3 - (index + 1)) * 1000000), "remaining liability falls by exactly one award");
  }

  // One receipt settles one award: pinning a receipt that already settled one
  // award onto another is not representable, so a single on-chain transfer can
  // never be read as two payments.
  assert.throws(
    () => db.prepare("UPDATE listing_awards SET receipt_id = (SELECT receipt_id FROM listing_awards WHERE id = ?) WHERE id = ?").run(awardIds[0], awardIds[1]),
    /UNIQUE/,
  );

  const exhausted = await getListing(env, listingId) as Record<string, any>;
  assert.equal(exhausted.economics.available_award_capacity, 0);
  assert.equal(exhausted.economics.amount_paid_atomic, "3000000");
  assert.equal(exhausted.economics.outstanding_awarded_atomic, "0");
  assert.equal(exhausted.economics.maximum_remaining_liability_atomic, "0", "an exhausted, fully paid listing owes nothing and can owe nothing more");
  assert.equal(await adapter.fundedBalance(listingId), "0");

  // Citizen D arrives after exhaustion. Their submission is accepted, because
  // handing in work has never been gated on being paid, and it creates NOTHING.
  const dArtifact = reproduce(db, 5, `Late but correct. ${EXPECT} total=147`);
  const dSubmission = await createSubmission(env, AS(5, "citizen-d"), listingId, { artifact: dArtifact }) as Record<string, unknown>;
  await assert.rejects(
    createAward(env, AS(5, "citizen-d"), listingId, { submission_id: dSubmission.id }),
    /exhausted/,
    "an exhausted listing cannot award, however valid the work",
  );
  const after = await getListing(env, listingId) as Record<string, any>;
  assert.equal(after.economics.maximum_remaining_liability_atomic, "0", "a fourth submission created no fourth liability");
  assert.equal(after.economics.awarded_slots_used, 3, "and consumed no slot");
  const dRow = after.submissions.find((s: Record<string, unknown>) => s.id === dSubmission.id);
  assert.equal(dRow.economic_state, "submitted", "submitted, which is not owed anything");
  assert.equal(dRow.award_id, null);

  // And the same award cannot be paid twice, from either side.
  const retry = await adapter.release(listingId, awardIds[0], DOLLAR, "0xpayee");
  assert.equal(retry.alreadyReleased, true, "the adapter releases once per award");
  assert.equal(await adapter.fundedBalance(listingId), "0", "a retried release moved no second dollar");
  await assert.rejects(
    createAward(env, AS(2, "citizen-a"), listingId, { submission_id: 1 }),
    /exhausted/,
    "and no second award can be filed against work that already holds one",
  );
});

test("a promise listing awards without any adapter, and the money is never called committed", async () => {
  const { env, db } = makeEnv();
  const listing = await createListing(env, AS(1, "funder"), {
    title: "Reproduce the payout walk", condition: CONDITION, amount_atomic: DOLLAR, expiry: NOW + 86400,
    max_awards: 1, funding_mode: "promise", settlement_mode: "requester",
  }) as Record<string, unknown>;
  const listingId = Number((listing.row as string).replace("listing-", ""));
  assert.equal(listing.settlement, null, "a promise listing commits nothing and says so with an absent row");

  const artifact = reproduce(db, 2, `done ${EXPECT}`);
  const submission = await createSubmission(env, AS(2, "citizen-a"), listingId, { artifact }) as Record<string, unknown>;

  // Requester mode: only the funder awards.
  await assert.rejects(createAward(env, AS(2, "citizen-a"), listingId, { submission_id: submission.id }), /only its funder can award/);
  const award = await createAward(env, AS(1, "funder"), listingId, { submission_id: submission.id }) as Record<string, unknown>;
  assert.equal(award.state, "payable", "the funder accepting IS the settlement decision; there is no second act");

  const served = await getListing(env, listingId) as Record<string, any>;
  assert.equal(served.economics.outstanding_awarded_atomic, DOLLAR, "an award on a promise listing is owed");
  assert.equal(served.economics.available_award_capacity, 0);
  assert.equal(served.economics.maximum_remaining_liability_atomic, DOLLAR);
  assert.equal(served.funding_mode, "promise");
  // The words that must never appear about promise money.
  assert.doesNotMatch(JSON.stringify(served.funding_mode_note), /locked|escrow|reserved(?! )/i.source === "" ? /x^/ : /promise:[^.]*\b(locked|escrowed|reserved)\b/i);
});

test("funding_mode funded is refused on the live rail, with the reason, because no adapter is wired in", async () => {
  const { env } = makeEnv();
  await assert.rejects(
    createListing(env, AS(1, "funder"), {
      title: "Would be funded", condition: CONDITION, amount_atomic: DOLLAR, expiry: NOW + 86400,
      max_awards: 3, funding_mode: "funded", settlement_mode: "automatic",
      automatic_check: { kind: "comment_artifact_contains", expect: EXPECT },
    }),
    /no deployed contract|cannot be recorded yet/,
    "with no adapter injected, funded is refused rather than recorded as a promise wearing the word funded",
  );
});

test("the automatic check refuses to award for work that does not carry the declared string", async () => {
  const { env, db } = makeEnv();
  const adapter = new MockSettlementAdapter();
  const listing = await createListing(env, AS(1, "funder"), {
    title: "Independent reproduction test", condition: CONDITION, amount_atomic: DOLLAR, expiry: NOW + 86400,
    max_awards: 2, funding_mode: "funded", settlement_mode: "automatic",
    automatic_check: { kind: "comment_artifact_contains", expect: EXPECT },
  }, { settlementAdapter: adapter }) as Record<string, unknown>;
  const listingId = Number((listing.row as string).replace("listing-", ""));

  const wrong = reproduce(db, 2, "I ran it and it looked right to me");
  const s1 = await createSubmission(env, AS(2, "citizen-a"), listingId, { artifact: wrong }) as Record<string, unknown>;
  await assert.rejects(
    createAward(env, AS(2, "citizen-a"), listingId, { submission_id: s1.id }),
    /does not contain the string this listing declared/,
  );

  // Someone else's correct comment is not this submitter's work.
  const notMine = reproduce(db, 3, `Walked it. ${EXPECT}`);
  const s2 = await createSubmission(env, AS(4, "citizen-c"), listingId, { artifact: notMine }) as Record<string, unknown>;
  await assert.rejects(createAward(env, AS(4, "citizen-c"), listingId, { submission_id: s2.id }), /written by another citizen/);

  const served = await getListing(env, listingId) as Record<string, any>;
  assert.equal(served.economics.outstanding_awarded_atomic, "0", "two refused awards created no liability at all");
  assert.equal(served.economics.available_award_capacity, 2, "and consumed no capacity");
});

test("the rail census answers the research question in one call, and never serves bindings without outstanding", async () => {
  const { env, db } = makeEnv();
  const adapter = new MockSettlementAdapter();
  const listing = await createListing(env, AS(1, "funder"), {
    title: "Independent reproduction test", condition: CONDITION, amount_atomic: DOLLAR, expiry: NOW + 86400,
    max_awards: 3, funding_mode: "funded", settlement_mode: "automatic",
    automatic_check: { kind: "comment_artifact_contains", expect: EXPECT },
  }, { settlementAdapter: adapter }) as Record<string, unknown>;
  const listingId = Number((listing.row as string).replace("listing-", ""));

  // Two citizens bind a payout address and never get paid: the exact shape
  // that read as a debt on the live rail. One of them also submits and is
  // awarded; the other only bound.
  db.prepare("INSERT INTO payout_bindings (citizen_id, docket_id, amount_atomic, payout_address, expiry, created_at) VALUES (2, ?, ?, '0xa', ?, 0)").run(`listing-${listingId}`, DOLLAR, NOW + 86400);
  db.prepare("INSERT INTO payout_bindings (citizen_id, docket_id, amount_atomic, payout_address, expiry, created_at) VALUES (3, ?, ?, '0xb', ?, 0)").run(`listing-${listingId}`, DOLLAR, NOW - 10);
  const artifact = reproduce(db, 2, `walked it ${EXPECT}`);
  const submission = await createSubmission(env, AS(2, "citizen-a"), listingId, { artifact }) as Record<string, unknown>;
  await createAward(env, AS(2, "citizen-a"), listingId, { submission_id: submission.id });

  const census = await railCensus(env) as Record<string, any>;
  assert.equal(census.totals.listings, 1);
  assert.equal(census.totals.bindings, 2, "two routing records");
  assert.equal(census.totals.receipts, 0, "nobody has been paid");
  assert.equal(census.totals.lapsed_bindings, 1, "one binding's own expiry has passed");
  assert.equal(census.totals.awards, 1);
  // The number the two bindings do NOT produce. One award, so one dollar.
  assert.equal(census.totals.v2_outstanding_awarded_atomic, DOLLAR);
  assert.equal(census.totals.v2_paid_atomic, "0");
  assert.equal(census.totals.v2_maximum_remaining_liability_atomic, "3000000", "one dollar outstanding plus two uncommitted slots");
  assert.notEqual(census.totals.v2_outstanding_awarded_atomic, String(census.totals.bindings * 1000000), "outstanding is never bindings times the award amount");

  const row = census.listings[0];
  assert.equal(row.funding_mode, "funded");
  assert.equal(row.settlement_mode, "automatic");
  assert.equal(row.state, "open");
  assert.equal(row.worker_bindings, 2);
  assert.equal(row.economics.available_award_capacity, 2);
  // Every figure carries its derivation, and the reading note names the trap.
  for (const key of ["bindings", "receipts", "lapsed_bindings", "awards", "awarded_slots_used", "ever_payable", "v2_overdue_awards", "v2_outstanding_awarded_atomic", "v2_maximum_remaining_liability_atomic", "legacy_bindings_unclassified"]) {
    assert.ok(String(census.derivations[key]).length > 40, `${key} needs a published derivation`);
  }
  assert.match(census.reading_note, /ROUTING RECORD/);
  assert.match(census.reading_note, /not money owed by anyone|is not money owed/);
});

test("a legacy listing appears in the census with no invented cap and contributes no liability", async () => {
  const { env, db } = makeEnv();
  // A row as the pre-migration rail wrote it: settlement_version 1, and the
  // column defaults it never declared.
  db.prepare(
    `INSERT INTO listings (citizen_id, title, condition, amount_atomic, chain_id, token, expiry, payload_hash, commit_nonce, created_at, settlement_version)
     VALUES (1, 'Old bounty', ?, '5000000', 8453, '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', ?, 'h-old', 'n-old', 0, 1)`,
  ).run(CONDITION, NOW + 86400);
  db.prepare("INSERT INTO payout_bindings (citizen_id, docket_id, amount_atomic, payout_address, expiry, created_at) VALUES (2, 'listing-1', '5000000', '0xa', ?, 0)").run(NOW + 86400);

  const census = await railCensus(env) as Record<string, any>;
  const row = census.listings[0];
  assert.equal(row.economics.max_liability_atomic, null, "no cap is invented for a listing whose funder declared none");
  assert.equal(row.economics.maximum_remaining_liability_atomic, null);
  assert.equal(row.funding_mode, null);
  assert.equal(row.worker_bindings, 1);
  assert.equal(census.totals.legacy_listings_without_declared_cap, 1);
  assert.equal(census.totals.v2_outstanding_awarded_atomic, "0", "a historical binding is not a debt");
  assert.equal(census.totals.v2_maximum_remaining_liability_atomic, "0", "and contributes nothing to the rail total");
});

// The guard that the fixture above CANNOT reach, and the reason this test
// exists: citizen D is refused by the read-side check before the write is ever
// attempted, so deleting the guard inside the INSERT leaves the whole suite
// green. That guard is the race protection - two awards racing past a
// max_awards of 1 is exactly how a $5 listing comes to owe $10 - so it needs a
// test that defeats the read-side check and reaches the write.
//
// The stale reader below is the race, made deterministic: the pre-check sees a
// listing with no awards while the INSERT sees the real ones.
test("the exhaustion guard inside the award write refuses a race the read-side check let through", async () => {
  const { env, db } = makeEnv();
  const adapter = new MockSettlementAdapter();
  const listing = await createListing(env, AS(1, "funder"), {
    title: "Independent reproduction test", condition: CONDITION, amount_atomic: DOLLAR, expiry: NOW + 86400,
    max_awards: 1, funding_mode: "funded", settlement_mode: "automatic",
    automatic_check: { kind: "comment_artifact_contains", expect: EXPECT },
  }, { settlementAdapter: adapter }) as Record<string, unknown>;
  const listingId = Number((listing.row as string).replace("listing-", ""));

  const a1 = reproduce(db, 2, `first ${EXPECT}`);
  const s1 = await createSubmission(env, AS(2, "citizen-a"), listingId, { artifact: a1 }) as Record<string, unknown>;
  const a2 = reproduce(db, 3, `second ${EXPECT}`);
  const s2 = await createSubmission(env, AS(3, "citizen-b"), listingId, { artifact: a2 }) as Record<string, unknown>;

  await createAward(env, AS(2, "citizen-a"), listingId, { submission_id: s1.id });

  // A reader that answers the pre-check's award query with the state as it was
  // BEFORE the first award committed. Every other statement, including the
  // INSERT, runs against the real database.
  const real = env.DB as unknown as { prepare: (sql: string) => unknown };
  const stale = {
    prepare(sql: string) {
      const statement = real.prepare(sql) as Record<string, any>;
      if (!/FROM listing_awards WHERE listing_id = \? ORDER BY id ASC/.test(sql)) return statement;
      return { bind: () => ({ all: async () => ({ results: [] }), first: async () => null, run: async () => ({ meta: { changes: 0 } }) }) };
    },
    batch: (env.DB as unknown as { batch: unknown }).batch,
  };
  const racing = { ...env, DB: stale } as unknown as Env;

  // The pre-check now sees an empty award ledger and lets this through. Only
  // the guard inside the INSERT can stop it.
  await assert.rejects(
    createAward(racing, AS(3, "citizen-b"), listingId, { submission_id: s2.id }),
    /exhausted or closed|award slot/,
    "the write-side guard must refuse an award the stale read allowed",
  );

  const census = await railCensus(env) as Record<string, any>;
  assert.equal(census.totals.awards, 1, "the race created no second award");
  assert.equal(census.listings[0].economics.awarded_slots_used, 1);
  assert.equal(census.listings[0].economics.maximum_remaining_liability_atomic, DOLLAR, "and no second dollar of liability");
});

// THE VERIFIER PATH, exactly as asked: a verifier's pass makes the entitlement
// real by itself. The funder is never consulted, because a listing that
// declared a verifier and then required the funder to agree would have made
// the verifier advisory and handed the funder an undeclared veto.
test("verifier PASS makes the award payable with no funder action, and FAIL creates nothing", async () => {
  const { env, db } = makeEnv();
  const listing = await createListing(env, AS(1, "funder"), {
    title: "Independent reproduction test", condition: CONDITION, amount_atomic: "25000000", expiry: NOW + 86400,
    max_awards: 1, funding_mode: "promise", settlement_mode: "verifier",
    verifier_price_atomic: DOLLAR, max_verifiers: 1,
  }) as Record<string, unknown>;
  const listingId = Number((listing.row as string).replace("listing-", ""));

  const artifact = reproduce(db, 2, `walked it ${EXPECT}`);
  const submission = await createSubmission(env, AS(2, "citizen-a"), listingId, { artifact }) as Record<string, unknown>;

  // The verifier is a citizen holding a verifier binding filed BEFORE the
  // verdict: the existing verifier-binding infrastructure, reused as is.
  db.prepare("INSERT INTO payout_bindings (citizen_id, docket_id, amount_atomic, payout_address, expiry, created_at) VALUES (4, ?, ?, '0xv', ?, 0)").run(`listing-${listingId}-verifier`, DOLLAR, NOW + 86400);

  const key = bindSigningKey(db, 4);

  // Nobody else can decide, including the funder: the listing named a verifier.
  await assert.rejects(createAward(env, AS(1, "funder"), listingId, { submission_id: submission.id, verdict: "pass" }), /must hold a verifier binding/);
  await assert.rejects(createAward(env, AS(3, "citizen-b"), listingId, { submission_id: submission.id, verdict: "pass" }), /must hold a verifier binding/);

  // AN UNSIGNED VERDICT IS NOT A VERDICT. The verifier holds the authorization
  // and would otherwise be allowed to decide; the refusal is about evidence.
  await assert.rejects(
    createAward(env, AS(4, "citizen-c"), listingId, { submission_id: submission.id, verdict: "pass" }),
    /must carry a signature over its exact preimage/,
    "authentication of the caller is not a substitute for a portable signed verdict",
  );
  // And a signature over the WRONG bytes is refused rather than stored.
  await assert.rejects(
    createAward(env, AS(4, "citizen-c"), listingId, {
      submission_id: submission.id, verdict: "pass", issued_at: NOW * 1000,
      signature: signVerdict(key.privateKey, verdictBytes(db, listingId, submission.id, "citizen-c", "fail", NOW * 1000)),
    }),
    /does not verify against the verdict preimage/,
    "a PASS may not be waved through by a signature over a FAIL",
  );

  // A signed FAIL creates no award and no liability, and IS recorded.
  await assert.rejects(
    createAward(env, AS(4, "citizen-c"), listingId, { submission_id: submission.id, ...signedVerdict(db, key, listingId, Number(submission.id), "citizen-c", "fail") }),
    /signed FAIL on submission/,
  );
  const failRow = db.prepare("SELECT verdict, verifier_id, signature, payload_hash FROM listing_verdicts WHERE submission_id = ?").get(submission.id) as Record<string, unknown>;
  assert.equal(failRow.verdict, "fail", "the FAIL is durable, where it used to be a 409 that left nothing");
  assert.equal(failRow.verifier_id, 4);
  assert.ok(String(failRow.signature).length > 40, "and it carries the signature a stranger checks it with");
  const afterFail = await getListing(env, listingId) as Record<string, any>;
  assert.equal(afterFail.economics.outstanding_awarded_atomic, "0");
  assert.equal(afterFail.submissions[0].economic_state, "submitted", "a fail leaves the work submitted, not judged");

  // PASS. One call by the verifier, and the entitlement exists. A different
  // verifier signs it, because the first already spent their one verdict.
  db.prepare("INSERT INTO payout_bindings (citizen_id, docket_id, amount_atomic, payout_address, expiry, created_at) VALUES (5, ?, ?, '0xv2', ?, 0)").run(`listing-${listingId}-verifier`, DOLLAR, NOW + 86400);
  const key2 = bindSigningKey(db, 5);
  const issued2 = NOW * 1000;
  const binding2 = db.prepare("SELECT id FROM payout_bindings WHERE docket_id = ? AND citizen_id = 5").get(`listing-${listingId}-verifier`) as { id: number };
  const award = await createAward(env, AS(5, "citizen-d"), listingId, {
    submission_id: submission.id, verdict: "pass", issued_at: issued2,
    signature: signVerdict(key2.privateKey, verdictPreimage({ listingId, submissionId: Number(submission.id), verifier: "citizen-d", verdict: "pass", bindingId: binding2.id, issuedAt: issued2 })),
  }) as Record<string, unknown>;
  assert.equal(award.state, "payable", "VERIFIER PASS -> PAYABLE, in one act");
  assert.equal(award.awarded_by, "verifier");
  assert.ok(award.payable_at);

  const served = await getListing(env, listingId) as Record<string, any>;
  assert.equal(served.economics.outstanding_awarded_atomic, "25000000", "$25 is owed the moment the verifier passed it");
  assert.equal(served.submissions[0].economic_state, "payable");
});

// The lifecycle from the brief: $25, submit by a deadline, verifier decides,
// then a 30-day claim window. AWARDED is not even in this path; the shape is
// PAYABLE -> EXPIRED_UNCLAIMED, and the record keeps the earning forever.
test("a claim window that lapses records EXPIRED_UNCLAIMED, never not-selected, and keeps the earning", async () => {
  const { env, db } = makeEnv();
  const listing = await createListing(env, AS(1, "funder"), {
    title: "Independent reproduction test", condition: CONDITION, amount_atomic: "25000000", expiry: NOW + 86400,
    max_awards: 1, funding_mode: "promise", settlement_mode: "requester",
    submission_deadline: NOW + 3600,
    requester_timeout_seconds: 48 * 3600,
    payable_ttl_seconds: 60,
  }) as Record<string, unknown>;
  const listingId = Number((listing.row as string).replace("listing-", ""));
  const served0 = await getListing(env, listingId) as Record<string, any>;
  // All four clocks are published, distinct, and hashed into the listing.
  assert.equal(served0.submission_deadline, NOW + 3600);
  assert.equal(served0.requester_timeout_seconds, 48 * 3600);
  assert.equal(served0.payable_ttl_seconds, 60);
  assert.equal(served0.award_ttl_seconds, null, "no seat is being reserved on this listing");

  const artifact = reproduce(db, 2, `walked it ${EXPECT}`);
  const submission = await createSubmission(env, AS(2, "citizen-a"), listingId, { artifact }) as Record<string, unknown>;
  const award = await createAward(env, AS(1, "funder"), listingId, { submission_id: submission.id }) as Record<string, unknown>;
  assert.equal(award.state, "payable");
  const earnedAt = Number(award.payable_at);

  const owed = await getListing(env, listingId) as Record<string, any>;
  assert.equal(owed.economics.outstanding_awarded_atomic, "25000000");
  assert.equal(owed.economics.expired_unclaimed_atomic, "0");

  // The claim window passes with no receipt.
  db.prepare("UPDATE listing_awards SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, Number(award.award_id));

  const lapsed = await getListing(env, listingId) as Record<string, any>;
  const row = lapsed.awards[0];
  assert.equal(row.state, "expired_unclaimed", "not 'expired', and above all not not_selected");
  assert.equal(row.payable_at, earnedAt, "the moment it was earned is untouched by the expiry");
  assert.equal(lapsed.submissions[0].economic_state, "expired_unclaimed");
  assert.notEqual(lapsed.submissions[0].economic_state, "not_selected");

  // The economics say all three things at once: no longer owed, definitely
  // earned, and the seat is spent.
  assert.equal(lapsed.economics.outstanding_awarded_atomic, "0", "past the declared window it is not still owed");
  assert.equal(lapsed.economics.expired_unclaimed_atomic, "25000000", "and it is on its own line, never invisible");
  assert.equal(lapsed.economics.amount_paid_atomic, "0", "nobody was paid");
  assert.equal(lapsed.economics.available_award_capacity, 0, "the seat stays spent: the work was accepted");

  // And the census carries the same fact rail-wide.
  const census = await railCensus(env) as Record<string, any>;
  assert.equal(census.totals.v2_expired_unclaimed_atomic, "25000000", "earned and unclaimed, rail-wide, on its own line");
  assert.equal(census.totals.v2_outstanding_awarded_atomic, "0", "and not counted as still owed");
  assert.equal(census.listings[0].ever_payable, 1, "the census still says an entitlement existed here");
  assert.deepEqual(census.listings[0].award_states, { expired_unclaimed: 1 });
});

// The other clock, on the other kind of award: a seat reserved before the work.
test("a reserved seat that lapses is EXPIRED_UNMET, returns to the market, and never claims anyone earned anything", async () => {
  const { env, db } = makeEnv();
  const listing = await createListing(env, AS(1, "funder"), {
    title: "Independent reproduction test", condition: CONDITION, amount_atomic: DOLLAR, expiry: NOW + 86400,
    max_awards: 1, funding_mode: "promise", settlement_mode: "requester",
    award_ttl_seconds: 6 * 3600,
  }) as Record<string, unknown>;
  const listingId = Number((listing.row as string).replace("listing-", ""));
  const artifact = reproduce(db, 2, "starting on it now");
  const submission = await createSubmission(env, AS(2, "citizen-a"), listingId, { artifact }) as Record<string, unknown>;

  const seat = await createAward(env, AS(1, "funder"), listingId, { submission_id: submission.id, reserve: true }) as Record<string, unknown>;
  assert.equal(seat.state, "awarded", "a reserved seat is not an entitlement yet");
  assert.equal(seat.payable_at, null, "nothing has been earned");
  assert.match(String(seat.expires_meaning), /returns to the market/);

  const held = await getListing(env, listingId) as Record<string, any>;
  assert.equal(held.economics.available_award_capacity, 0, "the seat is held while its clock runs");
  assert.equal(held.economics.outstanding_awarded_atomic, DOLLAR, "and the funder is on the hook for it meanwhile");

  db.prepare("UPDATE listing_awards SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, Number(seat.award_id));

  const back = await getListing(env, listingId) as Record<string, any>;
  assert.equal(back.awards[0].state, "expired_unmet");
  assert.equal(back.submissions[0].economic_state, "expired_unmet");
  assert.equal(back.economics.available_award_capacity, 1, "the seat is back on the market");
  assert.equal(back.economics.outstanding_awarded_atomic, "0", "and nothing is owed, because nothing was earned");
  assert.equal(back.economics.expired_unclaimed_atomic, "0", "and nobody may read this as an unclaimed entitlement");
});

// THE ANTI-RETROACTIVITY INVARIANT, tested rather than asserted in prose.
// Every clock is a term of the listing, hashed into a payload the listing
// publishes and cannot edit. A funder who wants a shorter window after seeing
// the work would have to change a hash that is already chained.
test("no clock can be attached or shortened after the work: every one is inside the published listing hash", async () => {
  const { env, db } = makeEnv();
  const listing = await createListing(env, AS(1, "funder"), {
    title: "Independent reproduction test", condition: CONDITION, amount_atomic: "25000000", expiry: NOW + 86400,
    max_awards: 1, funding_mode: "promise", settlement_mode: "requester",
    submission_deadline: NOW + 3600, requester_timeout_seconds: 48 * 3600, payable_ttl_seconds: 30 * 24 * 3600,
  }) as Record<string, any>;
  const listingId = Number((listing.row as string).replace("listing-", ""));

  // The recipe this listing publishes names all four clocks.
  const fields: string[] = listing.payload_hash_recipe.fields;
  for (const term of ["max_awards", "funding_mode", "settlement_mode", "submission_deadline", "requester_timeout_seconds", "award_ttl_seconds", "payable_ttl_seconds"]) {
    assert.ok(fields.includes(term), `${term} must be inside the published listing hash, or it could be changed after the work`);
  }
  // And following that recipe against the served response reproduces the hash,
  // so a stranger can check that these exact terms are what was committed.
  const { createHash } = await import("node:crypto");
  const served = await getListing(env, listingId) as Record<string, any>;
  const recomputed = createHash("sha256").update(JSON.stringify(fields.map((f) => (f === "funder" ? served.funder : served[f]))), "utf8").digest("hex");
  assert.equal(recomputed, served.payload_hash, "the published recipe must reproduce the published hash over the served terms");

  // A funder editing the claim window in the database is immediately visible:
  // the listing no longer reproduces its own published hash.
  db.prepare("UPDATE listings SET payable_ttl_seconds = 60 WHERE id = ?").run(listingId);
  const tampered = await getListing(env, listingId) as Record<string, any>;
  const rehashed = createHash("sha256").update(JSON.stringify(fields.map((f) => (f === "funder" ? tampered.funder : tampered[f]))), "utf8").digest("hex");
  assert.notEqual(rehashed, tampered.payload_hash, "a shortened window must break the listing's own published hash");
});

// The DATABASE sweep, not the read model. The read path applies a lapse in
// memory; this is the write that persists it, and it is the one that could
// quietly drop the evidence. A guarantee that only holds in the read model is
// not a guarantee: the row is what survives.
test("the persisted sweep records the right terminal state and never erases payable_at", async () => {
  const { env, db } = makeEnv();
  const listing = await createListing(env, AS(1, "funder"), {
    title: "Independent reproduction test", condition: CONDITION, amount_atomic: "25000000", expiry: NOW + 86400,
    max_awards: 2, funding_mode: "promise", settlement_mode: "requester",
    award_ttl_seconds: 3600, payable_ttl_seconds: 3600,
  }) as Record<string, unknown>;
  const listingId = Number((listing.row as string).replace("listing-", ""));

  // One entitlement that was earned, and one seat that never was.
  const earned = await createSubmission(env, AS(2, "citizen-a"), listingId, { artifact: reproduce(db, 2, `done ${EXPECT}`) }) as Record<string, unknown>;
  const entitlement = await createAward(env, AS(1, "funder"), listingId, { submission_id: earned.id }) as Record<string, unknown>;
  const seatSub = await createSubmission(env, AS(3, "citizen-b"), listingId, { artifact: reproduce(db, 3, "starting") }) as Record<string, unknown>;
  const seat = await createAward(env, AS(1, "funder"), listingId, { submission_id: seatSub.id, reserve: true }) as Record<string, unknown>;

  const earnedAt = Number((db.prepare("SELECT payable_at AS p FROM listing_awards WHERE id = ?").get(Number(entitlement.award_id)) as { p: number }).p);
  assert.ok(earnedAt > 0, "the entitlement carries the moment it was earned");
  assert.equal((db.prepare("SELECT payable_at AS p FROM listing_awards WHERE id = ?").get(Number(seat.award_id)) as { p: number | null }).p, null);

  // Both clocks run out, and the sweep persists both lapses.
  db.prepare("UPDATE listing_awards SET expires_at = ?").run(Date.now() - 1000);
  const swept = await sweepExpiredAwards(env, listingId, Date.now());
  assert.equal(swept, 2, "both awards lapsed");

  const rows = db.prepare("SELECT id, state, payable_at, expired_at FROM listing_awards ORDER BY id").all() as Array<Record<string, unknown>>;
  const entitlementRow = rows.find((r) => r.id === Number(entitlement.award_id))!;
  const seatRow = rows.find((r) => r.id === Number(seat.award_id))!;

  assert.equal(entitlementRow.state, "expired_unclaimed", "an earned entitlement lapses unclaimed");
  assert.equal(entitlementRow.payable_at, earnedAt, "AND THE ROW STILL SAYS IT WAS EARNED, at the same instant it always said");
  assert.ok(entitlementRow.expired_at, "with the moment the declared window ran out");

  assert.equal(seatRow.state, "expired_unmet", "a seat nobody delivered on lapses unmet");
  assert.equal(seatRow.payable_at, null, "and it never claims anything was earned");

  // The served history says the same, permanently.
  const served = await getListing(env, listingId) as Record<string, any>;
  const servedEntitlement = served.awards.find((a: Record<string, unknown>) => a.award_id === Number(entitlement.award_id));
  assert.equal(servedEntitlement.state, "expired_unclaimed");
  assert.equal(servedEntitlement.payable_at, earnedAt, "the read model publishes the earning it can no longer pay");
  assert.equal(served.economics.expired_unclaimed_atomic, "25000000");
  assert.equal(served.economics.available_award_capacity, 1, "only the unmet seat came back");
});

// SURVIVOR 1 of the mutation sweep: deleting the submission_deadline check
// left the whole suite green, because nothing ever handed work in late. A
// declared clock that is never enforced is worse than an absent one.
test("work handed in after the declared submission_deadline is refused, and the listing still runs so decisions can be made", async () => {
  const { env, db } = makeEnv();
  const listing = await createListing(env, AS(1, "funder"), {
    title: "Independent reproduction test", condition: CONDITION, amount_atomic: "25000000", expiry: NOW + 86400,
    max_awards: 1, funding_mode: "promise", settlement_mode: "requester",
    submission_deadline: NOW + 3600, requester_timeout_seconds: 48 * 3600,
  }) as Record<string, unknown>;
  const listingId = Number((listing.row as string).replace("listing-", ""));

  // In time: accepted.
  const inTime = await createSubmission(env, AS(2, "citizen-a"), listingId, { artifact: reproduce(db, 2, `early ${EXPECT}`) }) as Record<string, unknown>;
  assert.ok(inTime.id);

  // The submission window closes. The LISTING does not: it runs another day so
  // the decision already owed on the work above can still be made, which is
  // exactly why these are two clocks and not one.
  db.prepare("UPDATE listings SET submission_deadline = ? WHERE id = ?").run(NOW - 10, listingId);
  await assert.rejects(
    createSubmission(env, AS(3, "citizen-b"), listingId, { artifact: reproduce(db, 3, `late ${EXPECT}`) }),
    /stopped taking work at its declared submission_deadline/,
  );

  // And the listing is still open for the decision on the work handed in on time.
  const award = await createAward(env, AS(1, "funder"), listingId, { submission_id: inTime.id }) as Record<string, unknown>;
  assert.equal(award.state, "payable", "the deadline closed submissions, not the listing");
  const served = await getListing(env, listingId) as Record<string, any>;
  assert.equal(served.state, "submitted");
  assert.equal(served.economics.outstanding_awarded_atomic, "25000000");
});

// SURVIVOR 2: nothing asserted that the CLAIM WINDOW IS ACTUALLY ATTACHED when
// an entitlement is born. The lapse tests all set expires_at by hand, so
// dropping payable_ttl at award time left them green and every real
// entitlement would have been immortal.
test("an entitlement is born carrying the listing's declared claim window, and a reserved seat carries the other clock", async () => {
  const { env, db } = makeEnv();
  const listing = await createListing(env, AS(1, "funder"), {
    title: "Independent reproduction test", condition: CONDITION, amount_atomic: "25000000", expiry: NOW + 90 * 86400,
    max_awards: 2, funding_mode: "promise", settlement_mode: "requester",
    award_ttl_seconds: 6 * 3600, payable_ttl_seconds: 30 * 24 * 3600,
  }) as Record<string, unknown>;
  const listingId = Number((listing.row as string).replace("listing-", ""));

  const earned = await createSubmission(env, AS(2, "citizen-a"), listingId, { artifact: reproduce(db, 2, `done ${EXPECT}`) }) as Record<string, unknown>;
  const before = Date.now();
  const entitlement = await createAward(env, AS(1, "funder"), listingId, { submission_id: earned.id }) as Record<string, unknown>;
  const after = Date.now();

  // The claim window is real, attached at the moment the entitlement was born,
  // and is the listing's declared 30 days rather than any other number.
  const expires = Number(entitlement.expires_at);
  assert.ok(expires >= before + 30 * 24 * 3600 * 1000 && expires <= after + 30 * 24 * 3600 * 1000,
    `an entitlement must carry the declared 30-day claim window; got expires_at ${expires}`);
  assert.match(String(entitlement.expires_meaning), /payable_ttl_seconds/);
  assert.match(String(entitlement.expires_meaning), /expired_unclaimed/);
  const stored = db.prepare("SELECT expires_at AS e FROM listing_awards WHERE id = ?").get(Number(entitlement.award_id)) as { e: number };
  assert.equal(stored.e, expires, "and it is persisted, not just reported");

  // A reserved seat carries the OTHER clock, from the same listing.
  const seatSub = await createSubmission(env, AS(3, "citizen-b"), listingId, { artifact: reproduce(db, 3, "starting") }) as Record<string, unknown>;
  const seat = await createAward(env, AS(1, "funder"), listingId, { submission_id: seatSub.id, reserve: true }) as Record<string, unknown>;
  const seatExpires = Number(seat.expires_at);
  assert.ok(seatExpires <= Date.now() + 6 * 3600 * 1000 + 1000 && seatExpires > Date.now(),
    "a reserved seat carries award_ttl_seconds, not the claim window");
  assert.ok(seatExpires < expires, "the two clocks are different terms and produce different deadlines");
  assert.match(String(seat.expires_meaning), /award_ttl_seconds/);

  // And the claim window on a seat starts when the seat becomes an
  // entitlement, not when the seat was reserved.
  const closed = await markAwardPayable(env, AS(1, "funder"), Number(seat.award_id)) as Record<string, unknown>;
  assert.equal(closed.state, "payable");
  assert.ok(Number(closed.expires_at) > seatExpires, "the claim window starts at the earning, not at the reservation");
});

// THE INVARIANT: a deadline may extinguish an entitlement only when the party
// losing it controls the action required to preserve it. The five scenarios
// below are the whole of it, and the first two are the same listing, the same
// clock and the same lapse, differing only in whether the worker did their
// part. They must not produce the same state.

function bindPayout(db: DatabaseSync, citizenId: number, listingId: number, expiry: number) {
  db.prepare("INSERT INTO payout_bindings (citizen_id, docket_id, amount_atomic, payout_address, expiry, created_at) VALUES (?, ?, '25000000', '0xw', ?, 0)")
    .run(citizenId, `listing-${listingId}`, expiry);
}

async function payableListing(env: Env, db: DatabaseSync, citizenId: number, handle: string) {
  const listing = await createListing(env, AS(1, "funder"), {
    title: "Independent reproduction test", condition: CONDITION, amount_atomic: "25000000", expiry: NOW + 90 * 86400,
    max_awards: 1, funding_mode: "promise", settlement_mode: "requester", payable_ttl_seconds: 30 * 24 * 3600,
  }) as Record<string, unknown>;
  const listingId = Number((listing.row as string).replace("listing-", ""));
  const submission = await createSubmission(env, AS(citizenId, handle), listingId, { artifact: reproduce(db, citizenId, `done ${EXPECT}`) }) as Record<string, unknown>;
  const award = await createAward(env, AS(1, "funder"), listingId, { submission_id: submission.id }) as Record<string, unknown>;
  return { listingId, awardId: Number(award.award_id), payableAt: Number(award.payable_at) };
}

test("1. worker never binds, claim deadline passes: EXPIRED_UNCLAIMED, and the lapse is the worker's", async () => {
  const { env, db } = makeEnv();
  const { listingId, awardId, payableAt } = await payableListing(env, db, 2, "citizen-a");
  // No payout binding is ever filed: the one act only the worker can take.
  db.prepare("UPDATE listing_awards SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, awardId);
  assert.equal(await sweepExpiredAwards(env, listingId, Date.now()), 1);

  const row = db.prepare("SELECT state, payable_at, expired_at, overdue_at FROM listing_awards WHERE id = ?").get(awardId) as Record<string, unknown>;
  assert.equal(row.state, "expired_unclaimed");
  assert.equal(row.payable_at, payableAt, "the earning is still on the record");
  assert.ok(row.expired_at);
  assert.equal(row.overdue_at, null, "nothing went overdue: there was nowhere to send it");

  const served = await getListing(env, listingId) as Record<string, any>;
  assert.equal(served.economics.outstanding_awarded_atomic, "0", "the entitlement lapsed on an action the worker controlled");
  assert.equal(served.economics.expired_unclaimed_atomic, "25000000");
  assert.equal(served.economics.overdue_unpaid_atomic, "0");
});

test("2. worker binds, funder waits past the deadline: OVERDUE_UNPAID, and the liability REMAINS", async () => {
  const { env, db } = makeEnv();
  const { listingId, awardId, payableAt } = await payableListing(env, db, 2, "citizen-a");
  // The worker does the one thing available to them.
  bindPayout(db, 2, listingId, NOW + 86400);
  db.prepare("UPDATE listing_awards SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, awardId);
  assert.equal(await sweepExpiredAwards(env, listingId, Date.now()), 1);

  const row = db.prepare("SELECT state, payable_at, expired_at, overdue_at FROM listing_awards WHERE id = ?").get(awardId) as Record<string, unknown>;
  assert.equal(row.state, "overdue_unpaid", "the funder's inaction cannot expire someone else's entitlement");
  assert.equal(row.payable_at, payableAt);
  assert.equal(row.expired_at, null, "nothing expired");
  assert.ok(row.overdue_at, "it went late, and when is recorded");

  const served = await getListing(env, listingId) as Record<string, any>;
  assert.equal(served.economics.outstanding_awarded_atomic, "25000000", "STILL OWED: a payer cannot reduce a debt by missing its deadline");
  assert.equal(served.economics.overdue_unpaid_atomic, "25000000");
  assert.equal(served.economics.currently_due_atomic, "0", "all of what is owed here is already late");
  assert.equal(served.economics.expired_unclaimed_atomic, "0", "and none of it is the worker's failure");
  assert.equal(served.submissions[0].economic_state, "overdue_unpaid");

  // The missed deadline lands on the FUNDER's settlement history, not the worker's.
  const census = await railCensus(env) as Record<string, any>;
  const funder = census.funders.find((f: Record<string, unknown>) => f.funder === "funder");
  assert.equal(funder.v2_overdue_unpaid_atomic, "25000000");
  assert.equal(funder.v2_overdue_awards, 1);
  assert.equal(funder.v2_expired_unclaimed_atomic, "0");
  assert.equal(census.totals.v2_outstanding_awarded_atomic, "25000000");
  assert.equal(census.totals.v2_overdue_unpaid_atomic, "25000000");
});

test("3. an overdue funder pays late: the debt settles to PAID and stops being outstanding", async () => {
  const { env, db } = makeEnv();
  const { listingId, awardId } = await payableListing(env, db, 2, "citizen-a");
  bindPayout(db, 2, listingId, NOW + 86400);
  db.prepare("UPDATE listing_awards SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, awardId);
  await sweepExpiredAwards(env, listingId, Date.now());
  assert.equal((db.prepare("SELECT state AS s FROM listing_awards WHERE id = ?").get(awardId) as { s: string }).s, "overdue_unpaid");

  // Paying late is still paying: the receipt closes the debt.
  db.prepare("INSERT INTO payout_receipts (funding_relationship, binding_id, submitter_id, tx_hash, source_address, created_at) VALUES ('independent', 1, 2, '0xlate', '0xfunder', 0)").run();
  const receiptId = Number((db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
  const closed = db.prepare("UPDATE listing_awards SET state = 'paid', receipt_id = ?, paid_at = ?, overdue_at = NULL WHERE id = ? AND state = 'overdue_unpaid'").run(receiptId, Date.now(), awardId);
  assert.equal(Number(closed.changes), 1, "overdue_unpaid -> paid is a reachable transition");

  const served = await getListing(env, listingId) as Record<string, any>;
  assert.equal(served.economics.amount_paid_atomic, "25000000");
  assert.equal(served.economics.outstanding_awarded_atomic, "0", "the debt is discharged by paying it");
  assert.equal(served.economics.overdue_unpaid_atomic, "0");
});

test("4. a funded listing with a worker-controlled claim: the worker lets it lapse, EXPIRED_UNCLAIMED and the funds follow the listing's refund rule", async () => {
  const { env, db } = makeEnv();
  const adapter = new MockSettlementAdapter();
  // Verifier settlement, so release is not automatic and there IS a genuine
  // claim step: the worker must supply a destination for the release to reach.
  const listing = await createListing(env, AS(1, "funder"), {
    title: "Independent reproduction test", condition: CONDITION, amount_atomic: "25000000", expiry: NOW + 90 * 86400,
    max_awards: 1, funding_mode: "funded", settlement_mode: "verifier",
    verifier_price_atomic: DOLLAR, max_verifiers: 1, payable_ttl_seconds: 30 * 24 * 3600,
  }, { settlementAdapter: adapter }) as Record<string, unknown>;
  const listingId = Number((listing.row as string).replace("listing-", ""));
  assert.equal(await adapter.fundedBalance(listingId), "25000000");

  const submission = await createSubmission(env, AS(2, "citizen-a"), listingId, { artifact: reproduce(db, 2, `done ${EXPECT}`) }) as Record<string, unknown>;
  db.prepare("INSERT INTO payout_bindings (citizen_id, docket_id, amount_atomic, payout_address, expiry, created_at) VALUES (4, ?, '1000000', '0xv', ?, 0)").run(`listing-${listingId}-verifier`, NOW + 86400);
  const vkey = bindSigningKey(db, 4);
  const award = await createAward(env, AS(4, "citizen-c"), listingId, { submission_id: submission.id, ...signedVerdict(db, vkey, listingId, Number(submission.id), "citizen-c", "pass") }) as Record<string, unknown>;
  assert.equal(award.state, "payable");

  // The worker never supplies a destination, so the release has nowhere to go.
  db.prepare("UPDATE listing_awards SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, Number(award.award_id));
  await sweepExpiredAwards(env, listingId, Date.now());
  assert.equal((db.prepare("SELECT state AS s FROM listing_awards WHERE id = ?").get(Number(award.award_id)) as { s: string }).s, "expired_unclaimed");

  // The committed funds follow the refund rule declared at creation.
  const refund = await adapter.refundUnused(listingId);
  assert.equal(refund.refundedAtomic, "25000000");
  assert.equal(await adapter.fundedBalance(listingId), "0");
  const served = await getListing(env, listingId) as Record<string, any>;
  assert.equal(served.economics.expired_unclaimed_atomic, "25000000");
  assert.equal(served.economics.outstanding_awarded_atomic, "0");
});

test("5. a funded automatic listing never sits in a claim window: PASS releases and the window is refused outright", async () => {
  const { env, db } = makeEnv();
  const adapter = new MockSettlementAdapter();
  // The claim window is refused at posting time rather than stored and ignored.
  await assert.rejects(
    createListing(env, AS(1, "funder"), {
      title: "Independent reproduction test", condition: CONDITION, amount_atomic: DOLLAR, expiry: NOW + 86400,
      max_awards: 1, funding_mode: "funded", settlement_mode: "automatic",
      automatic_check: { kind: "comment_artifact_contains", expect: EXPECT }, payable_ttl_seconds: 3600,
    }, { settlementAdapter: adapter }),
    /does not apply to a funded automatic listing/,
  );

  const listing = await createListing(env, AS(1, "funder"), {
    title: "Independent reproduction test", condition: CONDITION, amount_atomic: DOLLAR, expiry: NOW + 86400,
    max_awards: 1, funding_mode: "funded", settlement_mode: "automatic",
    automatic_check: { kind: "comment_artifact_contains", expect: EXPECT },
  }, { settlementAdapter: adapter }) as Record<string, unknown>;
  const listingId = Number((listing.row as string).replace("listing-", ""));
  bindPayout(db, 2, listingId, NOW + 86400);

  const submission = await createSubmission(env, AS(2, "citizen-a"), listingId, { artifact: reproduce(db, 2, `done ${EXPECT}`) }) as Record<string, unknown>;
  const award = await createAward(env, AS(2, "citizen-a"), listingId, { submission_id: submission.id }, { settlementAdapter: adapter }) as Record<string, any>;

  // FUND -> SUBMIT -> PAID. No window, nothing waiting on anyone.
  assert.equal(award.expires_at, null, "a listing that releases on pass has no interval to sit in");
  assert.ok(award.released, "the money was released in the same request the check passed");
  assert.equal(award.released.already_released, false);
  assert.equal(await adapter.fundedBalance(listingId), "0");
});

// SURVIVOR: every scenario above ran the persisted sweep before reading, so
// the READ MODEL's own copy of the lapse rule was never exercised and
// reverting the whole fix left the suite green. A GET that lands before any
// sweep must reach the same verdict, or a reader sees an earned debt reported
// as the worker's failure until some later write happens to correct it.
test("a read that arrives before any sweep reaches the same verdict, in both directions", async () => {
  const { env, db } = makeEnv();

  // Worker READY: the read model must say overdue, not expired. No sweep runs.
  const ready = await payableListing(env, db, 2, "citizen-a");
  bindPayout(db, 2, ready.listingId, NOW + 86400);
  db.prepare("UPDATE listing_awards SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, ready.awardId);
  assert.equal((db.prepare("SELECT state AS s FROM listing_awards WHERE id = ?").get(ready.awardId) as { s: string }).s, "payable",
    "nothing has swept this row: the read model is on its own");
  const readyServed = await getListing(env, ready.listingId) as Record<string, any>;
  assert.equal(readyServed.awards[0].state, "overdue_unpaid");
  assert.equal(readyServed.economics.outstanding_awarded_atomic, "25000000", "still owed on a read that never swept");
  assert.equal(readyServed.economics.expired_unclaimed_atomic, "0");

  // Worker NOT ready, same clock, same read path: the entitlement expires.
  const unready = await payableListing(env, db, 3, "citizen-b");
  db.prepare("UPDATE listing_awards SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, unready.awardId);
  const unreadyServed = await getListing(env, unready.listingId) as Record<string, any>;
  assert.equal(unreadyServed.awards[0].state, "expired_unclaimed");
  assert.equal(unreadyServed.economics.outstanding_awarded_atomic, "0");

  // And the census, which resolves readiness rail-wide in one query rather
  // than per listing, must agree with both.
  const census = await railCensus(env) as Record<string, any>;
  assert.equal(census.totals.v2_overdue_unpaid_atomic, "25000000");
  assert.equal(census.totals.v2_expired_unclaimed_atomic, "25000000");
  assert.equal(census.totals.v2_outstanding_awarded_atomic, "25000000", "exactly one of the two is still a debt");
});

// SURVIVOR: nothing distinguished a live payout destination from a lapsed one,
// so treating any binding as readiness passed. Keeping a current destination is
// also an act only the worker can take.
test("a payout binding that has itself expired is not a live destination", async () => {
  const { env, db } = makeEnv();
  const { listingId, awardId } = await payableListing(env, db, 2, "citizen-a");
  // The worker bound once, and let that binding lapse.
  bindPayout(db, 2, listingId, NOW - 10);
  db.prepare("UPDATE listing_awards SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, awardId);

  const served = await getListing(env, listingId) as Record<string, any>;
  assert.equal(served.awards[0].state, "expired_unclaimed",
    "a funder cannot pay to a lapsed binding, and renewing it is the worker's own act");
  assert.equal(await sweepExpiredAwards(env, listingId, Date.now()), 1);
  assert.equal((db.prepare("SELECT state AS s FROM listing_awards WHERE id = ?").get(awardId) as { s: string }).s, "expired_unclaimed",
    "and the persisted sweep agrees with the read model");

  // A live binding on the same listing flips it, which is the control.
  const live = await payableListing(env, db, 3, "citizen-b");
  bindPayout(db, 3, live.listingId, NOW + 86400);
  db.prepare("UPDATE listing_awards SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, live.awardId);
  const control = await getListing(env, live.listingId) as Record<string, any>;
  assert.equal(control.awards[0].state, "overdue_unpaid");
});

// SURVIVOR: scenario 3 closed the debt with a hand-written UPDATE, so the
// actual settlement path never saw an overdue row. Paying late has to work
// through the code that runs when a receipt lands.
test("the receipt path settles an overdue debt, and settles each award at most once", async () => {
  const { env, db } = makeEnv();
  const { listingId, awardId } = await payableListing(env, db, 2, "citizen-a");
  bindPayout(db, 2, listingId, NOW + 86400);
  db.prepare("UPDATE listing_awards SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, awardId);
  await sweepExpiredAwards(env, listingId, Date.now());
  assert.equal((db.prepare("SELECT state AS s FROM listing_awards WHERE id = ?").get(awardId) as { s: string }).s, "overdue_unpaid");

  db.prepare("INSERT INTO payout_receipts (funding_relationship, binding_id, submitter_id, tx_hash, source_address, created_at) VALUES ('independent', 1, 2, '0xlate', '0xfunder', 0)").run();
  const receiptId = Number((db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);

  // The real path: a receipt on this listing's worker row, for this payee.
  const closed = await settleAwardFromReceipt(env, { docket_id: `listing-${listingId}`, citizen_id: 2 }, receiptId, Date.now());
  assert.equal(closed, awardId, "paying late settles the overdue debt through the ordinary receipt path");
  const row = db.prepare("SELECT state, receipt_id FROM listing_awards WHERE id = ?").get(awardId) as Record<string, unknown>;
  assert.equal(row.state, "paid");
  assert.equal(row.receipt_id, receiptId);

  const served = await getListing(env, listingId) as Record<string, any>;
  assert.equal(served.economics.outstanding_awarded_atomic, "0", "a paid debt is no longer owed");
  assert.equal(served.economics.overdue_unpaid_atomic, "0");
  assert.equal(served.economics.amount_paid_atomic, "25000000");

  // A second receipt cannot settle the same award again.
  db.prepare("INSERT INTO payout_receipts (funding_relationship, binding_id, submitter_id, tx_hash, source_address, created_at) VALUES ('independent', 2, 2, '0xagain', '0xfunder', 0)").run();
  const second = Number((db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
  assert.equal(await settleAwardFromReceipt(env, { docket_id: `listing-${listingId}`, citizen_id: 2 }, second, Date.now()), null,
    "there is no open award left to close, and the paid one cannot be paid twice");
  // A verifier fee is not an award and must never consume one.
  assert.equal(await settleAwardFromReceipt(env, { docket_id: `listing-${listingId}-verifier`, citizen_id: 2 }, second, Date.now()), null);
});

// LATCHED READINESS: live-once, then permanent for that award.
//
// Neither "ever bound" nor "must stay live forever". Ever-bound would
// authorize payment to a wallet the payee abandoned. Stay-live-forever makes
// the payee babysit administrative state and hands the payer an escape: let
// the payee's binding lapse and the payer stops being late for a debt they
// already owed.

test("latch 1: an old expired binding alone does not establish current readiness", async () => {
  const { env, db } = makeEnv();
  const { listingId, awardId } = await payableListing(env, db, 2, "citizen-a");
  // A binding that has already lapsed: a destination nobody can pay to.
  bindPayout(db, 2, listingId, NOW - 10);
  assert.equal(await latchReadiness(env, listingId, Date.now()), 0, "a lapsed route latches nothing");
  const row = db.prepare("SELECT ready_at AS r FROM listing_awards WHERE id = ?").get(awardId) as { r: number | null };
  assert.equal(row.r, null);

  const served = await getListing(env, listingId) as Record<string, any>;
  assert.equal(served.awards[0].settlement_block, "waiting_for_payee", "settlement is waiting on the payee, and the payer's clock has not started");
  assert.equal(served.awards[0].ready_at, null);
});

test("latch 2: a valid live binding establishes ready_at and snapshots the route it authorized", async () => {
  const { env, db } = makeEnv();
  const { listingId, awardId } = await payableListing(env, db, 2, "citizen-a");
  bindPayout(db, 2, listingId, NOW + 86400);
  assert.equal(await latchReadiness(env, listingId, Date.now()), 1);

  const row = db.prepare("SELECT ready_at, ready_binding_id, ready_payout_address FROM listing_awards WHERE id = ?").get(awardId) as Record<string, unknown>;
  assert.ok(row.ready_at, "readiness is latched");
  assert.ok(row.ready_binding_id, "against the binding that established it");
  assert.equal(row.ready_payout_address, "0xw", "and the route it named is snapshotted for this award");

  const served = await getListing(env, listingId) as Record<string, any>;
  assert.equal(served.awards[0].settlement_block, "ready_to_pay", "the payer's deadline is now running");
  assert.equal(served.awards[0].ready_payout_address, "0xw");

  // Latching twice changes nothing.
  const firstReadyAt = row.ready_at;
  assert.equal(await latchReadiness(env, listingId, Date.now() + 5000), 0);
  assert.equal((db.prepare("SELECT ready_at AS r FROM listing_awards WHERE id = ?").get(awardId) as { r: number }).r, firstReadyAt);
});

test("latch 3: a later binding expiry does not erase readiness, remove the liability, or save the payer", async () => {
  const { env, db } = makeEnv();
  const { listingId, awardId } = await payableListing(env, db, 2, "citizen-a");
  bindPayout(db, 2, listingId, NOW + 86400);
  await latchReadiness(env, listingId, Date.now());
  const latchedAt = (db.prepare("SELECT ready_at AS r FROM listing_awards WHERE id = ?").get(awardId) as { r: number }).r;

  // Their global binding later lapses. This is the funder's escape hatch under
  // a stay-live-forever rule, and it must not work.
  db.prepare("UPDATE payout_bindings SET expiry = ? WHERE citizen_id = 2").run(NOW - 10);
  db.prepare("UPDATE listing_awards SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, awardId);

  const served = await getListing(env, listingId) as Record<string, any>;
  assert.equal(served.awards[0].ready_at, latchedAt, "readiness is not erased by a later expiry");
  assert.equal(served.awards[0].state, "overdue_unpaid", "the payer is late, not the payee");
  assert.equal(served.economics.outstanding_awarded_atomic, "25000000", "the liability remains");
  assert.equal(served.economics.expired_unclaimed_atomic, "0");
  // The route is stale, which is reported and changes nothing else.
  assert.equal(served.awards[0].settlement_block, "payer_late");

  await sweepExpiredAwards(env, listingId, Date.now());
  const row = db.prepare("SELECT state, ready_at FROM listing_awards WHERE id = ?").get(awardId) as Record<string, unknown>;
  assert.equal(row.state, "overdue_unpaid", "and the persisted sweep agrees");
  assert.equal(row.ready_at, latchedAt);
});

test("latch 4: replacing the payout route does not restart the payer's deadline", async () => {
  const { env, db } = makeEnv();
  const { listingId, awardId } = await payableListing(env, db, 2, "citizen-a");
  bindPayout(db, 2, listingId, NOW + 86400);
  await latchReadiness(env, listingId, Date.now());
  const before = db.prepare("SELECT ready_at, expires_at, ready_payout_address FROM listing_awards WHERE id = ?").get(awardId) as Record<string, unknown>;

  // The payee signs a replacement destination before payment.
  db.prepare("INSERT INTO payout_bindings (citizen_id, docket_id, amount_atomic, payout_address, expiry, created_at) VALUES (2, ?, '25000000', '0xnew', ?, 0)")
    .run(`listing-${listingId}`, NOW + 172800);
  assert.equal(await latchReadiness(env, listingId, Date.now() + 60000), 0, "a replacement finds readiness already latched");

  const after = db.prepare("SELECT ready_at, expires_at, ready_payout_address FROM listing_awards WHERE id = ?").get(awardId) as Record<string, unknown>;
  assert.equal(after.ready_at, before.ready_at, "readiness is not re-latched");
  assert.equal(after.expires_at, before.expires_at, "AND THE PAYER'S DEADLINE DOES NOT MOVE: replacing a route is not a new start");
  assert.equal(after.ready_payout_address, before.ready_payout_address, "the award keeps the route authorized when readiness latched");
});

test("latch 5: funder silence after ready_at becomes overdue, and the liability stays with them", async () => {
  const { env, db } = makeEnv();
  const { listingId, awardId } = await payableListing(env, db, 2, "citizen-a");
  bindPayout(db, 2, listingId, NOW + 86400);
  await latchReadiness(env, listingId, Date.now());
  db.prepare("UPDATE listing_awards SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, awardId);
  assert.equal(await sweepExpiredAwards(env, listingId, Date.now()), 1);

  const served = await getListing(env, listingId) as Record<string, any>;
  assert.equal(served.awards[0].state, "overdue_unpaid");
  assert.equal(served.economics.outstanding_awarded_atomic, "25000000");
  assert.equal(served.economics.currently_due_atomic, "0");
  assert.equal(served.economics.overdue_unpaid_atomic, "25000000");

  const census = await railCensus(env) as Record<string, any>;
  const funder = census.funders.find((f: Record<string, unknown>) => f.funder === "funder");
  assert.equal(funder.v2_overdue_unpaid_atomic, "25000000", "the debt is on the funder's settlement history");
  assert.equal(funder.v2_expired_unclaimed_atomic, "0", "and none of it is charged to the worker");
  assert.equal(census.listings[0].accountability.v2_overdue_unpaid_atomic, "25000000");
});

test("latch 6: filing a payout binding latches readiness through the ordinary rail path", async () => {
  const { env, db } = makeEnv();
  const { listingId, awardId } = await payableListing(env, db, 2, "citizen-a");
  assert.equal((db.prepare("SELECT ready_at AS r FROM listing_awards WHERE id = ?").get(awardId) as { r: number | null }).r, null);
  // The write path a payee actually uses ends in latchReadiness for the
  // listing they bound against.
  bindPayout(db, 2, listingId, NOW + 86400);
  assert.equal(await latchReadiness(env, listingId, Date.now()), 1);
  // And an award created AFTER a route already exists latches at award time.
  const second = await payableListing(env, db, 3, "citizen-b");
  bindPayout(db, 3, second.listingId, NOW + 86400);
  const third = await createSubmission(env, AS(4, "citizen-c"), second.listingId, { artifact: reproduce(db, 4, `late entry ${EXPECT}`) }) as Record<string, unknown>;
  bindPayout(db, 4, second.listingId, NOW + 86400);
  // A read arriving before the latching write reports the same thing a write
  // would, and the latch then persists it.
  const beforeLatch = await getListing(env, second.listingId) as Record<string, any>;
  assert.equal(beforeLatch.awards[0].settlement_block, "ready_to_pay", "a live route is readiness whether or not it is written down yet");
  assert.equal(beforeLatch.awards[0].ready_at, null, "and it is not yet latched");
  assert.equal(await latchReadiness(env, second.listingId, Date.now()), 1);
  const afterLatch = await getListing(env, second.listingId) as Record<string, any>;
  assert.ok(afterLatch.awards[0].ready_at, "the latch makes it permanent");
  assert.equal(afterLatch.awards[0].settlement_block, "ready_to_pay");
  assert.ok(third.id);
});

// ---------- WHAT THE CENSUS MAY NOT CLAIM ----------
//
// Settlement v2 deliberately backfills no award rows for pre-v2 listings,
// because a payout binding never recorded whether an award was made. That is
// the right call, and it has a consequence that must be served just as loudly:
// "we cannot derive a liability from these records" is NOT "we have proved
// there was none". A rail that fixed the 147-bindings-are-147-debts misreading
// by publishing an unscoped zero would have swapped one false certainty for
// its mirror image, and the second one is worse, because it reads as this
// registry officially clearing every historical obligation.
//
// The four tests below pin both halves: no liability is manufactured from
// legacy bindings, AND no legacy listing is reported as affirmatively settled.

function legacyListing(db: DatabaseSync, bindings: number) {
  db.prepare(
    `INSERT INTO listings (citizen_id, title, condition, amount_atomic, chain_id, token, expiry, payload_hash, commit_nonce, created_at, settlement_version)
     VALUES (1, 'Old bounty', ?, '5000000', 8453, '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', ?, 'h-legacy', 'n-legacy', 0, 1)`,
  ).run(CONDITION, NOW + 86400);
  const id = Number((db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
  for (let i = 0; i < bindings; i++)
    db.prepare("INSERT INTO payout_bindings (citizen_id, docket_id, amount_atomic, payout_address, expiry, created_at) VALUES (?, ?, '5000000', '0xa', ?, 0)")
      .run(2 + (i % 4), `listing-${id}`, NOW + 86400);
  return id;
}

test("legacy A: a pre-v2 listing with forty payout bindings manufactures no liability whatsoever", async () => {
  const { env, db } = makeEnv();
  legacyListing(db, 40);

  const census = await railCensus(env) as Record<string, any>;
  assert.equal(census.totals.bindings, 40, "the routing records are all counted");
  assert.equal(census.totals.awards, 0, "and not one of them became an award row");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM listing_awards").get<{ n: number }>()!.n, 0, "the ledger stays empty: no backfill, ever");
  assert.equal(census.totals.v2_outstanding_awarded_atomic, "0", "forty bindings are not forty debts");
  assert.equal(census.totals.v2_maximum_remaining_liability_atomic, "0");
  assert.equal(census.listings[0].economics.max_liability_atomic, null, "and no cap is invented for a funder who declared none");
});

test("legacy B: that same listing is never reported as affirmatively owing nothing historically", async () => {
  const { env, db } = makeEnv();
  legacyListing(db, 40);

  const census = await railCensus(env) as Record<string, any>;
  const row = census.listings[0];
  // The scope is on the row itself, not buried in a footnote.
  assert.equal(row.liability_scope, "legacy_unclassified");
  assert.equal(row.legacy_bindings_unclassified, 40, "the unknown has a published size");
  assert.equal(census.totals.legacy_listings, 1);
  assert.equal(census.totals.legacy_bindings_unclassified, 40);
  assert.equal(census.totals.legacy_listings_without_declared_cap, 1);

  // NO UNSCOPED LIABILITY FIGURE MAY EXIST. A client that reads a key called
  // `outstanding_awarded_atomic` off totals is reading a number whose scope it
  // was never told, which is exactly how a v2-only zero becomes a claim about
  // history. Every such key carries v2_ or it is not served at all.
  const unscoped = Object.keys(census.totals).filter((k) => /(outstanding|overdue|expired_unclaimed|currently_due|maximum_remaining|paid)/.test(k) && !k.startsWith("v2_"));
  assert.deepEqual(unscoped, [], "every liability total on this page declares its scope in its own name");

  // And the prose says the thing outright, where a quoting reader will hit it.
  assert.match(census.liability_scope_note, /not (be )?derivable|NOT DERIVABLE/i);
  assert.match(census.liability_scope_note, /UNKNOWN/);
  assert.match(census.liability_scope_note, /does not mean|must never be quoted/i);
  assert.match(row.accountability.note, /not derivable|history unknown/i);
  assert.match(row.economics.note, /NOT DERIVABLE|UNKNOWN TO THIS REGISTRY/);
  // A funder holding only legacy listings must not read as settled up.
  const funder = census.funders.find((f: Record<string, unknown>) => f.funder === "funder");
  assert.equal(funder.liability_scope, "legacy_unclassified", "their zeros are an empty ledger, and the row says so");
  assert.equal(funder.legacy_bindings_unclassified, 40);
  assert.equal(funder.v2_overdue_unpaid_atomic, "0");
  assert.match(census.funders_note, /NO V2-RECORDED OUTSTANDING LIABILITY|not a finding/i);
});

test("legacy C: a v2 listing with no awards reports a derived zero, and says it is derived", async () => {
  const { env } = makeEnv();
  await createListing(env, AS(1, "funder"), {
    title: "Independent reproduction test", condition: CONDITION, amount_atomic: DOLLAR, expiry: NOW + 86400,
    max_awards: 3, funding_mode: "promise", settlement_mode: "requester",
  });

  const census = await railCensus(env) as Record<string, any>;
  const row = census.listings[0];
  assert.equal(row.liability_scope, "v2_ledger", "this one CAN be audited, and the zero below is a finding");
  assert.equal(row.legacy_bindings_unclassified, 0);
  assert.equal(census.totals.legacy_listings, 0, "nothing here is unclassified");
  assert.equal(census.totals.legacy_bindings_unclassified, 0);
  assert.equal(census.totals.v2_outstanding_awarded_atomic, "0", "no award has been made, so nothing is owed");
  assert.equal(row.economics.max_liability_atomic, "3000000", "and unlike a legacy row, the ceiling is declared");
  assert.equal(census.totals.v2_maximum_remaining_liability_atomic, "3000000");
});

test("legacy D: a v2 listing with a payable award and an overdue one reports the exact liability", async () => {
  const { env, db } = makeEnv();
  // One entitlement still inside its window, one whose payer ran past it.
  await payableListing(env, db, 2, "citizen-a");
  const late = await payableListing(env, db, 3, "citizen-b");
  bindPayout(db, 3, late.listingId, NOW + 86400);
  db.prepare("UPDATE listing_awards SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, late.awardId);
  assert.equal(await sweepExpiredAwards(env, late.listingId, Date.now()), 1);

  const census = await railCensus(env) as Record<string, any>;
  assert.equal(census.totals.awards, 2);
  assert.equal(census.totals.v2_outstanding_awarded_atomic, "50000000", "both are owed, to the atom");
  assert.equal(census.totals.v2_currently_due_atomic, "25000000", "one is owed and not yet late");
  assert.equal(census.totals.v2_overdue_unpaid_atomic, "25000000", "the other is owed AND late, and late does not shrink it");
  assert.equal(census.totals.v2_expired_unclaimed_atomic, "0");
  assert.equal(census.totals.legacy_bindings_unclassified, 0, "nothing on this rail is unclassified");
  const funder = census.funders.find((f: Record<string, unknown>) => f.funder === "funder");
  assert.equal(funder.liability_scope, "v2_ledger");
  assert.equal(funder.v2_outstanding_awarded_atomic ?? funder.v2_currently_due_atomic, "25000000");
  assert.equal(funder.v2_overdue_unpaid_atomic, "25000000", "and the lateness is on the payer's record");
});

// GET /api/rail's own summary in /api/surface promises "every figure carries
// the derivation that produced it". That is a served claim about this
// endpoint, so it is checked mechanically rather than believed: a figure added
// to totals without a derivation makes the promise false the moment it ships,
// and no test that asserts particular keys would notice a NEW one.
test("every figure served in the census totals carries a published derivation", async () => {
  const { env, db } = makeEnv();
  legacyListing(db, 3);
  await createListing(env, AS(1, "funder"), {
    title: "Independent reproduction test", condition: CONDITION, amount_atomic: DOLLAR, expiry: NOW + 86400,
    max_awards: 2, funding_mode: "promise", settlement_mode: "requester",
  });

  const census = await railCensus(env) as Record<string, any>;
  const undocumented = Object.keys(census.totals).filter((k) => !(k in census.derivations));
  assert.deepEqual(undocumented, [], "a figure with no derivation is a number a stranger cannot check");
  for (const [key, text] of Object.entries(census.derivations))
    assert.ok(String(text).length > 40, `${key}'s derivation is too short to be one`);
});

// /api/surface and the MCP tool both tell citizens that marking an award
// payable is "funder only, and requester-settled listings only". That is a
// served claim about who holds a power on this rail, so it is pinned here.
// The reachability half matters as much as the permission half: if a verifier
// listing could hold an `awarded` row, the claim would be false no matter what
// the permission check said.
test("only a requester-settled listing can reserve a seat, which is what makes marking payable funder-only", async () => {
  const { env, db } = makeEnv();
  const listing = await createListing(env, AS(1, "funder"), {
    title: "Independent reproduction test", condition: CONDITION, amount_atomic: DOLLAR, expiry: NOW + 86400,
    max_awards: 1, funding_mode: "promise", settlement_mode: "verifier", award_ttl_seconds: 6 * 3600,
  }) as Record<string, unknown>;
  const listingId = Number((listing.row as string).replace("listing-", ""));
  db.prepare("INSERT INTO payout_bindings (citizen_id, docket_id, amount_atomic, payout_address, expiry, created_at) VALUES (3, ?, ?, '0xv', ?, 0)")
    .run(`listing-${listingId}-verifier`, DOLLAR, NOW + 86400);
  const submission = await createSubmission(env, AS(2, "citizen-a"), listingId, { artifact: reproduce(db, 2, `done ${EXPECT}`) }) as Record<string, unknown>;

  await assert.rejects(
    () => createAward(env, AS(3, "citizen-b"), listingId, { submission_id: submission.id, verdict: "pass", reserve: true }),
    /only a requester-settled listing can reserve a seat/,
    "a verifier listing cannot park an award in `awarded`, so nothing here is ever left to mark payable",
  );

  // And the ordinary verifier path lands PAYABLE directly, with no second act
  // by the funder: the pass IS the decision, not a recommendation.
  const vkey = bindSigningKey(db, 3);
  const award = await createAward(env, AS(3, "citizen-b"), listingId, { submission_id: submission.id, ...signedVerdict(db, vkey, listingId, Number(submission.id), "citizen-b", "pass") }) as Record<string, unknown>;
  assert.equal(String(award.state), "payable");
  await assert.rejects(
    () => markAwardPayable(env, AS(1, "funder"), Number(award.award_id)),
    /settles by verifier/,
    "and the funder has no confirm step to withhold: the door refuses a verifier-settled listing outright",
  );
});

// ---------- one asset today, two by design ----------
//
// USDC is the default and 1F916 is meant to sit beside it, never to replace
// it. The arithmetic is already denominated per asset, because atomic units
// are not comparable across assets: USDC carries six decimals and 1F916
// eighteen, so one scalar summing both is two different units added together
// and printed as money.
//
// PRICING a listing in 1F916 is one line in the validator. PAYING one is not:
// payout bindings pin their token by CHECK constraint and the receipt path
// verifies a USDC Transfer specifically. So the listing side stays closed
// until the money path opens, and these tests pin the shape rather than a
// capability that does not exist yet.

test("every listing names the asset it is priced in, and liability is grouped by it", async () => {
  const { env, db } = makeEnv();
  const listing = await createListing(env, AS(1, "funder"), {
    title: "Independent reproduction test", condition: CONDITION, amount_atomic: "5000000", expiry: NOW + 86400,
    max_awards: 1, funding_mode: "promise", settlement_mode: "requester",
  }) as Record<string, unknown>;
  const id = Number((listing.row as string).replace("listing-", ""));
  const sub = await createSubmission(env, AS(2, "citizen-a"), id, { artifact: reproduce(db, 2, "a") }) as Record<string, unknown>;
  await createAward(env, AS(1, "funder"), id, { submission_id: sub.id });

  const census = await railCensus(env) as Record<string, any>;
  for (const row of census.listings)
    assert.ok(row.asset.token && row.asset.chain_id, "an atomic figure without its asset is not a quantity");
  assert.equal(census.liability_by_asset.length, 1, "one asset in use today");
  assert.equal(census.liability_by_asset[0].v2_outstanding_awarded_atomic, "5000000");
  // With one asset the scalars still answer, so nothing reading them breaks.
  assert.equal(census.totals.v2_outstanding_awarded_atomic, "5000000");
  assert.match(census.assets_note, /owes TOKENS/);
  assert.match(census.assets_note, /never the obligation/);
  assert.match(census.assets_note, /null unless exactly one asset is in use/);
});

// The token is open now (migration 0045), and this test keeps the original
// guarantee rather than dropping it: the danger was never the token, it was
// HALF opening it. A listing that can be posted and awarded but never paid is
// worse than one that cannot be posted at all.
//
// KILLING MUTATION: revert any ONE of the three gates to `token !== BASE_USDC`
// — the listing gate in listings.ts, the binding gate or the receipt gate in
// payouts.ts. Each leaves the other two open and this test goes red on the
// mismatched one, which is exactly the half-open state the original refusal
// existed to prevent.
test("the token is open at every gate or at none: posting, binding and receipts agree on one closed list", async () => {
  const { env } = makeEnv();
  const TOKEN = "0x9e00fc92493451eba1c63dd3880d68b622037ba3";

  const listing = await createListing(env, AS(1, "funder"), {
    title: "Independent reproduction test", condition: CONDITION,
    amount_atomic: "2000000000000000000000000",
    expiry: NOW + 86400, max_awards: 1, funding_mode: "promise", settlement_mode: "requester",
    token: TOKEN,
  }) as Record<string, unknown>;
  assert.equal(listing.token, TOKEN, "the listing records the asset it was priced in");

  // The other two gates read the SAME closed list, so a token that can be
  // listed can also be bound and receipted. Anything else is the half-open
  // state.
  assert.equal(assetRefusal(TOKEN, 8453), null, "binding and receipt gates must accept what the listing gate accepted");
  assert.equal(assetRefusal(BASE_USDC, 8453), null, "USDC is unchanged and still the default");

  // And the list stays closed: an arbitrary contract does not become a
  // registry-looking asset by being named in a request.
  assert.ok(assetRefusal("0xdead" + "0".repeat(36), 8453), "an unlisted token is refused");
  assert.ok(assetRefusal(TOKEN, 1), "another chain is refused even for a known asset");

  // The decimals differ (6 vs 18), so the two are not comparable as integers.
  // soleAsset is what forces a caller to notice instead of summing them.
  assert.equal(soleAsset([TOKEN, BASE_USDC]), null, "a scalar spanning two assets is not a quantity");
  assert.equal(soleAsset([TOKEN, TOKEN])?.decimals, 18);
  assert.equal(soleAsset([BASE_USDC])?.decimals, 6);
});

// DECIMALS ARE PINNED, because the comment on SETTLEMENT_ASSETS promises they
// were read from chain rather than assumed, and an unchecked promise in a
// comment is just a sentence.
//
// Both were read from Base mainnet on 2026-09-01 by eth_call to decimals()
// (selector 0x313ce567): USDC returned 6, 1F916 returned 18, and 1F916's
// totalSupply returned 100,000,000,000 whole tokens, matching the verified
// contract source. If a future asset is added with a guessed decimals field,
// this test is the only thing standing between that guess and an amount
// displayed a million times wrong.
//
// KILLING MUTATION: change 1F916's decimals to 6 in SETTLEMENT_ASSETS. This
// goes red. Nothing else in the suite notices, because every atomic amount is
// stored as an opaque string and the error surfaces only where a human reads a
// number.
test("settlement asset decimals are pinned to what the chain reported, not assumed", () => {
  assert.equal(settlementAsset(BASE_USDC)?.decimals, 6, "USDC carries 6 decimals on Base");
  assert.equal(settlementAsset("0x9e00fc92493451eba1c63dd3880d68b622037ba3")?.decimals, 18, "1F916 carries 18");
  assert.equal(settlementAsset(BASE_USDC)?.stable, true);
  assert.equal(settlementAsset("0x9e00fc92493451eba1c63dd3880d68b622037ba3")?.stable, false,
    "the token is not a stable asset and must never be marked as one");

  // The consequence, stated as a test so it cannot be forgotten: one atomic
  // unit is not one atomic unit across these two assets. A dollar is 1e6 units
  // of USDC and a single token is 1e18 units of 1F916, so an integer compare
  // between them is meaningless by a factor of a trillion.
  const usdcDollar = 10n ** 6n;
  const oneToken = 10n ** 18n;
  assert.ok(oneToken > usdcDollar * 1_000_000n,
    "an integer that looks larger can be worth far less; this is why scalars never span assets");
  assert.equal(soleAsset([BASE_USDC, "0x9e00fc92493451eba1c63dd3880d68b622037ba3"]), null);
});

// THE ESCROW BOUNDARY, which is a promise made in public and was guarded by
// nothing until this test existed.
//
// Migration 0045 opened 1F916 as a settlement asset for promise-funded work and
// deliberately did NOT open it for escrow: that contract is ownerless, cannot be
// paused or patched, and the exact-transfer fork test for this token has not
// been run and archived. The door says so, and GET /api/official says so under
// amended_2026_09_01.still_refused. A claim this load-bearing needs a guard that
// fails, not a sentence.
//
// KILLING MUTATION: in src/settlement.ts, change `token !== BASE_USDC` to use
// assetRefusal, which is exactly the plausible tidy-up that unifies the three
// other gates and would silently open the escrow. This test goes red.
test("the escrow accepts USDC only, whatever the rest of the rail accepts", async () => {
  const { env } = makeEnv();
  const TOKEN = "0x9e00fc92493451eba1c63dd3880d68b622037ba3";

  // The rail as a whole accepts the token: this is the premise, not the point.
  assert.equal(assetRefusal(TOKEN, 8453), null, "the token is a settlement asset elsewhere on the rail");

  // The escrow does not. A funder cannot commit it to the unpatchable contract.
  await assert.rejects(
    createListing(env, AS(1, "funder"), {
      title: "Independent reproduction test", condition: CONDITION,
      amount_atomic: "2000000000000000000000000", expiry: NOW + 86400,
      max_awards: 1, funding_mode: "funded", settlement_mode: "verifier",
      token: TOKEN,
      escrow_chain_id: 8453, escrow_address: "0x" + "b".repeat(40), escrow_token: TOKEN,
      verifiers: [{ handle: "v", key_thumbprint: "t", evm_address: "0x" + "c".repeat(40), cap: 1 }],
      escrow_verifier_deadline: NOW + 3600, escrow_claim_deadline: NOW + 7200,
    }),
    /escrow_token must be the asset this listing prices in/,
    "an escrow-funded token listing must be refused at the door, not published and never satisfiable",
  );
});

// THE PRICE A READER SEES IS DERIVED FROM THE PRICE THE LISTING COMMITS.
//
// Every listing opens a discussion thread whose title and first lines are
// written by this registry in the funder's name. Those lines used to hardcode
// USDC and a 1e6 divisor, which was correct while USDC was the only asset and
// became a lie the moment it was not: a one-token 1F916 listing (18 decimals)
// would have published "1000000000000.00 USDC" — a bounty advertised at one
// trillion dollars, on a public board, under a citizen's own handle.
//
// KILLING MUTATION: restore the divisor to a constant 1e6, or the symbol to the
// literal "USDC". Either goes red on the token case below. Neither goes red on
// the USDC case, which is exactly why this defect survived the asset change.
test("a listing's thread names the asset it actually pays, at the right scale", async () => {
  const { env, db } = makeEnv();
  const TOKEN = "0x9e00fc92493451eba1c63dd3880d68b622037ba3";
  const titleOf = (postId: number) =>
    (db.prepare("SELECT title, body FROM posts WHERE id = ?").get(postId) as { title: string; body: string });

  const dollars = await createListing(env, AS(1, "funder"), {
    title: "Independent reproduction test", condition: CONDITION, amount_atomic: "100000000",
    expiry: NOW + 86400, max_awards: 1, funding_mode: "promise", settlement_mode: "requester",
  }) as Record<string, unknown>;
  const d = titleOf(Number(dollars.post_id));
  assert.match(d.title, /^\[BOUNTY 100 USDC\] Listing /, "a dollar listing reads as dollars");
  assert.match(d.body, /100000000 atomic units of USDC \(100 USDC\)/);

  const tokens = await createListing(env, AS(1, "funder"), {
    title: "Independent reproduction test two", condition: CONDITION,
    amount_atomic: "28000000000000000000000000", token: TOKEN,
    expiry: NOW + 86400, max_awards: 1, funding_mode: "promise", settlement_mode: "requester",
  }) as Record<string, unknown>;
  const t = titleOf(Number(tokens.post_id));
  assert.match(t.title, /^\[BOUNTY 28,000,000 1F916\] Listing /, "28 million tokens, not 28 quintillion dollars");
  assert.ok(!/USDC/.test(t.title), "a token listing must not name the dollar asset anywhere in its title");
  assert.match(t.body, /28000000000000000000000000 atomic units of 1F916 \(28,000,000 1F916\)/);
  assert.ok(!/USDC/.test(t.body.split("CONDITION")[0]!), "nor in the price lines above the condition");
});

// A FUNDER MAY RECORD THAT THEY PAID. THEY MAY NEVER SAY WHO THE PAYEE IS.
//
// Receipts were payee-only, and the reason was right about one field and wrong
// about the rest: funding_relationship is the payee's own testimony, everything
// else is a chain fact the funder's wallet already signs for. Applying the rule
// to the whole object meant a funder who paid on chain kept showing as unpaid
// until the payee woke up — and most citizens here speak once and never return.
//
// KILLING MUTATION, three of them, each closing a different half:
//   (a) restore `if (binding.citizen_id !== submitter.id) throw` in
//       createPayoutReceipt — the funder can no longer record their own payment
//       and the first assertion goes red.
//   (b) drop the `submittedBy === "funder"` branch in validateReceiptInput so a
//       funder's supplied relationship is accepted — the second goes red.
//   (c) delete the table CHECK pairing submitted_by with funding_relationship —
//       the third goes red, because the bad row becomes storable.
// KILLING MUTATION: change `payerOfRecord` to return null for anyone but the
// payee, which is exactly the pre-0046 rule. The funder assertion goes red.
// Written because reverting that rule in the handler killed no test at all: the
// authorization sat inside a path that needs live RPC verification, so the
// headline guarantee was the one thing nothing covered.
test("the funder of the listing may record a payment, and no other stranger may", () => {
  const PAYEE = 2, FUNDER = 7, STRANGER = 9;

  assert.equal(payerOfRecord({ bindingCitizenId: PAYEE, listingFunderCitizenId: FUNDER, submitterId: PAYEE }), "payee");
  assert.equal(payerOfRecord({ bindingCitizenId: PAYEE, listingFunderCitizenId: FUNDER, submitterId: FUNDER }), "funder");
  assert.equal(payerOfRecord({ bindingCitizenId: PAYEE, listingFunderCitizenId: FUNDER, submitterId: STRANGER }), null,
    "a third party may not record someone else's payment");

  // A docket-row binding has no listing and therefore no funder, so it stays
  // payee-only by construction rather than by a separate rule somebody could
  // forget to write.
  assert.equal(payerOfRecord({ bindingCitizenId: PAYEE, listingFunderCitizenId: null, submitterId: FUNDER }), null);
  assert.equal(payerOfRecord({ bindingCitizenId: PAYEE, listingFunderCitizenId: null, submitterId: PAYEE }), "payee");

  // The payee wins the tie when a citizen is somehow both, so their own
  // testimony is never suppressed by their other role.
  assert.equal(payerOfRecord({ bindingCitizenId: PAYEE, listingFunderCitizenId: PAYEE, submitterId: PAYEE }), "payee");
});

// KILLING MUTATION: pass `submitter.id` instead of `binding.citizen_id` to
// settleAwardFromReceipt, which is what the code did before this test existed.
// The second assertion goes red.
//
// That was a live bug and it is the whole reason the funder path exists: when a
// funder recorded their own payment, the award lookup searched for a debt owed
// to the FUNDER, found none, and left the payee's award payable while the money
// was already on chain. The feature half-worked in the exact direction it was
// built to fix, and only using it revealed that.
test("a receipt settles the award of the payee named on the binding, whoever filed it", async () => {
  const { env, db } = makeEnv();
  const PAYEE = 2, FUNDER = 1;
  const listing = await createListing(env, AS(FUNDER, "funder"), {
    title: "Independent reproduction test", condition: CONDITION, amount_atomic: DOLLAR,
    expiry: NOW + 86400, max_awards: 1, funding_mode: "promise", settlement_mode: "requester",
  }) as Record<string, unknown>;
  const listingId = Number(listing.id);
  db.exec(`INSERT INTO listing_submissions (id, listing_id, citizen_id, artifact, payload_hash, commit_nonce, created_at)
           VALUES (901, ${listingId}, ${PAYEE}, 'https://example.invalid/x', 'h-sub-901', 'n-sub-901', 0)`);
  db.exec(`INSERT INTO listing_awards (listing_id, submission_id, citizen_id, amount_atomic, state, awarded_by, awarded_by_citizen_id, awarded_at, payable_at, payload_hash, commit_nonce, created_at)
           VALUES (${listingId}, 901, ${PAYEE}, '1000000', 'payable', 'requester', ${FUNDER}, 0, 0, 'h-settle', 'n-settle', 0)`);

  // A real receipt row, because settleAwardFromReceipt short-circuits on a null
  // id and would pass this test for the wrong reason.
  db.exec(`INSERT INTO payout_bindings (id, citizen_id, docket_id, amount_atomic, created_at) VALUES (950, ${PAYEE}, 'listing-${listingId}', '1000000', 0)`);
  db.exec(`INSERT INTO payout_receipts (id, binding_id, submitter_id, tx_hash, source_address, created_at, submitted_by, funding_relationship)
           VALUES (960, 950, ${FUNDER}, '0xfeed', '0xbeef', 0, 'funder', NULL)`);

  // The binding names the payee. Who SUBMITTED is irrelevant to which award closes.
  const closed = await settleAwardFromReceipt(env, { docket_id: `listing-${listingId}`, citizen_id: PAYEE }, 960, Date.now());
  assert.ok(closed, "the payee's award closes");
  const row = db.prepare("SELECT state FROM listing_awards WHERE citizen_id = ? AND listing_id = ?").get(PAYEE, listingId) as { state: string };
  assert.equal(row.state, "paid", "and it is marked paid, not left payable while the money sits on chain");
});

test("a funder records the payment and never the payee's relationship", () => {
  // (1) The funder mode exists and produces no testimony about the payee.
  const asFunder = validateReceiptInput({
    tx_hash: "0x" + "a".repeat(64), transfer_log_index: 0,
    funder_statement: "1f916.payout-funder.v1:x", funder_signature: "0x" + "b".repeat(130),
  }, "funder");
  assert.equal(asFunder.fundingRelationship, null, "a funder-filed receipt declares no relationship");

  // (2) A funder who supplies one is REFUSED, not silently stripped. Dropping
  // it quietly would hide an attempt to speak for someone else.
  assert.throws(
    () => validateReceiptInput({
      tx_hash: "0x" + "a".repeat(64), transfer_log_index: 0, funding_relationship: "independent",
      funder_statement: "1f916.payout-funder.v1:x", funder_signature: "0x" + "b".repeat(130),
    }, "funder"),
    /a funder may not supply it/,
  );

  // (3) The payee path is unchanged and still demands the declaration.
  assert.throws(
    () => validateReceiptInput({
      tx_hash: "0x" + "a".repeat(64), transfer_log_index: 0,
      funder_statement: "1f916.payout-funder.v1:x", funder_signature: "0x" + "b".repeat(130),
    }, "payee"),
    /funding_relationship must be one of/,
  );
  assert.equal(
    validateReceiptInput({
      tx_hash: "0x" + "a".repeat(64), transfer_log_index: 0, funding_relationship: "independent",
      funder_statement: "1f916.payout-funder.v1:x", funder_signature: "0x" + "b".repeat(130),
    }, "payee").fundingRelationship,
    "independent",
  );
});

// The storage-level half of the same guarantee, because a rule enforced only in
// a validator is a rule some other write path can walk around.
// AGAINST schema.sql ITSELF, not against a fixture. The abbreviated fixtures in
// this file omit constraints for convenience, so asserting on one would prove
// only that I had remembered to copy the CHECK into it. The guarantee belongs to
// the real schema, which is what production is built from.
test("the pairing of submitted_by and funding_relationship is unstorable when wrong", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  db.exec("INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (2, 'p', 'm', 's', 0, 0, 0)");
  db.exec(`INSERT INTO payout_bindings (id, citizen_id, docket_id, version, amount_atomic, chain_id, token, payout_address, expiry,
      wallet_signature, citizen_public_key, citizen_signature, citizen_key_thumbprint, citizen_key_custody, citizen_key_bound_at,
      authorization_verification, authorization_verified_at, docket_updated, docket_snapshot, preimage, authorization_hash,
      payload_hash, commit_nonce, created_at)
    VALUES (900, 2, 'listing-1', '1f916.payout.v1', '1000000', 8453, '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      '0x1111111111111111111111111111111111111111', 9, '0xsig', 'k', 's', 'tp', 'self', 0,
      'valid-at-binding-event', 0, '2026-01-01', '{}', 'pre', 'ah', 'ph', 'cn', 0)`);

  const ins = (by: string, rel: string | null) =>
    db.prepare(`INSERT INTO payout_receipts
      (binding_id, submitter_id, tx_hash, transfer_log_index, source_address, transaction_sender,
       block_number, block_hash, block_timestamp, finalized_block_number, confirmations_at_recording,
       funder_address, funder_statement, funder_signature, funder_attestation_hash, payload_hash,
       checked_at, created_at, submitted_by, funding_relationship)
      VALUES (900, 2, '0x${"a".repeat(64)}', 0, '0x${"2".repeat(40)}', '0x${"2".repeat(40)}',
       1, '0x${"b".repeat(64)}', 0, 2, 12,
       '0x${"2".repeat(40)}', '1f916.payout-funder.v1:x', '0x${"c".repeat(130)}', '${"d".repeat(64)}', '${"e".repeat(64)}',
       0, 0, ?, ?)`).run(by, rel);

  assert.throws(() => ins("funder", "independent"), /CHECK/, "a funder row carrying the payee's testimony must not be storable");
  assert.throws(() => ins("payee", null), /CHECK/, "a payee row with no testimony must not be storable");
  // And the two legitimate shapes both store.
  ins("funder", null);
  db.exec("DELETE FROM payout_receipts");
  ins("payee", "independent");
});

test("treasury-funded work is never counted as outside demand", async () => {
  const { env, db } = makeEnv();
  await createListing(env, AS(1, "funder"), {
    title: "Independent reproduction test", condition: CONDITION, amount_atomic: DOLLAR, expiry: NOW + 86400,
    max_awards: 1, funding_mode: "promise", settlement_mode: "requester",
  });
  const census = await railCensus(env) as Record<string, any>;
  assert.equal(census.demand.external.listings + census.demand.treasury_funded.listings, census.totals.listings, "every listing lands on exactly one side");
  assert.equal(census.demand.treasury_funded.listings, 0, "this fixture's funder signed for their own wallet");
  // The disclosure is served, not filed somewhere nobody reads.
  assert.match(census.demand_note, /NEVER ADDED/);
  assert.match(census.demand_note, /token-related fees/);
  assert.match(census.demand_note, /is NOT external economic demand/);
  void db;
});
