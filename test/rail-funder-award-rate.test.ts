// The served guide's `unpaid` text tells a worker what happens when nobody
// pays: "the listing reads expired-with-submissions on the funder's record".
// The funders table on GET /api/rail carried no such count. Every figure on a
// funder row was derived from the award ledger, and liability only exists
// once a funder awards, so a funder who collected work and never awarded
// anything read cleanest of all: zero owed, zero overdue, nothing to see. A
// withdraw after work arrived dodged even the per-listing word, because the
// listing then reads `withdrawn`.
//
// The fix counts, per funder and per LISTING (never per submission), the
// listings that ENDED (expired or withdrawn) with work in, how many of those
// carry an award that holds a seat, how many were withdrawn with work already
// in, and the rate. Only scored submissions put a listing into a rate: from a
// citizen registered strictly before the listing was created, never the
// funder, and handed in before the last 24 hours of the listing's life (a
// fixed society constant, SCORING_GRACE_SECONDS). Listings with work but none of it scored are counted apart.
// Three groups, never added: requester-settled settlement_version 2 listings
// (unprefixed, the funder decides), settlement_version 2 listings a verifier
// or automatic check decides (delegated_), and settlement_version 3 and above
// (escrow_). These tests pin each count on rows built by hand.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { railCensus, SCORING_GRACE_SECONDS, type Env } from "../src/society.ts";
import { listingsGuide } from "../src/listings.ts";

class Statement {
  private args: unknown[] = [];
  private readonly db: DatabaseSync;
  private readonly sql: string;
  constructor(db: DatabaseSync, sql: string) { this.db = db; this.sql = sql; }
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>(): Promise<T | null> { return (this.db.prepare(this.sql).get(...this.args) as T | undefined) ?? null; }
  async all<T>(): Promise<{ results: T[] }> { return { results: this.db.prepare(this.sql).all(...this.args) as T[] }; }
  async run() { return { meta: { changes: Number(this.db.prepare(this.sql).run(...this.args).changes) } }; }
}
class LocalD1 {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }
  prepare(sql: string) { return new Statement(this.db, sql); }
  async batch(stmts: Statement[]) { const out = []; for (const s of stmts) out.push(await s.run()); return out; }
}

const TOKEN = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const C = "c".repeat(40);

// submitters: citizen ids, one submission each, in place of the default
// alternating older workers (3, 4). 5 registered after every listing here;
// 6 registered in the same millisecond as every listing here (created_at 200).
// mode: settlement_mode (default requester). timeout: requester_timeout_seconds.
// createdAt: the listing's created_at in ms (default 200). submittedAt: every
// submission's created_at in ms (default 250, long before any expiry here, so
// the grace window never bites unless a test says so).
type Listing = { id: number; funder: number; expiry: number; version?: number; withdrawn?: boolean; submissions?: number; submitters?: number[]; mode?: string; timeout?: number; submittedAt?: number; createdAt?: number };

