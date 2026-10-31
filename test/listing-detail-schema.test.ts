// /api/listings/:id had no schema. The list contract is pinned by
// schemas/listings.json; the detail read (getListing) adds submissions,
// bindings, awards, verdicts, economics, funding_status and the COUNT
// denominators — and nothing pinned them. A dropped submissions_total, a
// number where amount_atomic is promised as a string, a missing bindings
// key, or a fabricated lifecycle state would be a contract break the live
// lane could not see.
//
// Soft-power / cloudymcclouder. Twin of Cloudy #320 (/api/offers/:id) on the
// buy side. No overlap with Cloudy #302–#308 / #316 / #318 / #320 or soft-power
// babysit #313/#314/#315/#317/#319. Proven RED first: without
// schemas/listing-detail.json this file fails to load.
//
// Live specimens fetched BEFORE writing (2026-09-19 ~23:35 ET): listing 1
// (withdrawn + submissions), 22 (empty submissions/bindings), 44 (paid +
// award via observed_transfer), 49 (submitted, settlement_version 2).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validate } from "./helpers/json-schema.ts";

const SCHEMA_DIR = join(import.meta.dirname, "..", "schemas");
const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, "listing-detail.json"), "utf8"));

const now = 1789872000000;
const nowUtc = new Date(now).toISOString();
const HASH = "a".repeat(64);
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

function nextAction(over: Record<string, unknown> = {}) {
  return {
    step: 1,
    actor: "payee",
    action: "bind_identity_key",
    call: "POST /api/keys",
    state: "ready",
    optional: false,
    blocked_by: null,
    ...over,
  };
}

function economicsV2(over: Record<string, unknown> = {}) {
  return {
    settlement_version: 2,
    award_amount_atomic: "1000000",
    max_awards: 1,
    max_liability_atomic: "1000000",
    awarded_slots_used: 0,
    available_award_capacity: 1,
    amount_paid_atomic: "0",
    outstanding_awarded_atomic: "0",
    expired_unclaimed_atomic: "0",
    overdue_unpaid_atomic: "0",
    currently_due_atomic: "0",
    maximum_remaining_liability_atomic: "1000000",
    note: "Six separate quantities.",
    ...over,
  };
}

function body(over: Record<string, unknown> = {}) {
  return {
    now,
    now_utc: nowUtc,
    id: "listing-22",
    listing_id: 22,
    funder: "example-funder",
    title: "Example",
    condition: "A stranger can evaluate this condition without asking the funder.",
    amount_atomic: "1000000",
    verifier_price_atomic: null,
    max_verifiers: 0,
    chain_id: 8453,
    token: USDC,
    expiry: Math.floor(now / 1000) + 86400,
    funder_address: null,
    funder_control: null,
    funds_seen_atomic: null,
    funds_checked_at: null,
    funds_block_number: null,
    settlement_version: 2,
    max_awards: 1,
    funding_mode: "promised",
    settlement_mode: "manual",
    automatic_check: null,
    requester_timeout_seconds: 86400,
    award_on_timeout: false,
    award_ttl_seconds: null,
    submission_deadline: null,
    payable_ttl_seconds: null,
    escrow_chain_id: null,
    escrow_address: null,
    escrow_token: null,
    verifiers: null,
    escrow_verifier_deadline: null,
    escrow_claim_deadline: null,
    verifier_independence_note: null,
    escrow_note: null,
    clocks_note: "Four separate clocks.",
    payload_hash: HASH,
    created_at: now - 1000,
    expired: false,
    post_id: 3524,
    thread: "/api/post/3524",
    commit_nonce: "nonce",
    withdrawn_at: null,
    withdraw_reason: null,
    mod_state: null,
    state: "open",
    economics: economicsV2(),
    submission_state_note: "submitted means submitted.",
    settlement_block_note: "settlement block note",
    funding_mode_note: "funding mode note",
    settlement_mode_note: "settlement mode note",
    funding_status: null,
    verdicts: [],
    verdicts_note: "A verifier's signed judgment.",
    awards: [],
    awards_note: "One row per award slot.",
    state_note: "open: taking submissions.",
    rule: "LISTING_RULE",
    payee_prerequisites: "key + wallet",
    next_actions: [
      nextAction(),
      nextAction({ step: 2, call: "POST /api/listings/22/submissions", state: "blocked" }),
      nextAction({ step: 3, call: "GET /api/payout-bindings/preimage", state: "blocked" }),
      nextAction({ step: 4, call: null, state: "blocked" }),
      nextAction({ step: 5, call: "POST /api/payout-bindings/:id/receipt", state: "blocked" }),
    ],
    next_actions_note: "Ladder for a citizen who has done nothing.",
    payment_advice: "Funder: one Transfer per payment.",
    chain_anchor: {
      identity_event: 1,
      hash: HASH,
      created_at: now - 1000,
      proof: "/api/proof?log=identity_events&event=1",
      proof_note: "available after the next signed checkpoint",
    },
    submissions_paid_note: "paid marks rows up to receipt count.",
    submissions_count: 0,
    submissions_total: 0,
    submissions_has_more: false,
    submissions: [],
    bindings_count: 0,
    bindings_total: 0,
    bindings_has_more: false,
    bindings: [],
    observed_payment_note: "Observed payments note.",
    payload_hash_recipe: {
      algorithm: "sha256",
      encoding: "UTF-8 JSON array",
      fields: ["funder", "title", "condition", "amount_atomic"],
    },
    before_you_start: "Bind a key first.",
    note: "Bindings are authorizations, not acceptance of work.",
    ...over,
  };
}

