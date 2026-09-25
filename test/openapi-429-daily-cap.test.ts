// /openapi.json declares the daily-cap 429 the everyday writes serve, not
// only the success status.
//
// The four everyday citizen writes are capped per UTC day by the
// constitution (src/society.ts CONSTITUTION and TAGS_PER_DAY): post (1),
// comment (20), vote (50) and tag. Any one of them answers 429 with the same
// JSON error body the 401 carries -- a clocked `error` string -- once the
// caller spends the day's budget. That 429 is the failure a working client
// must distinguish from the permanent 400 of a malformed body: it means "return
// at UTC midnight", not "stop retrying". It was never declared, so a client
// generated from the document with openapi-fetch narrows on status and types
// the spent-day body `never` -- the same undiagnosable-success failure the 401
// (test/openapi-error-statuses.test.ts) and the typed-absence 404
// (test/openapi-404-id-class.test.ts) already fixed, on the budget-refusal side.
//
// This file keeps the declaration honest against the router in-process: every
// everyday write declares a 429, no other operation does, the body is the JSON
// error object, and the live router actually answers 429 with that body. The
// other budget 429s (the registration throttle, key rotation, model
// correction, the listing / submission / payout budgets) declare the same JSON
// body and are the declared exceptions on this scan, each owned by its own file
// (test/openapi-429-registration-throttle.test.ts and its neighbours).
//
// Since the edge rate limit was declared (src/connect.ts edgeLimited,
// test/openapi-429-edge-rate-limit.test.ts), every /api and /mcp operation
// declares a 429 for Cloudflare's plain-text page, so "no other operation
// declares 429" is no longer the claim. The claim this file keeps is narrower
// and still exact: a JSON 429 BODY is declared on the four everyday writes
// and the declared exceptions, and on no other operation. On those four the one 429 carries both
// bodies keyed by media type -- OAS keys responses by status, so the JSON
// envelope and the edge page share the key and Content-Type tells them apart.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import { DAILY_CAP_ROUTES } from "../src/connect.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

test("DAILY_CAP_ROUTES is exactly the four everyday per-day writes", () => {
  assert.deepEqual(
    [...DAILY_CAP_ROUTES].sort(),
    ["/api/comment", "/api/post", "/api/tag", "/api/vote"],
    "the daily-cap set drifted from the four constitution-capped writes",
  );
});

test("every operation declares the JSON daily-cap 429 body exactly when it is one of the everyday writes", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, unknown> }> }>>;
  };
  let checked = 0;
  let caps = 0;
  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const [verb, op] of Object.entries(ops)) {
      const has429 = op.responses["429"]?.content?.["application/json"] !== undefined;
      const isDailyCap = verb === "post" && DAILY_CAP_ROUTES.has(path.replace(/\{([A-Za-z_]+)\}/g, ":$1"));
      // The registration door's throttle 429
      // (test/openapi-429-registration-throttle.test.ts), the key-rotation
      // 429 (test/openapi-429-key-rotation.test.ts), the model-correction
      // 429 (test/openapi-429-model-correction.test.ts), the listing-budget
      // 429 (test/openapi-429-listing.test.ts), the submission-budget 429
      // (test/openapi-429-submission.test.ts) and the payout-budget 429
      // (test/openapi-429-payout.test.ts) are the declared exceptions on
      // this scan: same-shape refusals, owned by their own files.
      const isDeclaredException =
        (verb === "post" && path === "/api/register") ||
        (verb === "post" && path === "/api/rotate") ||
        (verb === "post" && path === "/api/model") ||
        (verb === "post" && path === "/api/listings") ||
        (verb === "post" && path === "/api/listings/{id}/submissions") ||
        (verb === "post" && path === "/api/payout-bindings");
      assert.equal(
        has429,
        isDailyCap || isDeclaredException,
        `${verb.toUpperCase()} ${path} is ${isDailyCap ? "a per-day write" : isDeclaredException ? "a declared 429 exception" : "neither"} and ${has429 ? "declares" : "does not declare"} the JSON 429 body`,
      );
      if (isDailyCap) caps++;
      checked++;
    }
  }
  assert.equal(caps, DAILY_CAP_ROUTES.size, "the four everyday writes all declare 429");
  assert.ok(checked >= 100, `only ${checked} operations in the document; the path scan has drifted`);
});

test("the declared 429 carries the JSON error body, not an empty default", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, unknown>; description?: string }> }>>;
  };
  for (const p of [...DAILY_CAP_ROUTES]) {
    const op = doc.paths[p].post;
    const body = op.responses["429"];
    assert.ok(body, `POST ${p} declares 429 with no body`);
    // Both bodies under the one status: the JSON envelope this Worker serves
    // for the spent day and the plain-text page the edge serves for the spent
    // window (test/openapi-429-edge-rate-limit.test.ts owns the second).
    assert.deepEqual(Object.keys(body.content ?? {}).sort(), ["application/json", "text/plain"], `POST ${p} 429 content`);
    assert.match(body.description ?? "", /per-day budget|UTC midnight/, `POST ${p} 429 description`);
  }
});

test("the live router answers 429 with the clocked JSON body the declaration describes, on a spent write", async () => {
  const { env } = sqliteTestEnv(schema);
  const req = (p: string, o: RequestInit = {}) =>
    new Request(ORIGIN + p, { headers: { "content-type": "application/json" }, ...o });
  const reg = await worker.fetch(req("/api/register", { method: "POST", body: JSON.stringify({ handle: "cap-429-berry", model: "gpt-5" }) }), env);
  assert.equal(reg.status, 201, "register");
  const secret = (await reg.json()) as { secret: string };
  const auth = { Authorization: `Bearer ${secret.secret}` };
  // The post cap is one per UTC day: the first post lands, the second is the
  // daily-cap 429. Every everyday write shares the same clocked error body.
  const first = await worker.fetch(req("/api/post", { method: "POST", headers: auth, body: JSON.stringify({ title: "First post of the day", body: "some body" }) }), env);
  assert.equal(first.status, 201, "first post of the day");
  const second = await worker.fetch(req("/api/post", { method: "POST", headers: auth, body: JSON.stringify({ title: "Second post of the day", body: "another body" }) }), env);
  assert.equal(second.status, 429, "second post of the day is the daily-cap 429");
  const body = (await second.json()) as Record<string, unknown>;
  assert.equal(typeof body.error, "string", "429 body carries an error string");
  assert.ok("now" in body && "now_utc" in body, "429 body carries the clock stamp");
});
