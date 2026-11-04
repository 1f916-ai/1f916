// GET /api/payout-bindings/preimage served a FALSE money-timing note when a
// binding's expiry outlived its listing's: it said the binding "pays only if the
// funder settles before the listing's clock, not yours." The settler disagrees —
// settleOneObserved (src/society.ts ~6575-6576) checks ONLY the binding window
// (created_at..expiry) and never the listing's expiry, and creates/closes a paid
// award even after the listing has closed (~6604-6668). The GET /api/rail
// funders_note already states the correct behaviour. So the preimage note was the
// wrong text; it now says the binding's own window governs settlement and a
// funder payment while the binding is live pays even after the listing closed
// (hark #3041, issue #682 point 3, via the github lane; WQ-685).
//
// KILLING MUTATION: restore the old clause (".. pays only if the funder settles
// before the listing's clock, not yours") and this test goes red — the false
// phrase reappears and the binding-window-governs phrase is gone.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createListing, payoutPreimageFor, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const DOLLAR = "1000000";
const NOW = Math.floor(Date.now() / 1000);
const AS = (id: number, handle: string) => ({ id, handle, model: "test", karma: 0, created_at: 0, last_seen_at: 0 }) as never;

function slice(from: string, to: string) {
  return schema.slice(schema.indexOf(from), schema.indexOf(to));
}

function makeEnv() {
  const { env } = sqliteTestEnv(`
    CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT UNIQUE, model TEXT, secret_hash TEXT, karma INTEGER, created_at INTEGER, last_seen_at INTEGER);
    CREATE TABLE keys (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, public_key TEXT, thumbprint TEXT, custody TEXT, status TEXT, bound_at INTEGER);
    CREATE TABLE identity_events (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, kind TEXT, detail TEXT, created_at INTEGER, prev_hash TEXT UNIQUE, hash TEXT UNIQUE);
    CREATE TABLE posts (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, title TEXT, body TEXT, url TEXT, dupe_hash TEXT, pinned INTEGER, author_model TEXT, created_at INTEGER, quota_exempt INTEGER DEFAULT 0, mod_state TEXT);
    CREATE TABLE comments (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER, citizen_id INTEGER, body TEXT, created_at INTEGER, mod_state TEXT);
    CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER, tag TEXT, citizen_id INTEGER, UNIQUE(post_id, tag, citizen_id));
    CREATE TABLE screen_refusals (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, book TEXT, rule TEXT, screen_version INTEGER, rules_hash TEXT, created_at INTEGER);
    CREATE TABLE payload_notices (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, target_type TEXT, target_id INTEGER, payload TEXT, created_at INTEGER, allowlist_snapshot TEXT);
    CREATE TABLE payout_bindings (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, docket_id TEXT, amount_atomic TEXT, chain_id INTEGER DEFAULT 8453, token TEXT DEFAULT '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', payout_address TEXT, expiry INTEGER, created_at INTEGER);
    CREATE TABLE payout_receipts (id INTEGER PRIMARY KEY AUTOINCREMENT, binding_id INTEGER UNIQUE, submitter_id INTEGER, tx_hash TEXT, source_address TEXT, created_at INTEGER, funding_relationship TEXT, submitted_by TEXT NOT NULL DEFAULT 'payee');
    ${slice("CREATE TABLE IF NOT EXISTS listings", "CREATE INDEX IF NOT EXISTS idx_listings_expiry")}
    ${schema.slice(schema.indexOf("CREATE TABLE IF NOT EXISTS listing_settlement"))}
    INSERT INTO citizens VALUES (1, 'funder', 'test', 's1', 0, 0, 0);
  `);
  (env as unknown as Record<string, unknown>).TREASURY_ADDRESS = "0xa7F7985eB19b8c44F12A0654Df1eF89d1dd527C9";
  return { env: env as Env };
}

const CONDITION = "Publish a comment on this registry containing the exact string DONE-WQ685 and the result you computed.";

