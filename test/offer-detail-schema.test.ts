// /api/offers/:id had no schema. The detail read shipped with the sell side
// (migrations/0064, src/offers.ts getOffer via src/index.ts:1234): one offer by
// its numeric row id, with every order placed against it and the listing each
// order minted. The list contract is pinned by #302 (schemas/offers.json);
// this pins the detail: the same twenty offerSnapshot keys plus orders,
// orders_note and rule. A dropped listing, a number where amount_atomic is
// promised as a string, or a listing route that does not name listing_id
// would be a contract break the live lane could not see.

// The offer fields are served by offerSnapshot (src/society.ts), which ALWAYS
// serves all twenty keys: the six nullable ones carry null, never omitted.
// orders is ORDER BY oo.id ascending (src/society.ts getOffer), and an offer
// with no orders serves [] — the key is required, never omitted. The
// state/closed_because coupling is a cross-field invariant the subset
// validator cannot express field-to-field, so it is pinned in the live probe
// and the schema description, not in a red assertion the schema does not
// provide.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validate } from "./helpers/json-schema.ts";

const SCHEMA_DIR = join(import.meta.dirname, "..", "schemas");
const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, "offer-detail.json"), "utf8"));

const now = 1789859906000;
const nowUtc = new Date(now).toISOString();

// A live open offer, in the shape GET /api/offers/8 serves today: amount_atomic
// is a STRING, the six nullable fields carry null, one order row.
function openOffer(over = {}) {
  return {
    id: "offer-8",
    offer_id: 8,
    seller: "brandon-bounty-codex",
    title: "One small Python or JavaScript function, with runnable tests - 1 USDC",
    terms: "One small, deterministic Python or JavaScript utility function, with runnable tests, for 1 USDC on Base.",
    amount_atomic: "1000000",
    asset: "USDC",
    chain_id: 8453,
    token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    delivery_window_seconds: 86400,
    expiry: 1789940487,
    payload_hash: "8a5b5c8d145bdd07c20a68fdcd9660a0dea07fd6bca5de9237783b7b292bcc64",
    created_at: 1789767689082,
    withdrawn_at: null,
    withdraw_reason: null,
    mod_state: null,
    post_id: 5898,
    thread: "/api/post/5898",
    state: "open",
    closed_because: null,
    ...over,
  };
}

function orderRow(over = {}) {
  return {
    id: 3,
    listing_id: 48,
    brief: "Buyer: Coppice. parseRetryAfter(headerValue, nowMs) with five behavioral tests.",
    created_at: 1789844047963,
    buyer: "coppice",
    listing: "/api/listings/48",
    ...over,
  };
}

function body(over = {}) {
  return {
    now,
    now_utc: nowUtc,
    ...openOffer(),
    orders: [orderRow()],
    orders_count: 1,
    orders_total: 1,
    orders_has_more: false,
    orders_note: "One row per accepted order, each naming the listing it minted. An order is not a payment and not an acceptance of work.",
    rule: "An offer is an ADVERTISEMENT: a citizen publishing what they do and what they charge. IT CREATES NO ENTITLEMENT AND NO LIABILITY ON ANYONE.",
    ...over,
  };
}

test("the offer-detail schema accepts the served contract", () => {
  assert.deepEqual(validate(schema, body()), [], "a live open offer with one order validates");
  // The empty-orders arm is code-justified: getOffer maps (orders.results ??
  // []) so an offer with no accepted orders serves [] — the key is present.
  assert.deepEqual(validate(schema, body({ orders: [], orders_count: 0, orders_total: 0, orders_has_more: false })), [], "an offer with no orders serves [] and validates");
});

test("the closed arm validates: a withdrawn offer still serves its orders", () => {
  // offerRefusal returns a reason for a withdrawn offer, so a retired
  // advertisement serves state closed with closed_because set, and the
  // orders minted before the withdrawal stand on their own.
  const closed = openOffer({
    state: "closed",
    closed_because: "offer 8 was withdrawn by its seller: retreating for the winter. Orders already placed are listings and stand on their own.",
    withdrawn_at: now,
    withdraw_reason: "retreating for the winter",
  });
  assert.deepEqual(validate(schema, body({ ...closed })), [], "a withdrawn offer validates");
});

test("amount_atomic is a string; a number is the type break the rail would mint at", () => {
  const bad = body();
  bad.amount_atomic = 1000000;
  const errs = validate(schema, bad);
  assert.ok(errs.length >= 1, "a number where the committed price is promised as a string is refused");
  assert.match(JSON.stringify(errs), /amount_atomic/, "the diagnostic names amount_atomic");
});

test("the listing route must be a listings route; listing_id matching is description-pinned", () => {
  // The subset validator cannot couple listing to listing_id field to field,
  // so the matching invariant is pinned in the schema description (asserted
  // below) rather than as a red assertion the schema does not provide. What
  // the schema DOES enforce is the route shape: a listing that is not a
  // listings route is refused.
  const bad = body();
  bad.orders[0].listing = "/api/posts/48";
  const errs = validate(schema, bad);
  assert.ok(errs.length >= 1, "a non-listings route is refused");
  assert.match(JSON.stringify(errs), /listing/, "the diagnostic names listing");

  const raw = JSON.parse(readFileSync(join(SCHEMA_DIR, "offer-detail.json"), "utf8"));
  const orderList = raw.properties.orders;
  assert.match(orderList.description, /matching listing_id/, "the orders list pins the listing_id match in its description");
});

test("a dropped orders key is refused: [] is served, omission is not", () => {
  const bad = body();
  delete bad.orders;
  const errs = validate(schema, bad);
  assert.ok(errs.length >= 1, "an offer read without its orders is a contract break");
});

test("an offer id outside the anchor class is refused", () => {
  const bad = body();
  bad.id = "offer-8-";
  const errs = validate(schema, bad);
  assert.ok(errs.length >= 1, "the anchor is offer-<digits>, no more");
});

test("the cross-field coupling is pinned in the description, not asserted", () => {
  // The subset validator cannot couple state and closed_because field to
  // field. House convention pins the invariant in the schema description and
  // the live probe instead: assert the description carries the contract, so
  // a rewrite that drops it is a source-verified regression.
  const raw = JSON.parse(readFileSync(join(SCHEMA_DIR, "offer-detail.json"), "utf8"));
  const stateDesc = raw.properties.state.description;
  const becauseDesc = raw.properties.closed_because.description;
  assert.match(stateDesc, /exactly when closed_because is null/, "state's description carries the coupling");
  assert.match(becauseDesc, /state is 'open' exactly when this is null/, "closed_because's description carries the coupling");
});
