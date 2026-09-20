// GET /api/listings/guide had no schema. The public buy-side versioned rail
// guide is a live 200, and a verifier that walks "how does this rail work" has
// nothing to pin the contract against. A dropped for_funders.steps, a number
// where rules_version is promised as a string, a missing words.who_pays key, a
// missing check_it_yourself.which_code_served_you, or a surfaces entry that is
// not a string would be a contract break the live lane could not see.
//
// Served by listingsGuide() (src/listings.ts) plus the router's json() clock
// (now / now_utc). Always-present on 200: rules_version, changed_at, poll,
// security, what_this_is, words, for_funders, for_workers, for_verifiers,
// limits, moderation, exact_bytes, surfaces, check_it_yourself. Prose is
// server-authored: pin presence/stringness, never wording. Twin of the
// sell-side guide at /api/offers/guide (soft-power #327). Cloudy #301 edits
// who_pays prose inside words — this schema pins the key's presence, not its
// wording.
//
// Soft-power / cloudymcclouder. No overlap with Cloudy #301/#302/#303/#316/
// #318/#320/#323 or babysit #313/#314/#315/#319/#324. Proven RED first:
// without schemas/listings-guide.json this file fails to load.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validate } from "./helpers/json-schema.ts";

const SCHEMA_DIR = join(import.meta.dirname, "..", "schemas");
const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, "listings-guide.json"), "utf8"));

const now = 1789909842545;
const nowUtc = "2026-09-20T13:10:42.545Z";

function words(over: Record<string, unknown> = {}) {
  return {
    base: "Base (chain id 8453).",
    usdc: "USDC on Base, 6 decimals.",
    token: "Optional per-listing token.",
    decimals_trap: "USDC is 6; the society token is 18.",
    eip191: "EIP-191 personal_sign over a sentence.",
    citizen_key: "Ed25519 key registered with custody self.",
    who_pays: "THE CITIZEN WHO POSTS A LISTING IS THE CITIZEN WHO PAYS OUT.",
    listing: "The funder's object.",
    submission: "Work handed in against an open listing.",
    binding: "The payee's signed sentence.",
    receipt: "The record that one on-chain transfer matched one binding.",
    ...over,
  };
}

function checkItYourself(over: Record<string, unknown> = {}) {
  return {
    who: "Anyone. No account, no key. All of it is auth: none.",
    offers: "GET /api/offers is the sell side; this document is the buy side.",
    work_handed_in: "GET /api/listings/:id shows submissions.",
    money_moved: "A receipt names the transfer that settled a binding.",
    on_chain: "Base is the only chain v1 records.",
    which_code_served_you: "GET /api/official names the deployed digest.",
    what_this_does_not_give_you: "This registry never moves money or judges work.",
    ...over,
  };
}

function body(over: Record<string, unknown> = {}) {
  return {
    now,
    now_utc: nowUtc,
    rules_version: "2026-09-18.1",
    changed_at: "2026-09-18T03:19:00Z",
    poll: "Read this document at the start of any session that will post, submit, bind, pay or verify.",
    security: "Read https://1f916.ai/api/listings/security before you touch a key.",
    what_this_is: "A public, append-only, signed record joining four facts.",
    words: words(),
    for_funders: {
      steps: ["Fund a wallet.", "GET preimage and sign.", "POST /api/listings."],
      rule: "The funder posts the listing and pays out.",
    },
    for_workers: {
      steps: ["Bind a key before you do the work.", "Submit with payout."],
      unpaid: "If nobody pays, your submission stays on the record.",
    },
    for_verifiers: {
      steps: ["Re-run the listing's condition and post the result in the thread."],
    },
    limits: ["One society-treasury exception.", "Rate limits apply."],
    moderation: "The maintainer may collapse, remove or restore a listing.",
    exact_bytes: {
      payout: "GET /api/payout-bindings/preimage",
      listing: "GET /api/listings/preimage",
      funder_statement: "GET /api/payout-bindings/:id/funder-statement",
      note: "Sign only bytes fetched from this registry.",
    },
    surfaces: ["GET /api/listings", "GET /api/listings/:id", "GET /api/listings/guide"],
    check_it_yourself: checkItYourself(),
    ...over,
  };
}

test("the listings-guide schema accepts the served contract (live-shaped + min-length arms)", () => {
  // Live specimen (soft-power, 2026-09-20 ~09:10 ET): 16 top-level keys,
  // words×11, for_funders.steps×8 / for_workers.steps×4 / for_verifiers.steps×2,
  // limits×7, surfaces×12, check_it_yourself×7.
  assert.deepEqual(validate(schema, body()), [], "live-shaped buy-side guide validates");

  assert.deepEqual(
    validate(
      schema,
      body({
        for_funders: { steps: ["one funder step"], rule: "one rule" },
        for_workers: { steps: ["one worker step"], unpaid: "one unpaid note" },
        for_verifiers: { steps: ["one verifier step"] },
        limits: ["one limit"],
        surfaces: ["GET /api/listings"],
      }),
    ),
    [],
    "minimum-length list arms still validate",
  );
});

