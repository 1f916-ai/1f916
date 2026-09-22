// /openapi.json declares the x402 402 that POST /api/patron serves, not only
// the 200 success.
//
// The society's machine-payable patronage (src/x402.ts) answers the first call
// -- one that carries no signed X-PAYMENT header -- with HTTP 402 Payment
// Required and the x402 challenge: `x402Version`, an `error` line, and an
// `accepts[]` array naming the scheme, the USDC asset on Base, the treasury
// `payTo`, and the amount required. That 402 challenge is THE response a
// machine-paying client acts on: it is the thing the client reads to learn how
// to build the payment, then retries with the X-PAYMENT header. Declaring only
// the 200 made a generated client type the 402 body `never`: the payment terms
// the document's own route exists to advertise were the one wire shape it
// could not read -- the same undiagnosable-success failure the 401
// (test/openapi-error-statuses.test.ts), the daily-cap 429
// (test/openapi-429-daily-cap.test.ts), the typed-absence 404
// (test/openapi-404-id-class.test.ts) and the conditional 304
// (test/openapi-304-conditional.test.ts) already fixed, on the payment-required
// side.
//
// The 402 is a single-route fact, not a set: only POST /api/patron answers
// 402 today, so the declaration is keyed to that one route rather than
// projected from a route table the way the 429/404/304 sets are.
// test/x402-patron-guards.test.ts owns the handler's guards (the challenge,
// the 400 on a bad header, the idempotency); this file pins the DECLARATION,
// which is what a generated client narrows on, against the live router.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";
const PATRON = "/api/patron";
const TREASURY = "0xa7F7985eB19b8c44F12A0654Df1eF89d1dd527C9";

test("exactly one operation declares 402: the patron write, and only it", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
  };
  let checked = 0;
  let patrons = 0;
  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const [verb, op] of Object.entries(ops)) {
      const has402 = Object.keys(op.responses).includes("402");
      const shouldBe = path === PATRON && verb === "post";
      assert.equal(
        has402,
        shouldBe,
        `${verb.toUpperCase()} ${path} is ${shouldBe ? "the patron write and" : "not the patron write and"} ${has402 ? "declares" : "does not declare"} 402`,
      );
      if (shouldBe) patrons++;
      checked++;
    }
  }
  assert.equal(patrons, 1, "POST /api/patron declares 402 exactly once");
  assert.ok(checked >= 100, `only ${checked} operations in the document; the path scan has drifted`);
});

test("the declared 402 carries the JSON challenge body, named payment-required", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, unknown>; description?: string }> }>>;
  };
  const body = doc.paths[PATRON].post.responses["402"];
  assert.ok(body, "POST /api/patron declares a 402 response");
  assert.deepEqual(Object.keys(body.content ?? {}), ["application/json"], "402 carries the JSON body, not an empty default");
  assert.match(body.description ?? "", /payment required|x402|X-PAYMENT/i, "402 description names the payment-required class");
});

test("the live router answers 402 with the x402 challenge the declaration describes", async () => {
  const { env } = sqliteTestEnv(schema);
  (env as unknown as Record<string, unknown>).TREASURY_ADDRESS = TREASURY;
  const r = await worker.fetch(
    new Request(ORIGIN + PATRON, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) }),
    env,
  );
  assert.equal(r.status, 402, "a patron request with no X-PAYMENT header is the x402 402");
  const b = (await r.json()) as {
    x402Version?: number;
    error?: string;
    accepts?: { payTo: string; asset: string; network: string; maxAmountRequired: string }[];
  };
  assert.equal(b.x402Version, 1, "the challenge names the x402 version");
  assert.equal(typeof b.error, "string", "the challenge carries an error line");
  assert.ok(Array.isArray(b.accepts) && b.accepts.length >= 1, "the challenge carries the accepts[] payment terms");
  assert.equal(b.accepts[0].payTo, TREASURY, "the challenge names the treasury the client must pay");
});

test("the live 402 carries no clock stamp, matching the declaration's body", async () => {
  // The patron route answers with Response.json directly, not the registry's
  // clocking json() wrapper, so the 402 (and the 200) carry no now/now_utc.
  // The declaration keeps the body as the plain JSON object for that reason.
  const { env } = sqliteTestEnv(schema);
  (env as unknown as Record<string, unknown>).TREASURY_ADDRESS = TREASURY;
  const r = await worker.fetch(
    new Request(ORIGIN + PATRON, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) }),
    env,
  );
  assert.equal(r.status, 402);
  const b = (await r.json()) as Record<string, unknown>;
  assert.ok(!("now" in b) && !("now_utc" in b), "the 402 body is not clock-stamped");
});
