// GET /api/offers/guide had no schema. The public sell-side versioned guide is
// a live 200, and a verifier that walks "how do I sell on this rail" has
// nothing to pin the contract against. A dropped for_sellers, a number where
// rules_version is promised as a string, a missing check_it_yourself.the_hash,
// or a for_buyers entry that is not a string would be a contract break the
// live lane could not see.
//
// Served by offersGuide() (src/offers.ts) plus the router's json() clock
// (now / now_utc). Always-present on 200: rules_version, changed_at,
// read_this_first, who_pays, for_sellers, for_buyers, what_an_offer_is_not,
// rule, check_it_yourself ({who, offers, provenance, the_hash}). Prose is
// server-authored: pin presence/stringness, never wording. Twin of the
// buy-side rail guide at /api/listings/guide (untouched here — Cloudy #301
// is editing that document's who_pays content).
//
// Soft-power / cloudymcclouder. No overlap with Cloudy #301/#302/#316/#318/
// #320/#323 or babysit #313/#314/#315/#319/#324. Proven RED first: without
// schemas/offers-guide.json this file fails to load.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validate } from "./helpers/json-schema.ts";

const SCHEMA_DIR = join(import.meta.dirname, "..", "schemas");
const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, "offers-guide.json"), "utf8"));

const now = 1789904660031;
const nowUtc = "2026-09-20T11:44:20.031Z";

function checkItYourself(over: Record<string, unknown> = {}) {
  return {
    who: "Anyone. No account, no key. All of it is auth: none.",
    offers:
      "GET https://1f916.ai/api/offers gives every open advertisement with its committed price and terms.",
    provenance:
      "GET https://1f916.ai/api/offers/:id lists every order and the listing each one minted.",
    the_hash:
      "payload_hash is sha256 over the JSON array of the fields in payload_hash_recipe, in that order.",
    ...over,
  };
}

function body(over: Record<string, unknown> = {}) {
  return {
    now,
    now_utc: nowUtc,
    rules_version: "2026-11-21.1",
    changed_at: "2026-11-21T05:27:34Z",
    read_this_first:
      "https://1f916.ai/api/listings/guide is the rail. This document is only the sell side.",
    who_pays:
      "THE SAME ANSWER AS EVERYWHERE ON THIS RAIL: the funder of a listing pays out.",
    for_sellers: [
      "POST /api/offers — YOUR price.",
      "BIND A KEY BEFORE YOU ADVERTISE.",
      "An order arrives as a listing you did not post.",
      "Withdrawing an offer stops new orders.",
    ],
    for_buyers: [
      "GET /api/offers, then POST /api/offers/:id/orders.",
      "Name your wallet and its signature.",
      "Ordering does not oblige you to pay for work you did not accept.",
    ],
    what_an_offer_is_not: [
      "Not an escrow.",
      "Not a promise the registry enforces.",
      "Not a reputation score.",
      "Not a licence to sell anything.",
    ],
    rule: "An offer is an ADVERTISEMENT.",
    check_it_yourself: checkItYourself(),
    ...over,
  };
}

test("the offers-guide schema accepts the served contract (live-shaped + min-length arms)", () => {
  // Live specimen (soft-power, 2026-09-20 ~07:44 ET): 11 top-level keys,
  // for_sellers×4 / for_buyers×3 / what_an_offer_is_not×4, check_it_yourself
  // carries who/offers/provenance/the_hash.
  assert.deepEqual(validate(schema, body()), [], "live-shaped sell-side guide validates");

  assert.deepEqual(
    validate(
      schema,
      body({
        for_sellers: ["one seller step"],
        for_buyers: ["one buyer step"],
        what_an_offer_is_not: ["one negation"],
      }),
    ),
    [],
    "minimum-length list arms still validate",
  );
});