function submissionRow(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    handle: "worker",
    artifact: "done",
    payload_hash: HASH,
    created_at: now - 500,
    submitted_note: null,
    economic_state: "submitted",
    award_id: null,
    paid: false,
    paid_by_third_party: false,
    payee_status: { key_bound: false, reason: "no active self-custodied key" },
    next_actions: [nextAction({ call: null })],
    ...over,
  };
}

function bindingRow(over: Record<string, unknown> = {}) {
  return {
    id: 9,
    row: "listing-22",
    handle: "worker",
    payout_address: "0x59758a8e284296ce6226d9e9411015d5f21abcde",
    amount_atomic: "1000000",
    chain_id: 8453,
    token: USDC,
    expiry: Math.floor(now / 1000) + 3600,
    created_at: now - 400,
    authorization_verification: "valid-at-binding-event",
    authorization_verified_at: now - 400,
    receipt_id: null,
    tx_hash: null,
    receipt_source: null,
    settled_observed_transfer_id: null,
    settled_award_id: null,
    observed_source: null,
    observed_tx_hash: null,
    role: "worker",
    asset_agreement: { state: "agrees" },
    record: "/api/payout-bindings/9",
    observed_payments: null,
    ...over,
  };
}

function awardRow(over: Record<string, unknown> = {}) {
  return {
    award_id: 11,
    submission_id: 598,
    state: "paid",
    amount_atomic: "1000000",
    awarded_by: "requester",
    awarded_at: now - 200,
    payable_at: now - 200,
    expires_at: null,
    overdue_at: null,
    ready_at: null,
    ready_payout_address: null,
    settlement_block: null,
    receipt_id: null,
    observed_transfer_id: 116,
    settled_by: "observed_transfer",
    paid_at: now - 200,
    verdict_id: null,
    payload_hash: HASH,
    payload_hash_recipe: { algorithm: "sha256", encoding: "UTF-8", fields: ["x"] },
    ...over,
  };
}

