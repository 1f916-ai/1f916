// WQ-685 pt1 (hark, issue #682). After a listing closes, POST /api/payout-bindings
// was refused unconditionally (payouts.ts validatePayoutBinding, the
// listingClosedReason gate), so a worker who was AWARDED before close but never
// filed a binding had no on-rail route and the owed award could never be paid.
// The debt was preserved but unreachable. Fix: after close, accept a binding ONLY
// from a worker who already holds an owed award (awarded/payable/overdue_unpaid)
// on THAT listing. No new entrants; a moderated listing stays fully closed.
//
// The closed gate runs BEFORE the wallet-signature and key gates, so these tests
// drive the gate by omitting the wallet signature: a binding that PASSES the
// closed gate then reaches the wallet-proof lookup and fails with "no live
// payout-wallet proof"; a binding REFUSED at the gate fails with the close
// message. The two messages are the signal.
//
// KILLING MUTATIONS (each watched red):
//  1. Drop the owed-award check (always refuse when closed): the awardee case
//     fails with the close message instead of the wallet-proof message -> red.
//  2. Drop the listing scope (remove `listing_id = ?`): an award on listing A
//     lets a binding on closed listing B reach the wallet gate -> the B-refusal
//     assertion goes red.
//  3. Drop the `!listing.mod_state` guard: a moderated listing lets an awardee
//     past the gate -> the moderation-refusal assertion goes red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BASE_USDC, PAYOUT_VERSION, validatePayoutBinding } from "../src/payouts.ts";
import { createListing, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const DOLLAR = "1000000";
const NOW = Math.floor(Date.now() / 1000);
const AS = (id: number, handle: string) => ({ id, handle, model: "test", karma: 0, created_at: 0, last_seen_at: 0 }) as never;
const CONDITION = "Publish a comment containing the exact string DONE-WQ685pt1 and the result you computed, nothing less.";

function freshEnv() {
  const { env, db } = sqliteTestEnv(schema);
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at) VALUES
      (1, 'funder', 'test', 's1', 0, 0, 0),
      (2, 'winner', 'test', 's2', 0, 0, 0),
      (3, 'bystander', 'test', 's3', 0, 0, 0);
  `);
  (env as unknown as Record<string, unknown>).TREASURY_ADDRESS = "0xa7F7985eB19b8c44F12A0654Df1eF89d1dd527C9";
  return { env: env as Env, db };
}

// A requester-settled listing, then forced closed by moving its expiry into the
// past (expiry <= now is exactly listingClosedReason's "expired" case).
async function closedListing(env: Env, db: import("node:sqlite").DatabaseSync, opts: Record<string, unknown> = {}) {
  const listing = (await createListing(env, AS(1, "funder"), {
    title: "a closed listing", condition: CONDITION, amount_atomic: DOLLAR,
    expiry: NOW + 3600, max_awards: 1, funding_mode: "promise", settlement_mode: "requester",
    ...opts,
  })) as unknown as { id: number };
  db.prepare("UPDATE listings SET expiry = ? WHERE id = ?").run(NOW - 100, listing.id);
  return listing.id;
}

// An owed award (state 'awarded') for `citizenId` on `listingId`, with the real
// submission it was made against (FKs are enforced in this harness).
function awardOn(db: import("node:sqlite").DatabaseSync, listingId: number, citizenId: number, tag: string) {
  const sub = db.prepare(
    `INSERT INTO listing_submissions (listing_id, citizen_id, artifact, payload_hash, commit_nonce, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(listingId, citizenId, `artifact-${tag}`, `sub-ph-${tag}`, `sub-cn-${tag}`, NOW * 1000);
  db.prepare(
    `INSERT INTO listing_awards (listing_id, submission_id, citizen_id, amount_atomic, state, awarded_by, awarded_at, payload_hash, commit_nonce, created_at)
     VALUES (?, ?, ?, ?, 'awarded', 'requester', ?, ?, ?, ?)`,
  ).run(listingId, Number(sub.lastInsertRowid), citizenId, DOLLAR, NOW * 1000, `ph-${tag}`, `cn-${tag}`, NOW * 1000);
}

// A binding body with NO wallet signature: it reaches the wallet-proof gate only
// if it first passes the closed gate and the amount/asset/expiry gates.
const workerBody = (listingId: number, handle: string) => ({
  version: PAYOUT_VERSION, handle, row: `listing-${listingId}`, amount_atomic: DOLLAR,
  chain_id: 8453, token: BASE_USDC, address: "0x" + "ab".repeat(20), expiry: NOW + 3600,
});

test("a worker holding an owed award on a CLOSED listing passes the closed gate", async () => {
  const { env, db } = freshEnv();
  const listingId = await closedListing(env, db);
  awardOn(db, listingId, 2, "A");
  // Reaches the wallet-proof gate => it got past the closed gate.
  await assert.rejects(
    validatePayoutBinding(env, AS(2, "winner"), workerBody(listingId, "winner"), NOW),
    (e: unknown) => e instanceof Error && /no live payout-wallet proof/.test(e.message),
    "an awardee on a closed listing is not stopped at the close gate",
  );
});

test("a citizen with NO award on the closed listing is still refused at the close gate", async () => {
  const { env, db } = freshEnv();
  const listingId = await closedListing(env, db);
  awardOn(db, listingId, 2, "A"); // the award belongs to citizen 2, not 3
  await assert.rejects(
    validatePayoutBinding(env, AS(3, "bystander"), workerBody(listingId, "bystander"), NOW),
    (e: unknown) => e instanceof Error && /expired at .*a binding cannot authorize payment against a task nobody is offering/.test(e.message),
    "a non-awardee cannot bind after close",
  );
});

test("an award on listing A does NOT let a binding be filed on a different closed listing B", async () => {
  const { env, db } = freshEnv();
  const listingA = await closedListing(env, db);
  const listingB = await closedListing(env, db);
  awardOn(db, listingA, 2, "A"); // citizen 2 is owed on A only
  await assert.rejects(
    validatePayoutBinding(env, AS(2, "winner"), workerBody(listingB, "winner"), NOW),
    (e: unknown) => e instanceof Error && /a binding cannot authorize payment against a task nobody is offering/.test(e.message),
    "the owed-award exception is scoped to the award's own listing",
  );
});

test("a MODERATED closed listing stays fully closed even to an awardee", async () => {
  const { env, db } = freshEnv();
  const listingId = await closedListing(env, db);
  db.prepare("UPDATE listings SET mod_state = 'removed' WHERE id = ?").run(listingId);
  awardOn(db, listingId, 2, "A");
  await assert.rejects(
    validatePayoutBinding(env, AS(2, "winner"), workerBody(listingId, "winner"), NOW),
    (e: unknown) => e instanceof Error && /by moderation/.test(e.message),
    "moderation is an active hold; the owed-award exception does not reopen it",
  );
});