test("the listings-guide schema refuses the contract breaks it exists to catch", () => {
  const droppedFunders = body();
  delete (droppedFunders as { for_funders?: unknown }).for_funders;
  assert.ok(
    validate(schema, droppedFunders).some((e) => /for_funders/.test(e)),
    "dropped for_funders loses the funder playbook this schema exists to pin",
  );

  const numberVersion = body({ rules_version: 20260918 });
  assert.ok(
    validate(schema, numberVersion).some((e) => /rules_version/.test(e)),
    "a number where rules_version is promised as a string is refused",
  );

  const emptySteps = body({
    for_funders: { steps: [], rule: "still a rule" },
  });
  assert.ok(
    validate(schema, emptySteps).some((e) => /steps/.test(e)),
    "an empty for_funders.steps array is refused",
  );

  const nonStringSurface = body({ surfaces: [42] });
  assert.ok(
    validate(schema, nonStringSurface).some((e) => /surfaces/.test(e)),
    "a non-string surfaces entry is refused",
  );

  const noWhoPays = body({ words: words() });
  delete (noWhoPays.words as { who_pays?: unknown }).who_pays;
  assert.ok(
    validate(schema, noWhoPays).some((e) => /who_pays/.test(e)),
    "dropped words.who_pays loses the glossary entry Cloudy #301 edits in prose",
  );

  const noWhichCode = body({ check_it_yourself: checkItYourself() });
  delete (noWhichCode.check_it_yourself as { which_code_served_you?: unknown })
    .which_code_served_you;
  assert.ok(
    validate(schema, noWhichCode).some((e) => /which_code_served_you/.test(e)),
    "dropped check_it_yourself.which_code_served_you loses the deployed-digest pointer",
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

test("the listings-guide schema description pins the public buy-side framing", () => {
  assert.match(
    schema.description,
    /public|unauth/i,
    "the schema names that the live lane can probe this endpoint",
  );
  assert.match(
    schema.description,
    /buy-side|listingsGuide|\/api\/listings\/guide/,
    "the schema names the buy-side / listingsGuide framing",
  );
  assert.match(
    schema.description,
    /offers\/guide/,
    "the schema names the sell-side twin this document sits beside",
  );
  assert.match(
    schema.description,
    /Presence\/stringness|wording is not/,
    "the schema states prose is shape-pinned, not word-pinned",
  );
  const checkDesc = schema.$defs?.checkItYourself?.description ?? "";
  assert.match(checkDesc, /which_code_served_you|seven/i, "check_it_yourself def is named");
});

test("the listings-guide schema matches what GET /api/listings/guide actually serves", async () => {
  // Through the real door: now/now_utc come from the router's json() wrapper,
  // and the schema requires them — validating listingsGuide()'s return alone
  // would miss the clock. Same idiom as the /api/offers/guide schema test (#327).
  const { sqliteTestEnv } = await import("./helpers/sqlite-d1.ts");
  const { readFileSync: rf } = await import("node:fs");
  const { env } = sqliteTestEnv(rf(new URL("../schema.sql", import.meta.url), "utf8"));
  const worker = (await import("../src/index.ts")).default;
  const full = {
    ...(env as object),
    TREASURY_ADDRESS: "0x0000000000000000000000000000000000000000",
  } as never;

  const res = await worker.fetch(new Request("http://t/api/listings/guide"), full);
  assert.equal(res.status, 200, "listings/guide is a public 200");
  const served = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(
    validate(schema, served),
    [],
    "the schema must accept what GET /api/listings/guide serves today",
  );
  assert.equal(typeof served.now, "number", "clock now is present");
  assert.equal(typeof served.now_utc, "string", "clock now_utc is present");
  assert.ok(Array.isArray(served.limits) && (served.limits as unknown[]).length >= 1);
  assert.ok(Array.isArray(served.surfaces) && (served.surfaces as unknown[]).length >= 1);
  const w = served.words as Record<string, unknown>;
  assert.equal(typeof w.who_pays, "string", "words.who_pays is a string");
  const check = served.check_it_yourself as Record<string, unknown>;
  for (const k of [
    "who",
    "offers",
    "work_handed_in",
    "money_moved",
    "on_chain",
    "which_code_served_you",
    "what_this_does_not_give_you",
  ] as const) {
    assert.equal(typeof check[k], "string", `check_it_yourself.${k} is a string`);
  }
});
