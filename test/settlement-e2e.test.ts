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
import { MockSettlementAdapter } from "../src/settlement.ts";
import { createAward, createListing, createSubmission, getListing, railCensus, type Env } from "../src/society.ts";

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
    CREATE TABLE keys (id INTEGER PRIMARY KEY, citizen_id INTEGER, public_key TEXT, thumbprint TEXT, custody TEXT, status TEXT, bound_at INTEGER);
    CREATE TABLE identity_events (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, kind TEXT, detail TEXT, created_at INTEGER, prev_hash TEXT UNIQUE, hash TEXT UNIQUE);
    CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, title TEXT, body TEXT, url TEXT, dupe_hash TEXT, pinned INTEGER, author_model TEXT, created_at INTEGER, quota_exempt INTEGER DEFAULT 0, mod_state TEXT);
    CREATE TABLE comments (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER, citizen_id INTEGER, body TEXT, created_at INTEGER, mod_state TEXT);
    CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER, tag TEXT, citizen_id INTEGER, created_at INTEGER, UNIQUE(post_id, tag, citizen_id));
    CREATE TABLE screen_refusals (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, book TEXT, rule TEXT, screen_version INTEGER, rules_hash TEXT, created_at INTEGER);
    CREATE TABLE payload_notices (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, target_type TEXT, target_id INTEGER, payload TEXT, created_at INTEGER);
    CREATE TABLE payout_bindings (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, docket_id TEXT, amount_atomic TEXT, payout_address TEXT, expiry INTEGER, created_at INTEGER);
    CREATE TABLE payout_receipts (id INTEGER PRIMARY KEY AUTOINCREMENT, binding_id INTEGER UNIQUE, submitter_id INTEGER, tx_hash TEXT, source_address TEXT, created_at INTEGER);
    ${slice(schema, "CREATE TABLE IF NOT EXISTS listings", "CREATE INDEX IF NOT EXISTS idx_listings_expiry")}
    ${slice(schema, "CREATE TABLE IF NOT EXISTS listing_submissions", "CREATE INDEX IF NOT EXISTS idx_listing_submissions_listing")}
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
    assert.equal(award.state, "awarded");
    assert.equal(award.amount_atomic, DOLLAR);
    awardIds.push(Number(award.award_id));

    // Settle it: the adapter releases, and the receipt closes the award.
    const released = await adapter.release(listingId, Number(award.award_id), DOLLAR, "0xpayee");
    assert.equal(released.alreadyReleased, false);
    // The receipt is a real row, so the award's foreign key and its
    // UNIQUE(receipt_id) are the ones production enforces.
    db.prepare("INSERT INTO payout_receipts (binding_id, submitter_id, tx_hash, source_address, created_at) VALUES (?, ?, ?, '0xfunder', 0)").run(index + 1, worker.id, `0xtx${index}`);
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
  assert.equal(award.state, "awarded");

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
  assert.equal(census.totals.outstanding_awarded_atomic, DOLLAR);
  assert.equal(census.totals.paid_atomic, "0");
  assert.equal(census.totals.maximum_remaining_liability_atomic, "3000000", "one dollar outstanding plus two uncommitted slots");
  assert.notEqual(census.totals.outstanding_awarded_atomic, String(census.totals.bindings * 1000000), "outstanding is never bindings times the award amount");

  const row = census.listings[0];
  assert.equal(row.funding_mode, "funded");
  assert.equal(row.settlement_mode, "automatic");
  assert.equal(row.state, "open");
  assert.equal(row.worker_bindings, 2);
  assert.equal(row.economics.available_award_capacity, 2);
  // Every figure carries its derivation, and the reading note names the trap.
  for (const key of ["bindings", "receipts", "lapsed_bindings", "awards", "outstanding_awarded_atomic", "maximum_remaining_liability_atomic"]) {
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
  assert.equal(census.totals.listings_without_declared_cap, 1);
  assert.equal(census.totals.outstanding_awarded_atomic, "0", "a historical binding is not a debt");
  assert.equal(census.totals.maximum_remaining_liability_atomic, "0", "and contributes nothing to the rail total");
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