function makeEnv(listings: Listing[], awards: Array<{ listing: number; state: string; citizen?: number }> = []): Env {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  sqlite.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES
      (1, 'silent', 'test-model', 'x', 100, 100),
      (2, 'payer', 'test-model', 'x', 100, 100),
      (3, 'worker', 'test-model', 'x', 100, 100),
      (4, 'worker2', 'test-model', 'x', 100, 100),
      (5, 'fresh', 'test-model', 'x', 500, 500),
      (6, 'sametime', 'test-model', 'x', 200, 200);
  `);
  // An award points at a submission by its awardee: (listing, citizen) -> submission id.
  const subIdByListingCitizen = new Map<string, number>();
  let sub = 0;
  for (const l of listings) {
    sqlite.prepare(
      `INSERT INTO listings (id, citizen_id, title, condition, amount_atomic, chain_id, token, expiry, payload_hash, commit_nonce, created_at, settlement_version, withdrawn_at, withdraw_reason, settlement_mode, requester_timeout_seconds)
       VALUES (?, ?, 'a listing', ?, '1000000', 8453, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(l.id, l.funder, C, TOKEN, l.expiry, `ph-${l.id}`, `n-${l.id}`, l.createdAt ?? 200, l.version ?? 2, l.withdrawn ? 300 : null, l.withdrawn ? "changed my mind" : null, l.mode ?? "requester", l.timeout ?? null);
    const who = l.submitters ?? Array.from({ length: l.submissions ?? 0 }, (_, i) => 3 + (i % 2));
    for (let i = 0; i < who.length; i++) {
      sub += 1;
      sqlite.prepare(
        `INSERT INTO listing_submissions (id, listing_id, citizen_id, artifact, payload_hash, commit_nonce, created_at) VALUES (?, ?, ?, 'https://example.invalid/pr', ?, ?, ?)`,
      ).run(sub, l.id, who[i], `sph-${sub}`, `sn-${sub}`, l.submittedAt ?? 250);
      if (!subIdByListingCitizen.has(`${l.id}:${who[i]}`)) subIdByListingCitizen.set(`${l.id}:${who[i]}`, sub);
    }
  }
  let n = 0;
  for (const a of awards) {
    n += 1;
    // Each state's CHECK couplings in schema.sql: payable_at on every state
    // that was an entitlement, overdue_at on overdue, expired_at on expiries.
    const everPayable = a.state === "payable" || a.state === "overdue_unpaid" || a.state === "expired_unclaimed";
    sqlite.prepare(
      `INSERT INTO listing_awards (listing_id, submission_id, citizen_id, amount_atomic, state, awarded_by, awarded_at, payable_at, overdue_at, expired_at, payload_hash, commit_nonce, created_at)
       VALUES (?, ?, ?, '1000000', ?, 'requester', 260, ?, ?, ?, ?, ?, 260)`,
    ).run(
      a.listing, subIdByListingCitizen.get(`${a.listing}:${a.citizen ?? 3}`)!, a.citizen ?? 3, a.state,
      everPayable ? 260 : null,
      a.state === "overdue_unpaid" ? 270 : null,
      a.state === "expired_unmet" || a.state === "expired_unclaimed" ? 270 : null,
      `aph-${n}`, `an-${n}`,
    );
  }
  return { DB: new LocalD1(sqlite) } as unknown as Env;
}

const nowS = () => Math.floor(Date.now() / 1000);

async function funderRow(env: Env, handle: string) {
  const census = await railCensus(env) as Record<string, any>;
  const row = (census.funders as Array<Record<string, unknown>>).find((f) => f.funder === handle);
  assert.ok(row, `funder ${handle} has a row`);
  return { row: row!, census };
}

test("a funder whose listing expires with two submissions and no award reads ended_with_submissions 1, awarded 0, award_rate 0", async () => {
  const env = makeEnv([{ id: 1, funder: 1, expiry: nowS() - 3600, submissions: 2 }]);
  const { row } = await funderRow(env, "silent");
  assert.equal(row.listings_ended_with_submissions, 1, "one listing ended with work handed in");
  assert.equal(row.listings_ended_with_submissions_awarded, 0, "and nothing was awarded on it");
  assert.equal(row.withdrawn_after_submissions, 0, "it expired, it was not withdrawn");
  assert.equal(row.award_rate, 0, "0 of 1 is a rate of 0, not an absence");
});

test("a listing withdrawn after a submission counts in withdrawn_after_submissions and in ended_with_submissions", async () => {
  const env = makeEnv([{ id: 1, funder: 1, expiry: nowS() + 86_400, withdrawn: true, submissions: 1 }]);
  const { row } = await funderRow(env, "silent");
  assert.equal(row.withdrawn_after_submissions, 1, "withdrawing with work in does not make the listing vanish from the funder's record");
  assert.equal(row.listings_ended_with_submissions, 1, "a withdrawn listing has ended");
  assert.equal(row.award_rate, 0);
});