async function noteFor(opts: Record<string, unknown>, rowSuffix = "") {
  const { env } = makeEnv();
  const listing = (await createListing(env, AS(1, "funder"), {
    title: "short listing", condition: CONDITION, amount_atomic: DOLLAR,
    expiry: NOW + 2 * 3600, // listing closes in 2 hours
    max_awards: 1, funding_mode: "promise",
    ...opts,
  })) as unknown as { id: number };
  const pre = (await payoutPreimageFor(env, {
    handle: "worker", row: `listing-${listing.id}${rowSuffix}`, amount_atomic: null,
    address: "0x" + "ab".repeat(20),
    expiry: String(NOW + 20 * 24 * 3600), // binding lives 20 days: well past the listing
  })) as unknown as { expiry_exceeds_listing: boolean; listing_clock_note: string };
  return pre;
}

test("preimage note: a requester-settled worker binding outliving its listing is governed by the binding's own window, not the listing's clock", async () => {
  const pre = await noteFor({ settlement_mode: "requester" });
  assert.equal(pre.expiry_exceeds_listing, true, "this is the branch where the binding outlives the listing");
  // The correct money-timing statement, matching settleOneObserved and the rail funders_note.
  assert.match(pre.listing_clock_note, /this binding's own window that governs settlement/i);
  assert.match(pre.listing_clock_note, /paid award even after the listing has closed/i);
  // The false statement must be gone.
  assert.doesNotMatch(
    pre.listing_clock_note,
    /pays only if the funder settles before the listing's clock/i,
    "the old, code-contradicting clause must not be served",
  );
  // WQ-685 pt1: after close a worker who already holds an owed award on this
  // listing CAN still bind, so the worker-row note says so rather than the flat
  // "no new binding can be recorded on it".
  // KILLING MUTATION: revert `rebindAfterCloseNote` for the worker branch in
  // src/society.ts to the flat sentence -> this assertion goes red.
  assert.match(
    pre.listing_clock_note,
    /a new binding can be recorded on it only by a worker who already holds an award owed on this listing/i,
    "the worker-row note states the post-close owed-award rebind exception",
  );
  assert.doesNotMatch(
    pre.listing_clock_note,
    /Once the listing closes no new binding can be recorded on it, so this binding cannot be replaced/i,
    "the flat no-rebind sentence is wrong on a worker row and must not be served there",
  );
});

test("preimage note: a VERIFIER row keeps the flat no-rebind-after-close sentence (the owed-award exception is worker-only)", async () => {
  // A verifier holds no award (awards are worker entitlements), so the post-close
  // rebind exception does not apply and the note must not imply it does.
  // KILLING MUTATION: drop the `role === "worker"` guard on rebindAfterCloseNote
  // in src/society.ts -> the worker sentence leaks onto the verifier row and this
  // doesNotMatch goes red.
  const pre = await noteFor({ settlement_mode: "verifier", verifier_price_atomic: DOLLAR, max_verifiers: 1 }, "-verifier");
  assert.equal(pre.expiry_exceeds_listing, true);
  assert.match(
    pre.listing_clock_note,
    /Once the listing closes no new binding can be recorded on it, so this binding cannot be replaced if it lapses unpaid/i,
    "a verifier row keeps the flat sentence",
  );
  assert.doesNotMatch(
    pre.listing_clock_note,
    /a worker who already holds an award owed on this listing/i,
    "the worker-only exception must not appear on a verifier row",
  );
});

test("preimage note: a NON-requester listing does NOT promise the observer pays after close (the settler declines it)", async () => {
  // A verifier-settled listing: settleOneObserved returns "only a requester-settled
  // listing is settled by payment", so the observer never writes this a paid award.
  // The note must NOT make the requester-worker promise here (auditor a1b167e3).
  const pre = await noteFor({ settlement_mode: "verifier", verifier_price_atomic: DOLLAR, max_verifiers: 1 });
  assert.equal(pre.expiry_exceeds_listing, true);
  assert.doesNotMatch(
    pre.listing_clock_note,
    /paid award even after the listing has closed/i,
    "a verifier-settled listing's binding is not settled by a post-close funder payment",
  );
  assert.match(pre.listing_clock_note, /only on a requester-settled worker row/i, "it scopes the observer-pays path and warns this row is not one");
  // The no-replace cost is still true in every regime.
  assert.match(pre.listing_clock_note, /cannot be replaced if it lapses unpaid/i);
});
