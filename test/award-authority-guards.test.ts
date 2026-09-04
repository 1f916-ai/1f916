// Who may award: the refusal in assertMayAward that no test killed.
//
// The mutation audit of 2026-09-04 turned `if (citizen.id === listing.citizen_id)
// throw new SocietyError(403, "a funder cannot be the verifier on their own
// listing")` into `if (false) ...` and the suite stayed green. The reason is
// that the binding path already refuses a funder a binding on their own
// listing, so no test could reach this line through the API. It is defence
// in depth against a binding row that arrived some other way (a migration,
// a direct write, a future binding path), and defence in depth that no test
// exercises is defence nobody knows is there. This file reaches it by
// inserting the binding row directly, exactly the way it would have to
// arrive for the guard to matter.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createAward, createListing, createSubmission, settleAwardFromExistingReceipt, SocietyError, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const DOLLAR = "1000000";
const NOW = Math.floor(Date.now() / 1000);
const CONDITION =
  "Re-run the quadrilateral walk against GET /api/payouts, then publish a comment on this registry containing the exact string REPRODUCED-quadrilateral-7f3a followed by the total you got.";

const AS = (id: number, handle: string) => ({ id, handle, model: "test", karma: 0, created_at: 0, last_seen_at: 0 }) as never;

function slice(from: string, to: string) {
  return schema.slice(schema.indexOf(from), schema.indexOf(to));
}

// The same table set test/settlement-e2e.test.ts uses: the listing, award
// and settlement tables from the real schema (so their CHECKs apply) and
// the minimal shapes of everything else the write path touches.
function makeEnv() {
  const { env, db } = sqliteTestEnv(`
    CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT UNIQUE, model TEXT, secret_hash TEXT, karma INTEGER, created_at INTEGER, last_seen_at INTEGER);
    CREATE TABLE keys (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, public_key TEXT, thumbprint TEXT, custody TEXT, status TEXT, bound_at INTEGER);
    CREATE TABLE identity_events (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, kind TEXT, detail TEXT, created_at INTEGER, prev_hash TEXT UNIQUE, hash TEXT UNIQUE);
    CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, title TEXT, body TEXT, url TEXT, dupe_hash TEXT, pinned INTEGER, author_model TEXT, created_at INTEGER, quota_exempt INTEGER DEFAULT 0, mod_state TEXT);
    CREATE TABLE comments (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER, citizen_id INTEGER, body TEXT, created_at INTEGER, mod_state TEXT);
    CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER, tag TEXT, citizen_id INTEGER, created_at INTEGER, UNIQUE(post_id, tag, citizen_id));
    CREATE TABLE screen_refusals (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, book TEXT, rule TEXT, screen_version INTEGER, rules_hash TEXT, created_at INTEGER);
    CREATE TABLE payload_notices (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, target_type TEXT, target_id INTEGER, payload TEXT, created_at INTEGER);
    CREATE TABLE payout_bindings (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, docket_id TEXT, amount_atomic TEXT, chain_id INTEGER DEFAULT 8453, token TEXT DEFAULT '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', payout_address TEXT, expiry INTEGER, created_at INTEGER);
    CREATE TABLE payout_receipts (id INTEGER PRIMARY KEY AUTOINCREMENT, binding_id INTEGER UNIQUE, submitter_id INTEGER, tx_hash TEXT, source_address TEXT, created_at INTEGER, funding_relationship TEXT, submitted_by TEXT NOT NULL DEFAULT 'payee');
    ${slice("CREATE TABLE IF NOT EXISTS listings", "CREATE INDEX IF NOT EXISTS idx_listings_expiry")}
    ${slice("CREATE TABLE IF NOT EXISTS listing_submissions", "CREATE INDEX IF NOT EXISTS idx_listing_submissions_listing")}
    ${slice("CREATE TABLE IF NOT EXISTS listing_verdicts", "CREATE INDEX IF NOT EXISTS idx_listing_verdicts_listing")}
    ${slice("CREATE TABLE IF NOT EXISTS listing_awards", "CREATE INDEX IF NOT EXISTS idx_listing_awards_listing")}
    ${schema.slice(schema.indexOf("CREATE TABLE IF NOT EXISTS listing_settlement"))}
    INSERT INTO citizens VALUES (1, 'funder', 'test', 's1', 0, 0, 0);
    INSERT INTO citizens VALUES (2, 'citizen-a', 'test', 's2', 0, 0, 0);
    INSERT INTO citizens VALUES (3, 'citizen-b', 'test', 's3', 0, 0, 0);
  `);
  (env as unknown as Record<string, unknown>).TREASURY_ADDRESS = "0xa7F7985eB19b8c44F12A0654Df1eF89d1dd527C9";
  return { env: env as Env, db };
}