test("a listing that ended with no submissions, and one still open with submissions, do not count; the rate is null with nothing to divide", async () => {
  const env = makeEnv([
    { id: 1, funder: 1, expiry: nowS() - 3600, submissions: 0 },
    { id: 2, funder: 1, expiry: nowS() - 3600, withdrawn: true, submissions: 0 },
    { id: 3, funder: 1, expiry: nowS() + 86_400, submissions: 3 },
  ]);
  const { row } = await funderRow(env, "silent");
  assert.equal(row.listings_ended_with_submissions, 0);
  assert.equal(row.withdrawn_after_submissions, 0, "withdrawing before anyone handed work in is not a mark");
  assert.equal(row.award_rate, null, "no ended listing with work in: there is no rate, and 0 would be an accusation");
});

test("an award that holds a seat counts the listing as awarded; a reserved seat that lapsed unmet does not", async () => {
  const past = nowS() - 3600;
  const env = makeEnv(
    [
      { id: 1, funder: 2, expiry: past, submissions: 1 },
      { id: 2, funder: 2, expiry: past, submissions: 2 },
      { id: 3, funder: 2, expiry: past, submissions: 1 },
      { id: 4, funder: 2, expiry: past, submissions: 1 },
    ],
    [
      { listing: 1, state: "payable" },
      { listing: 2, state: "overdue_unpaid" },
      { listing: 3, state: "expired_unmet" },
    ],
  );
  const { row } = await funderRow(env, "payer");
  assert.equal(row.listings_ended_with_submissions, 4);
  assert.equal(row.listings_ended_with_submissions_awarded, 2, "payable and overdue_unpaid hold a seat; expired_unmet returned it");
  assert.equal(row.award_rate, 0.5);
});

test("legacy (pre-v2) listings hold no award ledger, so they are counted apart and never enter the rate", async () => {
  const env = makeEnv([
    { id: 1, funder: 1, expiry: nowS() - 3600, version: 1, submissions: 2 },
    { id: 2, funder: 1, expiry: nowS() - 3600, version: 1, withdrawn: true, submissions: 1 },
  ]);
  const { row, census } = await funderRow(env, "silent");
  assert.equal(row.listings_ended_with_submissions, 0, "a v1 listing cannot hold an award, so it cannot be scored as unawarded");
  assert.equal(row.withdrawn_after_submissions, 0);
  assert.equal(row.award_rate, null);
  assert.equal(row.legacy_ended_with_submissions, 2, "the unknown has a size on the same row");
  assert.match(String(census.funders_note), /award_rate/, "the note names the field it explains");
  assert.match(String(census.derivations.award_rate), /expired_unmet/, "the derivation names the states that do not count, from the predicate");
});

test("the guide's unpaid text points at the funder fields it promises", () => {
  const guide = listingsGuide("https://1f916.ai") as Record<string, any>;
  const unpaid = String(guide.for_workers.unpaid);
  assert.match(unpaid, /listings_ended_with_submissions/, "the promise names the field that keeps it");
  assert.match(unpaid, /GET \/api\/rail/, "and where to read it");
  assert.match(unpaid, /delegated_/, "the guide names the group a verifier or check decides");
  assert.match(unpaid, /escrow_/, "and the escrow group");
});

test("a listing whose only submissions come from accounts registered after it was created never enters the rate, and is counted apart", async () => {
  const env = makeEnv([{ id: 1, funder: 1, expiry: nowS() - 3600, submitters: [5, 5] }]);
  const { row, census } = await funderRow(env, "silent");
  assert.equal(row.listings_ended_with_submissions, 0, "an account made after the listing appeared cannot put it in the denominator");
  assert.equal(row.award_rate, null);
  assert.equal(row.ended_with_submissions_unscored, 1, "the listing is still on the funder's row, apart from the rate");
  assert.match(String(census.funders_note), /ended_with_submissions_unscored/);
  assert.match(String(census.funders_note), /colludes/, "the note names what the rule does not stop");
});

test("one submission from an account older than the listing is enough, beside any number from newer ones", async () => {
  const env = makeEnv([{ id: 1, funder: 1, expiry: nowS() - 3600, submitters: [5, 3, 5] }]);
  const { row } = await funderRow(env, "silent");
  assert.equal(row.listings_ended_with_submissions, 1);
  assert.equal(row.ended_with_submissions_unscored, 0);
  assert.equal(row.award_rate, 0);
});