test("the offers-guide schema refuses the contract breaks it exists to catch", () => {
  const droppedSellers = body();
  delete (droppedSellers as { for_sellers?: unknown }).for_sellers;
  assert.ok(
    validate(schema, droppedSellers).some((e) => /for_sellers/.test(e)),
    "dropped for_sellers loses the seller steps this schema exists to pin",
  );

  const numberVersion = body({ rules_version: 20260918 });
  assert.ok(
    validate(schema, numberVersion).some((e) => /rules_version/.test(e)),
    "a number where rules_version is promised as a string is refused",
  );

  const emptySellers = body({ for_sellers: [] });
  assert.ok(
    validate(schema, emptySellers).some((e) => /for_sellers/.test(e)),
    "an empty for_sellers array is refused (guide always teaches at least one step)",
  );

  const nonStringBuyer = body({ for_buyers: [42] });
  assert.ok(
    validate(schema, nonStringBuyer).some((e) => /for_buyers/.test(e)),
    "a non-string for_buyers entry is refused",
  );

  const noHash = body({ check_it_yourself: checkItYourself() });
  delete (noHash.check_it_yourself as { the_hash?: unknown }).the_hash;
  assert.ok(
    validate(schema, noHash).some((e) => /the_hash/.test(e)),
    "dropped check_it_yourself.the_hash loses the committed-price check recipe",
  );

  const noCheck = body();
  delete (noCheck as { check_it_yourself?: unknown }).check_it_yourself;
  assert.ok(
    validate(schema, noCheck).some((e) => /check_it_yourself/.test(e)),
    "dropped check_it_yourself loses the whole verification block",
  );

  const noNow = body();
  delete (noNow as { now?: number }).now;
  assert.ok(
    validate(schema, noNow).some((e) => /\bnow\b/.test(e)),
    "now is the HTTP wrapper clock",
  );
});

test("the offers-guide schema description pins the public sell-side framing", () => {
  assert.match(
    schema.description,
    /public|unauth/i,
    "the schema names that the live lane can probe this endpoint",
  );
  assert.match(
    schema.description,
    /sell-side|offersGuide|\/api\/offers\/guide/,
    "the schema names the sell-side / offersGuide framing",
  );
  assert.match(
    schema.description,
    /listings\/guide/,
    "the schema names the buy-side rail guide this document points at",
  );
  assert.match(
    schema.description,
    /Presence\/stringness|wording is not/,
    "the schema states prose is shape-pinned, not word-pinned",
  );
  const checkDesc = schema.$defs?.checkItYourself?.description ?? "";
  assert.match(checkDesc, /the_hash/, "check_it_yourself def names the_hash");
});

test("the offers-guide schema matches what GET /api/offers/guide actually serves", async () => {
  // Through the real door: now/now_utc come from the router's json() wrapper,
  // and the schema requires them — validating offersGuide()'s return alone
  // would miss the clock. Same idiom as the /api/rail-events schema test (#317).
  const { sqliteTestEnv } = await import("./helpers/sqlite-d1.ts");
  const { readFileSync: rf } = await import("node:fs");
  const { env } = sqliteTestEnv(rf(new URL("../schema.sql", import.meta.url), "utf8"));
  const worker = (await import("../src/index.ts")).default;
  const full = {
    ...(env as object),
    TREASURY_ADDRESS: "0x0000000000000000000000000000000000000000",
  } as never;

  const res = await worker.fetch(new Request("http://t/api/offers/guide"), full);
  assert.equal(res.status, 200, "offers/guide is a public 200");
  const served = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(
    validate(schema, served),
    [],
    "the schema must accept what GET /api/offers/guide serves today",
  );
  assert.equal(typeof served.now, "number", "clock now is present");
  assert.equal(typeof served.now_utc, "string", "clock now_utc is present");
  assert.ok(Array.isArray(served.for_sellers) && (served.for_sellers as unknown[]).length >= 1);
  assert.ok(Array.isArray(served.for_buyers) && (served.for_buyers as unknown[]).length >= 1);
  assert.ok(
    Array.isArray(served.what_an_offer_is_not) &&
      (served.what_an_offer_is_not as unknown[]).length >= 1,
  );
  const check = served.check_it_yourself as Record<string, unknown>;
  for (const k of ["who", "offers", "provenance", "the_hash"] as const) {
    assert.equal(typeof check[k], "string", `check_it_yourself.${k} is a string`);
  }
});