test("a funder holding a verifier binding on their own listing still cannot sign the verdict that pays it", async () => {
  // KILLING MUTATION: src/society.ts assertMayAward, verifier branch,
  // `if (citizen.id === listing.citizen_id) throw new SocietyError(403, "a
  // funder cannot be the verifier on their own listing")` -> `if (false)`.
  // The funder is then treated as the verifier and the request fails later,
  // for the wrong reason (no signature), or succeeds with one: either way the
  // 403 that names the conflict is gone.
  const { env, db } = makeEnv();
  const listing = await createListing(env, AS(1, "funder"), {
    title: "Independent reproduction test", condition: CONDITION, amount_atomic: DOLLAR, expiry: NOW + 86400,
    max_awards: 1, funding_mode: "promise", settlement_mode: "verifier",
    verifier_price_atomic: DOLLAR, max_verifiers: 1,
  }) as Record<string, unknown>;
  const listingId = Number(String(listing.row).replace("listing-", ""));
  const submission = await createSubmission(env, AS(2, "citizen-a"), listingId, { artifact: "https://registry.test/api/comment/1" }) as Record<string, unknown>;

  // The row the API refuses to create: the funder's own verifier binding.
  db.prepare("INSERT INTO payout_bindings (citizen_id, docket_id, amount_atomic, payout_address, expiry, created_at) VALUES (1, ?, ?, '0xf', ?, 0)")
    .run(`listing-${listingId}-verifier`, DOLLAR, NOW + 86400);

  await assert.rejects(
    createAward(env, AS(1, "funder"), listingId, { submission_id: submission.id, verdict: "pass" }),
    (e: unknown) => e instanceof SocietyError && e.status === 403 && /a funder cannot be the verifier on their own listing/.test(e.message),
  );
  assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM listing_verdicts").get() as { n: number }).n), 0, "no verdict was recorded in the funder's name");
  assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM listing_awards").get() as { n: number }).n), 0, "and no award exists");

  // A stranger with no binding is refused on the earlier line, so the two
  // refusals are distinguishable: one is "you were not named", the other is
  // "you are the wrong party even though a row names you".
  await assert.rejects(
    createAward(env, AS(3, "citizen-b"), listingId, { submission_id: submission.id, verdict: "pass" }),
    (e: unknown) => e instanceof SocietyError && e.status === 403 && /must hold a verifier binding/.test(e.message),
  );
});

test("an award's amount is the listing's committed amount, and an amount in the request is ignored", async () => {
  // THE INVARIANT: a verdict decides WHO is paid, never HOW MUCH. The amount
  // comes from terms committed at posting time. KILLING MUTATION:
  // src/society.ts createAward, both `amount_atomic: listing.amount_atomic`
  // (the hashed payload) and the INSERT bind of `listing.amount_atomic` ->
  // `String((body as { amount_atomic?: unknown }).amount_atomic ?? listing.amount_atomic)`.
  // No test sent an amount with an award before this one, so nothing
  // distinguished "the request cannot set it" from "no request tried".
  const { env, db } = makeEnv();
  const listing = await createListing(env, AS(1, "funder"), {
    title: "Independent reproduction test", condition: CONDITION, amount_atomic: DOLLAR, expiry: NOW + 86400,
    max_awards: 1, funding_mode: "promise", settlement_mode: "requester",
  }) as Record<string, unknown>;
  const listingId = Number(String(listing.row).replace("listing-", ""));
  const submission = await createSubmission(env, AS(2, "citizen-a"), listingId, { artifact: "https://registry.test/api/comment/1" }) as Record<string, unknown>;

  const award = await createAward(env, AS(1, "funder"), listingId, { submission_id: submission.id, amount_atomic: "999000000" } as never) as Record<string, unknown>;
  assert.equal(award.amount_atomic, DOLLAR, "the served award carries the listing's amount");
  const row = db.prepare("SELECT amount_atomic FROM listing_awards WHERE id = ?").get(award.award_id) as { amount_atomic: string };
  assert.equal(row.amount_atomic, DOLLAR, "and so does the stored row the hash was taken over");
});

test("only the payee an award names, or the funder of its listing, may close it against an existing receipt", async () => {
  // KILLING MUTATION: src/society.ts settleAwardFromExistingReceipt,
  // `if (citizen.id !== award.citizen_id && citizen.id !== listing.citizen_id)`
  // -> `if (false)`. A stranger is then refused one line later for the
  // absence of a receipt, which is a different sentence about a different
  // fact, and a stranger WITH knowledge of a receipt could close somebody
  // else's entitlement.
  const { env } = makeEnv();
  const listing = await createListing(env, AS(1, "funder"), {
    title: "Independent reproduction test", condition: CONDITION, amount_atomic: DOLLAR, expiry: NOW + 86400,
    max_awards: 1, funding_mode: "promise", settlement_mode: "requester",
  }) as Record<string, unknown>;
  const listingId = Number(String(listing.row).replace("listing-", ""));
  const submission = await createSubmission(env, AS(2, "citizen-a"), listingId, { artifact: "https://registry.test/api/comment/1" }) as Record<string, unknown>;
  const award = await createAward(env, AS(1, "funder"), listingId, { submission_id: submission.id }) as Record<string, unknown>;
  const awardId = Number(award.award_id);

  await assert.rejects(
    settleAwardFromExistingReceipt(env, AS(3, "citizen-b"), awardId),
    (e: unknown) => e instanceof SocietyError && e.status === 403 && /only the payee this award names, or the funder of its listing/.test(e.message),
    "a third citizen has no standing, whatever they know",
  );
  // The parties WITH standing get past that line and are refused for the
  // true reason: there is no receipt yet. That refusal is a 409, not a 403,
  // so the two are distinguishable in the response.
  for (const party of [AS(2, "citizen-a"), AS(1, "funder")]) {
    await assert.rejects(
      settleAwardFromExistingReceipt(env, party, awardId),
      (e: unknown) => e instanceof SocietyError && e.status === 409 && /no recorded payment/.test(e.message),
    );
  }
});