test("an account registered in the same millisecond as the listing counts as newer: older means strictly earlier", async () => {
  const env = makeEnv([{ id: 1, funder: 1, expiry: nowS() - 3600, submitters: [6] }]);
  const { row, census } = await funderRow(env, "silent");
  assert.equal(row.listings_ended_with_submissions, 0);
  assert.equal(row.ended_with_submissions_unscored, 1);
  assert.match(String(census.derivations.award_rate), /strictly earlier/, "the derivation states the boundary");
});

test("an escrow-backed listing (settlement_version 3 and above) lands in the escrow figures and never in the requester-settled rate", async () => {
  const past = nowS() - 3600;
  const env = makeEnv(
    [
      { id: 1, funder: 2, expiry: past, version: 3, submissions: 1 },
      { id: 2, funder: 2, expiry: past, version: 3, submissions: 1 },
      { id: 3, funder: 2, expiry: past, version: 3, submitters: [5] },
      { id: 4, funder: 2, expiry: past, version: 2, submissions: 1 },
    ],
    [{ listing: 1, state: "payable" }],
  );
  const { row, census } = await funderRow(env, "payer");
  assert.equal(row.escrow_listings_ended_with_submissions, 2, "two escrow listings ended with work from older accounts");
  assert.equal(row.escrow_listings_ended_with_submissions_awarded, 1);
  assert.equal(row.escrow_award_rate, 0.5);
  assert.equal(row.escrow_ended_with_submissions_unscored, 1, "the newer-account rule applies to escrow listings too");
  assert.equal(row.escrow_withdrawn_after_submissions, 0);
  assert.equal(row.listings_ended_with_submissions, 1, "only the settlement_version 2 listing is in the requester-settled figures");
  assert.equal(row.listings_ended_with_submissions_awarded, 0);
  assert.equal(row.award_rate, 0, "the escrow award does not lift the requester-settled rate");
  assert.equal(row.ended_with_submissions_unscored, 0);
  assert.match(String(census.funders_note), /locked in a contract before the work/, "the note says what an escrow rate is about");
});

test("a funder with only requester-settled listings reads escrow_award_rate null, not 0", async () => {
  const env = makeEnv([{ id: 1, funder: 1, expiry: nowS() - 3600, submissions: 1 }]);
  const { row } = await funderRow(env, "silent");
  assert.equal(row.escrow_listings_ended_with_submissions, 0);
  assert.equal(row.escrow_award_rate, null);
});

test("on a long listing the grace window is capped at 24 hours: work handed in 25 hours before expiry is scored, 23 hours before is not", async () => {
  const expiry = nowS() - 3600;
  const env = makeEnv([
    { id: 1, funder: 1, expiry, submissions: 1, submittedAt: (expiry - 25 * 3600) * 1000 },
    { id: 2, funder: 1, expiry, submissions: 1, submittedAt: (expiry - 23 * 3600) * 1000 },
  ]);
  const { row, census } = await funderRow(env, "silent");
  assert.equal(SCORING_GRACE_SECONDS, 86_400);
  assert.equal(row.listings_ended_with_submissions, 1, "only the work handed in 25 hours out is scored");
  assert.equal(row.ended_with_submissions_unscored, 1, "the late one stays on the row, apart from the rate");
  assert.equal(row.award_rate, 0);
  assert.match(String(census.derivations.award_rate), /fixed by rule/);
});

test("a requester timeout the funder declares longer than the listing's life does not stop the rate: the grace window is not the funder's to choose", async () => {
  const env = makeEnv([{ id: 1, funder: 1, expiry: nowS() - 3600, timeout: 2_592_000, submissions: 1 }]);
  const { row } = await funderRow(env, "silent");
  assert.equal(row.listings_ended_with_submissions, 1);
  assert.notEqual(row.award_rate, null, "a 30-day declared timeout must not make the listing unscoreable");
  assert.equal(row.award_rate, 0);
});

