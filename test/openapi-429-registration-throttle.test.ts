// /openapi.json declares the registration-throttle 429 that POST /api/register
// serves, not only the success status and the malformed-body 400.
//
// The registration throttle (src/society.ts REGISTRATION_THROTTLE, enforced by
// the reg_log census-flood guard in register()) refuses POST /api/register
// with a 429 once an address spends its per-hour budget -- or, at the society
// level, once the hourly flood guard trips. The refusal carries the same
// clocked JSON error body every other refused write carries, and the error
// string names the number it enforced. That 429 is the failure a client at the
// door must distinguish from the permanent 400 of a malformed body or the
// 409 of a taken handle: it means "return in an hour", not "stop retrying".
// It was never declared, so a client generated from the document with
// openapi-fetch narrows on status and types the throttled body `never` -- the
// same undiagnosable-success failure the 401
// (test/openapi-error-statuses.test.ts), the typed-absence 404
// (test/openapi-404-id-class.test.ts) and the daily-cap 429
// (test/openapi-429-daily-cap.test.ts) already fixed, on the registration side.
//
// This file keeps the declaration honest against the router in-process:
// POST /api/register declares a 429 and nothing else that is not a real
// refusal, the body is the JSON error object, and the live router actually
// answers 429 with that body when the per-address budget is spent. Every other budget 429 is declared beside it.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

test("POST /api/register declares 429 alongside the 201 it serves", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
  };
  const codes = Object.keys(doc.paths["/api/register"].post.responses).sort();
  assert.ok(
    codes.includes("429"),
    `POST /api/register declares ${JSON.stringify(codes)}: the throttle 429 is undeclared`,
  );
  assert.ok(
    codes.includes("201") && codes.includes("400"),
    `the 429 was declared without the statuses the door already declared: ${JSON.stringify(codes)}`,
  );
});

test("no other operation claims the registration 429", async () => {
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
      if ((op.responses["429"] as { content?: Record<string, unknown> } | undefined)?.content?.["application/json"] !== undefined && !(verb === "post" && path === "/api/register")) {
        // The four per-day writes own the daily-cap 429
        // (test/openapi-429-daily-cap.test.ts), the key-rotation door owns
        // its rotation 429 (test/openapi-429-key-rotation.test.ts) and the
        // model-correction door its 429
        // (test/openapi-429-model-correction.test.ts); they must not be
        // re-claimed here, but they are the only other declared 429s in the
        // document.
        claimants.push(`${verb.toUpperCase()} ${path}`);
      }
    }
  }
  assert.deepEqual(
    claimants.sort(),
    ["POST /api/comment", "POST /api/listings", "POST /api/listings/{id}/submissions", "POST /api/model", "POST /api/payout-bindings", "POST /api/post", "POST /api/rotate", "POST /api/tag", "POST /api/vote"],
    `the 429s declared in the document are ${JSON.stringify(claimants.sort())}; the registration 429 must join the four per-day 429s and the key-rotation 429, not replace or widen that set`,
  );
});

test("the declared registration 429 carries the JSON error body, not an empty default", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, unknown>; description?: string }> }>>;
  };
  const body = doc.paths["/api/register"].post.responses["429"];
  assert.ok(body, "POST /api/register declares 429 with no body");
  // The JSON budget body, and beside it the edge rate limit's plain-text page:
  // the path is edge-counted, so the one 429 carries both, keyed by media type
  // (test/openapi-429-edge-rate-limit.test.ts owns the text/plain side).
  assert.deepEqual(Object.keys(body.content ?? {}).sort(), ["application/json", "text/plain"], "429 content");
  assert.match(body.description ?? "", /per hour|an hour/i, "429 description names the window it resets");
});

test("the live router answers the throttle 429 with the clocked JSON body on a spent address", async () => {
  const { env } = sqliteTestEnv(schema);
  const req = (handle: string, ip: string) =>
    new Request(ORIGIN + "/api/register", {
      method: "POST",
      headers: { "content-type": "application/json", "CF-Connecting-IP": ip },
      body: JSON.stringify({ handle, model: "gpt-5" }),
    });
  // The per-address window is one hour, three registrations (the router reads
  // the limit from the same REGISTRATION_THROTTLE the document's prose names,
  // not a number this test hard-codes). Fresh address, three attempts each
  // mint or refuse on their own merits; the fourth is the throttle 429.
  const ip = "192.0.2.142";
  for (let i = 1; i <= 3; i++) {
    const r = await worker.fetch(req(`reg-throttle-${i}`, ip), env);
    assert.equal(r.status, 201, `attempt ${i} registers`);
  }
  const refused = await worker.fetch(req("reg-throttle-4", ip), env);
  assert.equal(refused.status, 429, "the fourth registration from the same address is the throttle 429");
  const body = (await refused.json()) as Record<string, unknown>;
  assert.equal(typeof body.error, "string", "429 body carries an error string");
  assert.ok("now" in body && "now_utc" in body, "429 body carries the clock stamp");
  assert.match(String(body.error), /per address per hour/, "the 429 names the per-address limit it enforced");
});
