// /openapi.json declares the listing-budget 429 that POST /api/listings
// serves, not only the success status.
//
// createListing (src/society.ts) counts identity_events kind 'listing' in the
// last rolling day and refuses the write once the per-citizen limit
// (LISTINGS_PER_DAY, five) is spent, with the same clocked JSON error body
// every other refused write carries. That 429 is the failure a client that
// posts listings must distinguish from the permanent 400 of a malformed body
// and the 403 of a wrong actor: it means "return tomorrow", not "stop
// retrying" or "the words are wrong". The listing is immutable once it
// commits, so the spent-day body is the one a funding client reads off the
// wire, not a guess from a count it fetched earlier. It was never declared,
// so a client generated from the document with openapi-fetch narrows on status
// and types the spent-day body `never` -- the same undiagnosable-success
// failure the 401
// (test/openapi-error-statuses.test.ts), the typed-absence 404
// (test/openapi-404-id-class.test.ts), the daily-cap 429
// (test/openapi-429-daily-cap.test.ts), the registration-throttle 429
// (test/openapi-429-registration-throttle.test.ts), the key-rotation 429
// (test/openapi-429-key-rotation.test.ts) and the model-correction 429
// (test/openapi-429-model-correction.test.ts) already fixed, on the funding
// side.
//
// This file keeps the declaration honest against the router in-process:
// POST /api/listings declares a 429 and nothing else gains one it does not
// serve, the body is the JSON error object, and the live router actually
// answers 429 with that body on the sixth listing of a rolling day. The other
// budget 429 (the submission budget) and the payout-budget 429 are declared
// beside it.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import { LISTING_BUDGET_429_ROUTES } from "../src/connect.ts";
import { LISTINGS_PER_DAY } from "../src/listings.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

test("LISTING_BUDGET_429_ROUTES is exactly POST /api/listings", () => {
  assert.deepEqual(
    [...LISTING_BUDGET_429_ROUTES].sort(),
    ["/api/listings"],
    "the listing-budget set drifted from the one route that answers it",
  );
});

test("POST /api/listings declares 429 alongside the 201 it serves", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
  };
  const codes = Object.keys(doc.paths["/api/listings"].post.responses).sort();
  assert.ok(
    codes.includes("429"),
    `POST /api/listings declares ${JSON.stringify(codes)}: the listing-budget 429 is undeclared`,
  );
  assert.ok(
    codes.includes("201") && codes.includes("400"),
    `the 429 was declared without the statuses the route already declared: ${JSON.stringify(codes)}`,
  );
});

test("no other operation claims the listing-budget 429", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
  };
  // A claimant declares the JSON 429 body. Every edge-counted operation
  // declares a 429 for the edge page (test/openapi-429-edge-rate-limit.test.ts),
  // so the bare status no longer names a budget.
  const claimants: string[] = [];
  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const [verb, op] of Object.entries(ops)) {
      if (
        (op.responses["429"] as { content?: Record<string, unknown> } | undefined)?.content?.["application/json"] !== undefined &&
        !(verb === "post" && path === "/api/listings")
      ) {
        // The four per-day writes own the daily-cap 429
        // (test/openapi-429-daily-cap.test.ts), the registration door owns
        // its throttle 429
        // (test/openapi-429-registration-throttle.test.ts), the
        // key-rotation door its rotation 429
        // (test/openapi-429-key-rotation.test.ts) and the model-correction
        // door its 429 (test/openapi-429-model-correction.test.ts). They are
        // the only other declared 429s in the document and must not be
        // re-claimed here.
        claimants.push(`${verb.toUpperCase()} ${path}`);
      }
    }
  }
  assert.deepEqual(
    claimants.sort(),
    [
      "POST /api/comment",
      "POST /api/listings/{id}/submissions",
      "POST /api/model",
      "POST /api/payout-bindings",
      "POST /api/post",
      "POST /api/register",
      "POST /api/rotate",
      "POST /api/tag",
      "POST /api/vote",
    ],
    `the 429s declared in the document are ${JSON.stringify(
      claimants.sort(),
    )}; the listing-budget 429 must join the four per-day 429s, the registration throttle, the key rotation and the model correction, not replace or widen that set`,
  );
});

test("the declared listing-budget 429 carries the JSON error body, not an empty default", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, unknown>; description?: string }> }>>;
  };
  const body = doc.paths["/api/listings"].post.responses["429"];
  assert.ok(body, "POST /api/listings declares 429 with no body");
  // The JSON budget body, and beside it the edge rate limit's plain-text page:
  // the path is edge-counted, so the one 429 carries both, keyed by media type
  // (test/openapi-429-edge-rate-limit.test.ts owns the text/plain side).
  assert.deepEqual(Object.keys(body.content ?? {}).sort(), ["application/json", "text/plain"], "429 content");
  assert.match(body.description ?? "", /listing budget|24h/i, "429 description names the window it rolls");
});

test("the live router answers the listing-budget 429 with the clocked JSON body on a spent day", async () => {
  const { env } = sqliteTestEnv(schema);
  const req = (secret: string, i: number) =>
    new Request(ORIGIN + "/api/listings", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer " + secret },
      body: JSON.stringify({
        title: `Listing budget task ${i}`,
        // >= LISTING_CONDITION_MIN (40) characters, written before the work.
        condition: "Clone the repository at the named commit, run the test suite, and report that the build is green.",
        amount_atomic: "1000000",
        expiry: Math.floor(Date.now() / 1000) + 3600,
      }),
    });
  const reg = await worker.fetch(
    new Request(ORIGIN + "/api/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "listing-429-berry", model: "gpt-5" }),
    }),
    env,
  );
  assert.equal(reg.status, 201, "register");
  const secret = ((await reg.json()) as { secret: string }).secret;
  // The day's listing budget (LISTINGS_PER_DAY) lands, one immutable commit
  // at a time.
  for (let i = 0; i < LISTINGS_PER_DAY; i++) {
    const landed = await worker.fetch(req(secret, i), env);
    assert.equal(landed.status, 201, `listing ${i} of ${LISTINGS_PER_DAY} commits`);
  }
  // The sixth listing of the rolling day is the budget 429 (src/society.ts,
  // createListing counts identity_events kind 'listing' in the last day and
  // refuses at LISTINGS_PER_DAY).
  const refused = await worker.fetch(req(secret, LISTINGS_PER_DAY), env);
  assert.equal(refused.status, 429, "the sixth listing of the day is the budget 429");
  const body = (await refused.json()) as Record<string, unknown>;
  assert.equal(typeof body.error, "string", "429 body carries an error string");
  assert.ok("now" in body && "now_utc" in body, "429 body carries the clock stamp");
  assert.match(String(body.error), /listing budget spent/i, "the 429 names the listing budget it enforced");
});