test("on a short listing the grace window is half its life: a 6-hour listing scores work from its first 3 hours", async () => {
  const expiry = nowS() - 3600;
  const createdAt = (expiry - 6 * 3600) * 1000;
  const env = makeEnv([
    { id: 1, funder: 1, expiry, createdAt, submissions: 1, submittedAt: createdAt + 2.5 * 3600 * 1000 },
    { id: 2, funder: 1, expiry, createdAt, submissions: 1, submittedAt: createdAt + 3.5 * 3600 * 1000 },
  ]);
  const { row, census } = await funderRow(env, "silent");
  assert.equal(row.listings_ended_with_submissions, 1, "work 2.5 hours into a 6-hour listing is scored");
  assert.equal(row.ended_with_submissions_unscored, 1, "work 3.5 hours in falls in the last half and is not");
  assert.match(String(census.derivations.award_rate), /half the listing's life/, "the derivation states the rule");
});

test("a 25-hour listing scores work up to its midpoint, not up to 24 hours before expiry", async () => {
  const expiry = nowS() - 3600;
  const createdAt = (expiry - 25 * 3600) * 1000;
  const env = makeEnv([
    { id: 1, funder: 1, expiry, createdAt, submissions: 1, submittedAt: createdAt + 12 * 3600 * 1000 },
    { id: 2, funder: 1, expiry, createdAt, submissions: 1, submittedAt: createdAt + 13 * 3600 * 1000 },
  ]);
  const { row } = await funderRow(env, "silent");
  assert.equal(row.listings_ended_with_submissions, 1, "12 hours in is before the 12.5-hour midpoint");
  assert.equal(row.ended_with_submissions_unscored, 1, "13 hours in is after it, though 12 hours before expiry");
});

test("an award to an account registered after the listing never lifts the rate, even when older work was handed in too", async () => {
  const past = nowS() - 3600;
  const env = makeEnv(
    [
      { id: 1, funder: 2, expiry: past, submitters: [3, 5] },
      { id: 2, funder: 2, expiry: past, submitters: [3, 5] },
    ],
    [
      { listing: 1, state: "payable", citizen: 5 },
      { listing: 2, state: "payable", citizen: 3 },
    ],
  );
  const { row, census } = await funderRow(env, "payer");
  assert.equal(row.listings_ended_with_submissions, 2, "both listings hold scored work from the older account");
  assert.equal(row.listings_ended_with_submissions_awarded, 1, "only the award to the older account counts");
  assert.equal(row.award_rate, 0.5);
  assert.match(String(census.funders_note), /expired_unclaimed/, "the note names the cheapest way to inflate the rate");
});

test("a listing decided by a named verifier or an automatic check lands in the delegated_ figures, never the funder's own rate", async () => {
  const past = nowS() - 3600;
  const env = makeEnv([
    { id: 1, funder: 1, expiry: past, mode: "verifier", submissions: 1 },
    { id: 2, funder: 1, expiry: past, mode: "automatic", submissions: 1 },
    { id: 3, funder: 1, expiry: past, mode: "requester", submissions: 1 },
  ]);
  const { row, census } = await funderRow(env, "silent");
  assert.equal(row.delegated_listings_ended_with_submissions, 2);
  assert.equal(row.delegated_award_rate, 0, "a silent verifier moves this rate");
  assert.equal(row.listings_ended_with_submissions, 1, "and not the rate of what the funder decided");
  assert.match(String(census.funders_note), /a named verifier or an automatic check decides, not the funder/);
});

test("the rate is per listing: ten submissions and one award count once, as awarded", async () => {
  const env = makeEnv([{ id: 1, funder: 2, expiry: nowS() - 3600, submissions: 10 }], [{ listing: 1, state: "payable" }]);
  const { row, census } = await funderRow(env, "payer");
  assert.equal(row.listings_ended_with_submissions, 1);
  assert.equal(row.award_rate, 1);
  assert.match(String(census.derivations.award_rate), /never per submission/);
});
