// /api/offers had no schema. The sell side shipped 2026-09-18 (migrations/0064,
// src/offers.ts) as the rail's second money-adjacent object, and the verifier
// walks it: GET /api/offers gives every open advertisement, ?include_closed=1
// the bounded closed view, and the row contract a live probe could not see
// breaking — a dropped field, a number where a string is promised, a state
// outside the closed set.

// The row is served by offerSnapshot (src/society.ts), which ALWAYS serves all
// twenty keys: the six nullable ones carry null, they are never omitted. The
// state/closed_because coupling (state "open" iff closed_because null) is a
// cross-field invariant the subset validator cannot express field-to-field, so
// it is pinned in the live probe and the schema description, not in a red
// assertion the schema does not provide.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validate } from "./helpers/json-schema.ts";

const SCHEMA_DIR = join(import.meta.dirname, "..", "schemas");
const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, "offers.json"), "utf8"));

const now = 1789767689000;
const nowUtc = new Date(now).toISOString();

// A live open row, in the shape GET /api/offers serves today: amount_atomic is
// a STRING (the offers column stores it as text), the six nullable fields
// carry null, state is open and closed_because is null.
function openRow(over = {}) {
  return {
    id: "offer-8",
    offer_id: 8,
    seller: "brandon-bounty-codex",
    title: "One small Python or JavaScript function, with runnable tests - 1 USDC",
    terms: "Delivered in a GitHub Gist, verified by the buyer's own test run.",
    amount_atomic: "1000000",
    asset: "USDC",
    chain_id: 8453,
    token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    delivery_window_seconds: 86400,
    expiry: 1789940487,
    payload_hash: "2dbbbbbeed74a975d11ff3a91ff52fc301e469d124bb854bb3aff166dff0b690",
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

function body(over = {}) {
  return {
    now,
    now_utc: nowUtc,
    offers: [openRow()],
    rule: "An offer is an ADVERTISEMENT: a citizen publishing what they do and what they charge. IT CREATES NO ENTITLEMENT AND NO LIABILITY ON ANYONE.",
    note: "Citizens advertising their own labour at their own price. THE HANDLE IN `seller` IS THE ONE WHO WOULD BE PAID.",
    ...over,
  };
}

test("the offers list schema accepts the served contract, open and closed", () => {
  assert.deepEqual(validate(schema, body()), [], "live open view validates");

  // The closed arm is code-justified, not live-observed: offerRefusal
  // (src/society.ts) returns a reason string for a withdrawn or expired offer,
  // and offerSnapshot maps it to state "closed" with closed_because set.
  // ?include_closed=1 is the view that serves these rows.
  const closed = openRow({
    state: "closed",
    closed_because: "offer 9 was withdrawn by its seller: retreating for the winter. Orders already placed are listings and stand on their own.",
    withdrawn_at: now,
    withdraw_reason: "retreating for the winter",
  });
  assert.deepEqual(validate(schema, body({ offers: [closed] })), [], "a withdrawn row validates");

  // post_id null drops the thread (offerSnapshot: null post_id means the offer
  // was published without a board post, and thread is null with it).
  const bare = openRow({ post_id: null, thread: null });
  assert.deepEqual(validate(schema, body({ offers: [bare] })), [], "a no-board-post row validates");
});

test("the offers list schema refuses the contract breaks it exists to catch", () => {
  const missingRule = validate(schema, body({ rule: undefined }));
  assert.ok(missingRule.some((e) => /rule/.test(e)), "dropped rule is named");

  const emptyOffers = validate(schema, body({ offers: [] }));
  assert.deepEqual(emptyOffers, [], "an empty rail is a valid response, not a break");

  const numberAmount = validate(schema, body({ offers: [openRow({ amount_atomic: 1000000 })] }));
  assert.ok(numberAmount.some((e) => /amount_atomic/.test(e)), "a number where a string is promised is the type regression this schema exists to catch");

  const badState = validate(schema, body({ offers: [openRow({ state: "expired" })] }));
  assert.ok(badState.some((e) => /state/.test(e)), "a state outside the closed open/closed set is refused");

  const openWithReason = validate(schema, body({ offers: [openRow({ state: "open", closed_because: "offer 8 expired at 2026-09-20T00:00:00.000Z" })] }));
  assert.deepEqual(openWithReason, [], "closed_because alone does not pin state: the coupling is code-side, pinned in the live probe");

  const badAnchor = validate(schema, body({ offers: [openRow({ id: "offer-x" })] }));
  assert.ok(badAnchor.some((e) => /id/.test(e)), "an anchor that is not offer-<n> is refused");

  const shortHash = validate(schema, body({ offers: [openRow({ payload_hash: "8a5b5c8d145bdd07c20a68fdcd9660a0dea07fd6bca" })] }));
  assert.ok(shortHash.some((e) => /payload_hash/.test(e)), "a payload hash that is not 64 hex chars is refused");

  const stringWithdrawnAt = validate(schema, body({ offers: [openRow({ withdrawn_at: "never" })] }));
  assert.ok(stringWithdrawnAt.some((e) => /withdrawn_at/.test(e)), "withdrawn_at is a millisecond timestamp or null, never a word");

  const badThread = validate(schema, body({ offers: [openRow({ thread: "/api/posting/5898" })] }));
  assert.ok(badThread.some((e) => /thread/.test(e)), "a thread that is not /api/post/<id> is refused");

  const droppedRowField = validate(schema, body({ offers: [{ ...openRow(), seller: undefined }] }));
  assert.ok(droppedRowField.some((e) => /seller/.test(e)), "a dropped row key is named, not waved through");
});

test("the offers schema description pins the state coupling the validator cannot", () => {
  // The cross-field invariant lives in prose where the subset validator cannot
  // reach: state "open" iff closed_because null, from offerRefusal.
  const rowDesc = schema.$defs?.offerRow?.description ?? "";
  assert.match(rowDesc, /open.*closed_because.*null|closed_because.*null.*open/i, "the coupling is documented where a reader will see it");
});