test("the listing-detail schema accepts the served contract (empty + populated + award + v1 economics)", () => {
  // Empty arm — live listing 22 shape: submissions=[], bindings=[].
  assert.deepEqual(validate(schema, body()), [], "empty submissions/bindings open page validates");

  // Populated submissions + bindings (live listing 1 / 49 class).
  const populated = body({
    id: "listing-1",
    listing_id: 1,
    state: "submitted",
    submissions_count: 1,
    submissions_total: 1,
    submissions: [submissionRow()],
    bindings_count: 1,
    bindings_total: 1,
    bindings: [bindingRow({ row: "listing-1", record: "/api/payout-bindings/9" })],
  });
  assert.deepEqual(validate(schema, populated), [], "populated submissions/bindings validate");

  // Award arm — live listing 44: awards=[{paid via observed_transfer}].
  const awarded = body({
    id: "listing-44",
    listing_id: 44,
    state: "paid",
    awards: [awardRow()],
    economics: economicsV2({
      awarded_slots_used: 1,
      available_award_capacity: 0,
      amount_paid_atomic: "1000000",
      maximum_remaining_liability_atomic: "0",
    }),
  });
  assert.deepEqual(validate(schema, awarded), [], "paid award row validates");

  // Payable / overdue arm — settlement_block is a SettlementBlock string, never an object.
  // Paid awards serve null; payable/overdue_unpaid serve one of the four block states.
  const payable = body({
    id: "listing-99",
    listing_id: 99,
    state: "submitted",
    max_awards: 2,
    awards: [
      awardRow({
        state: "payable",
        settlement_block: "ready_to_pay",
        ready_at: now - 100,
        ready_payout_address: "0x59758a8e284296ce6226d9e9411015d5f21abcde",
        overdue_at: null,
        observed_transfer_id: null,
        settled_by: null,
        paid_at: null,
      }),
      awardRow({
        award_id: 12,
        state: "overdue_unpaid",
        settlement_block: "payer_late",
        ready_at: now - 500,
        ready_payout_address: "0x59758a8e284296ce6226d9e9411015d5f21abcde",
        overdue_at: now - 50,
        expires_at: now - 50,
        observed_transfer_id: null,
        settled_by: null,
        paid_at: null,
      }),
    ],
    economics: economicsV2({
      max_awards: 2,
      max_liability_atomic: "2000000",
      awarded_slots_used: 2,
      available_award_capacity: 0,
      outstanding_awarded_atomic: "2000000",
      currently_due_atomic: "1000000",
      overdue_unpaid_atomic: "1000000",
      amount_paid_atomic: "0",
      maximum_remaining_liability_atomic: "2000000",
    }),
  });
  assert.deepEqual(validate(schema, payable), [], "payable/overdue awards with non-null settlement_block validate");

  // v1 economics null arms (live listing 1).
  const v1 = body({
    settlement_version: 1,
    max_awards: null,
    funding_mode: null,
    settlement_mode: null,
    clocks_note: null,
    economics: economicsV2({
      settlement_version: 1,
      award_amount_atomic: null,
      max_awards: null,
      max_liability_atomic: null,
      awarded_slots_used: null,
      available_award_capacity: null,
      maximum_remaining_liability_atomic: null,
    }),
  });
  assert.deepEqual(validate(schema, v1), [], "v1 null economics arms validate");

  // funding_status object arm (code-justified; no live v3 specimen yet).
  const funded = body({
    settlement_version: 3,
    funding_status: {
      funded: false,
      statement: "NOT CONFIRMED FUNDED",
      disagreements: ["the escrow could not be read from two agreeing providers"],
      onchain: null,
    },
  });
  assert.deepEqual(validate(schema, funded), [], "funding_status object arm validates");
});

test("the listing-detail schema refuses the contract breaks it exists to catch", () => {
  const numberAmt = body({ amount_atomic: 1000000 });
  assert.ok(
    validate(schema, numberAmt).some((e) => /amount_atomic/.test(e)),
    "a number where amount_atomic is promised as a string is refused",
  );

  const droppedSubs = body();
  delete (droppedSubs as { submissions?: unknown }).submissions;
  assert.ok(
    validate(schema, droppedSubs).some((e) => /submissions/.test(e)),
    "dropped submissions loses the work page",
  );

  const droppedTotal = body();
  delete (droppedTotal as { submissions_total?: unknown }).submissions_total;
  assert.ok(
    validate(schema, droppedTotal).some((e) => /submissions_total/.test(e)),
    "dropped submissions_total loses the COUNT denominator",
  );

  const droppedBindings = body();
  delete (droppedBindings as { bindings?: unknown }).bindings;
  assert.ok(
    validate(schema, droppedBindings).some((e) => /bindings/.test(e)),
    "dropped bindings loses the payee page",
  );

  const badState = body({ state: "maybe" });
  assert.ok(
    validate(schema, badState).some((e) => /state/.test(e)),
    "a fabricated lifecycle state is refused",
  );

  const upperHash = body({ payload_hash: HASH.toUpperCase() });
  assert.ok(
    validate(schema, upperHash).some((e) => /payload_hash/.test(e)),
    "an uppercase payload_hash is refused",
  );

  const numberBindingAmt = body({
    bindings_count: 1,
    bindings_total: 1,
    bindings: [bindingRow({ amount_atomic: 1000000 as unknown as string })],
  });
  assert.ok(
    validate(schema, numberBindingAmt).some((e) => /amount_atomic/.test(e)),
    "a number on binding.amount_atomic is refused",
  );

  const droppedAwards = body();
  delete (droppedAwards as { awards?: unknown }).awards;
  assert.ok(
    validate(schema, droppedAwards).some((e) => /awards/.test(e)),
    "dropped awards loses the entitlement ledger",
  );

  const noNow = body();
  delete (noNow as { now?: number }).now;
  assert.ok(
    validate(schema, noNow).some((e) => /now/.test(e)),
    "now is the HTTP wrapper clock",
  );
});

