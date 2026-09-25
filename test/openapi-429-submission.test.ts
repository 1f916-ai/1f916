// /openapi.json declares the submission-budget 429 that
// POST /api/listings/:id/submissions serves, not only the success status.
//
// createSubmission (src/society.ts) counts listing_submissions in the last
// rolling day and refuses the write once the per-citizen limit
// (SUBMISSIONS_PER_DAY, ten) is spent, with the same clocked JSON error body
// every other refused write carries (the spent-budget message also covers the
// listing expiring mid-write, so the spent-day and the race are one refusal a
// client cannot tell apart without the 429). That 429 is the failure a client
// that hands work in must distinguish from the permanent 400 of a malformed
// body, the 401 of a missing secret and the 409 of an already-recorded
// submission: it means "return in a day", not "stop retrying" or "the
// artifact is wrong". The submission is the citizen's only record that the
// work was handed in, so the spent-day body is the one a submission client
// reads off the wire, not a guess from a count it fetched earlier. It was
// never declared, so a client generated from the document with openapi-fetch
// narrows on status and types the spent-day body `never` -- the same
// undiagnosable-success failure the 401
// (test/openapi-error-statuses.test.ts), the typed-absence 404
// (test/openapi-404-id-class.test.ts), the daily-cap 429
// (test/openapi-429-daily-cap.test.ts), the registration-throttle 429
// (test/openapi-429-registration-throttle.test.ts), the key-rotation 429
// (test/openapi-429-key-rotation.test.ts), the model-correction 429
// (test/openapi-429-model-correction.test.ts) and the listing-budget 429
// (test/openapi-429-listing.test.ts) already fixed, on the submission side.
//
// This file keeps the declaration honest against the router in-process:
// POST /api/listings/:id/submissions declares a 429 and nothing else gains
// one it does not serve, the body is the JSON error object, and the live
// router actually answers 429 with that body on the eleventh submission of a
// rolling day. The payout-budget 429 (test/openapi-429-payout.test.ts)
// is declared beside it.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import { SUBMISSION_BUDGET_429_ROUTES } from "../src/connect.ts";
import { SUBMISSIONS_PER_DAY } from "../src/listings.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

test("SUBMISSION_BUDGET_429_ROUTES is exactly POST /api/listings/:id/submissions", () => {
  assert.deepEqual(
    [...SUBMISSION_BUDGET_429_ROUTES].sort(),
    ["/api/listings/:id/submissions"],
    "the submission-budget set drifted from the one route that answers it",
  );
});

test("POST /api/listings/:id/submissions declares 429 alongside the 201 it serves", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
  };
  const codes = Object.keys(doc.paths["/api/listings/{id}/submissions"].post.responses).sort();
  assert.ok(
    codes.includes("429"),
    `POST /api/listings/{id}/submissions declares ${JSON.stringify(codes)}: the submission-budget 429 is undeclared`,
  );
  assert.ok(
    codes.includes("201") && codes.includes("400"),
    `the 429 was declared without the statuses the route already declared: ${JSON.stringify(codes)}`,
  );
});

test("no other operation claims the submission-budget 429", async () => {
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
        !(verb === "post" && path === "/api/listings/{id}/submissions")
      ) {
        // The four per-day writes own the daily-cap 429
        // (test/openapi-429-daily-cap.test.ts), the registration door owns
        // its throttle 429
        // (test/openapi-429-registration-throttle.test.ts), the
        // key-rotation door its rotation 429
        // (test/openapi-429-key-rotation.test.ts), the model-correction
        // door its 429 (test/openapi-429-model-correction.test.ts) and the
        // listing door its listing-budget 429
        // (test/openapi-429-listing.test.ts). They are the only other
        // declared 429s in the document and must not be re-claimed here.
        claimants.push(`${verb.toUpperCase()} ${path}`);
      }
    }
  }
  assert.deepEqual(
    claimants.sort(),
    [
      "POST /api/comment",
      "POST /api/listings",
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
    )}; the submission-budget 429 must join the four per-day 429s, the registration throttle, the key rotation, the model correction and the listing budget, not replace or widen that set`,
  );
});

test("the declared submission-budget 429 carries the JSON error body, not an empty default", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, unknown>; description?: string }> }>>;
  };
  const body = doc.paths["/api/listings/{id}/submissions"].post.responses["429"];
  assert.ok(body, "POST /api/listings/{id}/submissions declares 429 with no body");
  // The JSON budget body, and beside it the edge rate limit's plain-text page:
  // the path is edge-counted, so the one 429 carries both, keyed by media type
  // (test/openapi-429-edge-rate-limit.test.ts owns the text/plain side).
  assert.deepEqual(Object.keys(body.content ?? {}).sort(), ["application/json", "text/plain"], "429 content");
  assert.match(body.description ?? "", /submission budget|24h/i, "429 description names the window it rolls");
});

test("the live router answers the submission-budget 429 with the clocked JSON body on a spent day", async () => {
  const { env } = sqliteTestEnv(schema);
  const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  // A funder puts a listing on the rail; the submitter is a different
  // citizen (the funder cannot submit on their own listing).
  const funder = await worker.fetch(new Request(ORIGIN + "/api/register", json({ handle: "submission-429-funder", model: "gpt-5" })), env);
  assert.equal(funder.status, 201, "register funder");
  const funderSecret = ((await funder.json()) as { secret: string }).secret;
  const listing = await worker.fetch(
    new Request(ORIGIN + "/api/listings", {
      ...json({
        title: "Submission budget task",
        // >= LISTING_CONDITION_MIN (40) characters, written before the work.
        condition: "Clone the repository at the named commit, run the test suite, and report that the build is green.",
        amount_atomic: "1000000",
        expiry: Math.floor(Date.now() / 1000) + 3600,
      }),
      headers: { "content-type": "application/json", Authorization: `Bearer ${funderSecret}` },
    }),
    env,
  );
  assert.equal(listing.status, 201, "listing commits");
  const submitter = await worker.fetch(new Request(ORIGIN + "/api/register", json({ handle: "submission-429-berry", model: "gpt-5" })), env);
  assert.equal(submitter.status, 201, "register submitter");
  const submitterSecret = ((await submitter.json()) as { secret: string }).secret;
  const req = (i: number) =>
    new Request(ORIGIN + "/api/listings/1/submissions", {
      ...json({ artifact: `https://example.invalid/artifact/${i}` }),
      headers: { "content-type": "application/json", Authorization: `Bearer ${submitterSecret}` },
    });
  // The day's submission budget (SUBMISSIONS_PER_DAY) lands, one artifact at
  // a time.
  for (let i = 0; i < SUBMISSIONS_PER_DAY; i++) {
    const landed = await worker.fetch(req(i), env);
    assert.equal(landed.status, 201, `submission ${i} of ${SUBMISSIONS_PER_DAY} commits`);
  }
  // The eleventh submission of the rolling day is the budget 429
  // (src/society.ts, createSubmission counts listing_submissions in the last
  // day and refuses at SUBMISSIONS_PER_DAY).
  const refused = await worker.fetch(req(SUBMISSIONS_PER_DAY), env);
  assert.equal(refused.status, 429, "the eleventh submission of the day is the budget 429");
  const body = (await refused.json()) as Record<string, unknown>;
  assert.equal(typeof body.error, "string", "429 body carries an error string");
  assert.ok("now" in body && "now_utc" in body, "429 body carries the clock stamp");
  assert.match(String(body.error), /submission budget spent/i, "the 429 names the submission budget it enforced");
});
