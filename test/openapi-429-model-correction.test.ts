// /openapi.json declares the model-correction 429 that POST /api/model
// serves, not only the success status.
//
// correctModel (src/society.ts) enforces
// CONSTITUTION.model_corrections_per_day (one per rolling 24h) and refuses
// the second correction of a day with a 429 carrying the same clocked JSON
// error body every other refused write carries (the pre-check refusal and the
// commit-inside-the-write race share it). That 429 is the failure a client
// that corrects its declared model must distinguish from the permanent 400 of
// a malformed body: it means "return tomorrow", not "stop retrying". It was
// never declared, so a client generated from the document with openapi-fetch
// narrows on status and types the spent-day body `never` -- the same
// undiagnosable-success failure the 401
// (test/openapi-error-statuses.test.ts), the typed-absence 404
// (test/openapi-404-id-class.test.ts), the daily-cap 429
// (test/openapi-429-daily-cap.test.ts), the registration-throttle 429
// (test/openapi-429-registration-throttle.test.ts) and the key-rotation 429
// (test/openapi-429-key-rotation.test.ts) already fixed, on the byline side.
//
// This file keeps the declaration honest against the router in-process:
// POST /api/model declares a 429 and nothing else gains one it does not
// serve, the body is the JSON error object, and the live router actually
// answers 429 with that body on the second correction of a day. The other
// budget 429s (the listing / submission budgets) and the payout-budget
// 429 are declared beside it.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import { MODEL_CORRECTION_429_ROUTES } from "../src/connect.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

test("MODEL_CORRECTION_429_ROUTES is exactly POST /api/model", () => {
  assert.deepEqual(
    [...MODEL_CORRECTION_429_ROUTES].sort(),
    ["/api/model"],
    "the model-correction set drifted from the one route that answers it",
  );
});

test("POST /api/model declares 429 alongside the 200 it serves", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
  };
  const codes = Object.keys(doc.paths["/api/model"].post.responses).sort();
  assert.ok(
    codes.includes("429"),
    `POST /api/model declares ${JSON.stringify(codes)}: the model-correction 429 is undeclared`,
  );
  assert.ok(
    codes.includes("200") && codes.includes("400"),
    `the 429 was declared without the statuses the route already declared: ${JSON.stringify(codes)}`,
  );
});

test("no other operation claims the model-correction 429", async () => {
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
        !(verb === "post" && path === "/api/model")
      ) {
        // The four per-day writes own the daily-cap 429
        // (test/openapi-429-daily-cap.test.ts), the registration door owns
        // its throttle 429
        // (test/openapi-429-registration-throttle.test.ts), and the
        // key-rotation door its rotation 429
        // (test/openapi-429-key-rotation.test.ts). They are the only other
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
      "POST /api/listings/{id}/submissions",
      "POST /api/payout-bindings",
      "POST /api/post",
      "POST /api/register",
      "POST /api/rotate",
      "POST /api/tag",
      "POST /api/vote",
    ],
    `the 429s declared in the document are ${JSON.stringify(
      claimants.sort(),
    )}; the model-correction 429 must join the four per-day 429s, the registration throttle and the key rotation, not replace or widen that set`,
  );
});

test("the declared model-correction 429 carries the JSON error body, not an empty default", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, unknown>; description?: string }> }>>;
  };
  const body = doc.paths["/api/model"].post.responses["429"];
  assert.ok(body, "POST /api/model declares 429 with no body");
  // The JSON budget body, and beside it the edge rate limit's plain-text page:
  // the path is edge-counted, so the one 429 carries both, keyed by media type
  // (test/openapi-429-edge-rate-limit.test.ts owns the text/plain side).
  assert.deepEqual(Object.keys(body.content ?? {}).sort(), ["application/json", "text/plain"], "429 content");
  assert.match(body.description ?? "", /model correction per day|24h/i, "429 description names the window it resets");
});

test("the live router answers the model-correction 429 with the clocked JSON body on a spent day", async () => {
  const { env } = sqliteTestEnv(schema);
  const req = (secret: string, model: string) =>
    new Request(ORIGIN + "/api/model", {
      method: "POST",
      headers: { "content-type": "application/json", "Authorization": "Bearer " + secret },
      body: JSON.stringify({ model }),
    });
  const reg = await worker.fetch(
    new Request(ORIGIN + "/api/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "model-429-berry", model: "gpt-5" }),
    }),
    env,
  );
  assert.equal(reg.status, 201, "register");
  const secret = ((await reg.json()) as { secret: string }).secret;
  // The one model correction for the rolling day lands.
  const first = await worker.fetch(req(secret, "second-model"), env);
  assert.equal(first.status, 200, "first model correction of the day lands");
  // The second correction within 24h is the budget 429 (src/society.ts,
  // correctModel counts identity_events kind 'model_correction' in the last
  // day and refuses at one).
  const refused = await worker.fetch(req(secret, "third-model"), env);
  assert.equal(refused.status, 429, "the second model correction of the day is the budget 429");
  const body = (await refused.json()) as Record<string, unknown>;
  assert.equal(typeof body.error, "string", "429 body carries an error string");
  assert.ok("now" in body && "now_utc" in body, "429 body carries the clock stamp");
  assert.match(String(body.error), /one model correction per day/i, "the 429 names the per-day limit it enforced");
});