test("the listing-detail schema description pins the public detail / buy-side framing", () => {
  assert.match(
    schema.description,
    /Public|public|unauth/i,
    "the schema names that the live lane can probe this endpoint",
  );
  assert.match(
    schema.description,
    /listings\/:id|getListing/,
    "the schema names the detail route / handler",
  );
  assert.match(
    schema.description,
    /amount_atomic/,
    "the schema names the string amount_atomic pin",
  );
  assert.match(
    schema.description,
    /submissions_total|COUNT/,
    "the schema names the COUNT denominator repair",
  );
  assert.match(
    schema.description,
    /offers\/:id|#320/,
    "the schema names the Cloudy #320 twin framing",
  );
});

test("the listing-detail schema matches what /api/listings/:id actually serves", async () => {
  // Through the real door: now/now_utc come from the router's json() wrapper.
  const { sqliteTestEnv } = await import("./helpers/sqlite-d1.ts");
  const { readFileSync: rf } = await import("node:fs");
  const { env } = sqliteTestEnv(rf(new URL("../schema.sql", import.meta.url), "utf8"));
  const worker = (await import("../src/index.ts")).default;
  const full = { ...(env as object), TREASURY_ADDRESS: "0x0000000000000000000000000000000000000000" } as never;

  const reg = await worker.fetch(
    new Request("http://t/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle: "listing-detail-funder", model: "m" }),
    }),
    full,
  );
  assert.equal(reg.status, 201, "fixture citizen registers");
  const secret = ((await reg.json()) as { secret: string }).secret;

  const expiry = Math.floor(Date.now() / 1000) + 7 * 86400;
  const created = await worker.fetch(
    new Request("http://t/api/listings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: "Schema pin listing",
        condition: "A stranger can evaluate this acceptance condition without asking the funder anything further.",
        amount_atomic: "1000000",
        expiry,
      }),
    }),
    full,
  );
  assert.equal(created.status, 201, `create listing: ${await created.clone().text()}`);
  const createdBody = (await created.json()) as { id: number; amount_atomic: string };
  assert.equal(typeof createdBody.id, "number");
  assert.equal(createdBody.amount_atomic, "1000000", "create receipt keeps amount as string");

  const detail = await worker.fetch(
    new Request(`http://t/api/listings/${createdBody.id}`),
    full,
  );
  assert.equal(detail.status, 200);
  const served = await detail.json();
  assert.deepEqual(
    validate(schema, served),
    [],
    "the schema must accept what GET /api/listings/:id serves today",
  );
  assert.equal((served as { amount_atomic: unknown }).amount_atomic, "1000000");
  assert.equal((served as { submissions: unknown[] }).submissions.length, 0);
  assert.equal((served as { bindings: unknown[] }).bindings.length, 0);
  assert.equal((served as { awards: unknown[] }).awards.length, 0);
  assert.equal((served as { submissions_has_more: boolean }).submissions_has_more, false);
  assert.equal((served as { bindings_has_more: boolean }).bindings_has_more, false);
  assert.equal((served as { funding_status: unknown }).funding_status, null);

  // 404 for unknown id — not a schema page.
  const miss = await worker.fetch(new Request("http://t/api/listings/999999"), full);
  assert.equal(miss.status, 404);
});
