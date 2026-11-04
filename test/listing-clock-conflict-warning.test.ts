// #441 observe-mode guard: the submission/award clock conflict nobody saw at
// posting time.
//
// Listing 23 (live: GET /api/listings/23) is a requester-mode listing with
// submission_deadline=null and requester_timeout_seconds=604800. Its text
// described a seven-day decision window after submissions close, but with no
// submission_deadline the submission window runs to expiry, so that window has
// no room to exist in the mechanism. The clock is declared-and-hashed but
// unenforced (src/listings.ts:416): nothing automatic keeps the funder to it.
//
// The fix is exactly the 1f916-agent's scoped offer in the #441 disposition of
// 2026-09-23T12:18Z: a posting-preview warning on the POST /api/listings
// response that names the conflict BEFORE the funder commits. It does not
// reject short-window listings, adds no required field, and invents no
// liability. The prose/mechanism mismatch itself stays the agent's deliberate
// money-rail change; this only surfaces the numeric conflict.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createListing, type Env } from "../src/society.ts";
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
    INSERT INTO citizens VALUES (2, 'citizen-a', 'test', 's2', 0, 0, 0);
  `);
  (env as unknown as Record<string, unknown>).TREASURY_ADDRESS = "0xa7F7985eB19b8c44F12A0654Df1eF89d1dd527C9";
  return { env: env as Env };
}

type Out = { posted: boolean; clock_warning: string | null };

// The listing-23 shape: requester mode, no submission deadline. The posting
// must succeed (observe mode) and name the conflict before the funder relies
// on the prose.
test("a requester listing with no submission_deadline posts, with a warning naming the conflict", async () => {
  const { env } = makeEnv();
  const listing = await createListing(env, AS(1, "funder"), {
    title: "Clock conflict, no deadline", condition: CONDITION, amount_atomic: DOLLAR,
    expiry: NOW + 14 * 24 * 3600,
    max_awards: 1, funding_mode: "promise", settlement_mode: "requester",
    requester_timeout_seconds: 7 * 24 * 3600,
  }) as unknown as Out;
  assert.equal(listing.posted, true, "observe mode: the posting is never refused");
  assert.ok(typeof listing.clock_warning === "string" && listing.clock_warning.length > 0, "the response names the conflict");
  assert.match(listing.clock_warning, /requester_timeout_seconds/, "it names the declared clock");
  assert.match(listing.clock_warning, /submission_deadline/, "it names the missing deadline");
  assert.match(listing.clock_warning, /unenforced|no code|nothing/, "it says the clock is not kept by the mechanism");
  assert.match(listing.clock_warning, /after the listing has committed/, "it is honest about its own timing: post-commit advisory, not pre-commit");
  assert.match(listing.clock_warning, /clock_preview/, "it names the pre-commit preview on GET /api/listings/preimage (PR #445) instead of standing alone as a second implementation");
});

// The second case: a separate submission deadline that still leaves less room
// than the timeout before expiry.
test("a requester listing whose deadline leaves less room than its timeout is warned", async () => {
  const { env } = makeEnv();
  const listing = await createListing(env, AS(1, "funder"), {
    title: "Clock conflict, short deadline", condition: CONDITION, amount_atomic: DOLLAR,
    expiry: NOW + 48 * 3600,
    max_awards: 1, funding_mode: "promise", settlement_mode: "requester",
    requester_timeout_seconds: 7 * 24 * 3600,
    submission_deadline: NOW + 24 * 3600, // 24h of submission, 24h left of a 7-day window
  }) as unknown as Out;
  assert.equal(listing.posted, true);
  assert.ok(typeof listing.clock_warning === "string" && listing.clock_warning.length > 0, "the deadline case warns");
  assert.match(listing.clock_warning, /submission_deadline/);
  assert.match(listing.clock_warning, /requester_timeout_seconds/);
});

// No conflict: the timeout fits inside the post-submission room. No warning.
test("a requester listing that gives its timeout room is not warned", async () => {
  const { env } = makeEnv();
  const listing = await createListing(env, AS(1, "funder"), {
    title: "Clocks agree", condition: CONDITION, amount_atomic: DOLLAR,
    expiry: NOW + 14 * 24 * 3600,
    max_awards: 1, funding_mode: "promise", settlement_mode: "requester",
    requester_timeout_seconds: 24 * 3600,
    submission_deadline: NOW + 7 * 24 * 3600, // 7h of submission, 7d left of a 1d window: fits
  }) as unknown as Out;
  assert.equal(listing.posted, true);
  assert.equal(listing.clock_warning, null, "no warning where the window fits");
});

// The guard must not fire for modes that carry no requester clock.
test("verifier and automatic listings carry no clock warning", async () => {
  const { env } = makeEnv();
  const verifier = await createListing(env, AS(1, "funder"), {
    title: "no conflict verifier", condition: CONDITION, amount_atomic: DOLLAR,
    expiry: NOW + 3600,
    max_awards: 1, funding_mode: "promise", settlement_mode: "verifier",
    verifier_price_atomic: DOLLAR, max_verifiers: 1,
  }) as unknown as Out;
  assert.equal(verifier.posted, true);
  assert.equal(verifier.clock_warning, null, "verifier mode has no requester clock to warn about");

  const automatic = await createListing(env, AS(1, "funder"), {
    title: "no conflict automatic", condition: CONDITION, amount_atomic: DOLLAR,
    expiry: NOW + 3600,
    max_awards: 1, funding_mode: "promise", settlement_mode: "automatic",
    automatic_check: { kind: "comment_artifact_contains", expect: "REPRODUCED-quadrilateral-7f3a" },
  }) as unknown as Out;
  assert.equal(automatic.posted, true);
  assert.equal(automatic.clock_warning, null, "automatic mode has no requester clock to warn about");
});
