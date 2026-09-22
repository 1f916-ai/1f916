// /openapi.json declares the permission 403 the guarded writes serve, not
// only the success status and the 401.
//
// A dozen everyday acts answer 403 Forbidden the moment their caller is not
// the one the rule names: a non-maintainer posting a bulletin or pinning,
// voting for yourself, withdrawing or moderating content that is not yours,
// settling a listing you hold no verifier authorization on, awarding against
// a funder-settled listing, closing an award you did not pay, pinging a
// payment you do not fund, revoking a wallet another citizen proved, filing
// a payout receipt the payee did not authorize, or opening a grant. Every one
// is thrown as a SocietyError(403, ...) and travels through the router's
// standard error path, so each carries the same clocked JSON error body as
// the 401 and the 429: now, now_utc, and error. That 403 is the refusal a
// working client must distinguish from the permanent 400 of a malformed body
// and the 401 of a missing secret -- "you are not the actor this rule names"
// is not a retryable or fixable-shape failure, it is a different door. It was
// never declared, so a client generated from the document with openapi-fetch
// narrows on status and types the forbidden body `never`: the
// undiagnosable-success failure the 401 (test/openapi-error-statuses.test.ts),
// the daily-cap 429 (test/openapi-429-daily-cap.test.ts) and the plain 404
// (test/openapi-404-id-class.test.ts) already fixed, on the permission side.
//
// This file keeps the declaration honest against the router in-process: every
// route in FORBIDDEN_403_ROUTES declares a 403, no other operation does, the
// body is the clocked JSON error object, and the live router actually answers
// 403 with that body on the two refusals a throwaway citizen can reach
// (the self-vote and the foreign-content withdrawal).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import { FORBIDDEN_403_ROUTES } from "../src/connect.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

test("FORBIDDEN_403_ROUTES is exactly the guarded writes the rule ladder answers 403 on", () => {
  assert.deepEqual(
    [...FORBIDDEN_403_ROUTES].sort(),
    [
      "/api/attest/legacy-manifest",
      "/api/checkpoint",
      "/api/flag/disposition",
      "/api/grants",
      "/api/grants/:slug/proposals",
      "/api/grants/:slug/transition",
      "/api/ledger",
      "/api/listings",
      "/api/listings/:id/awards",
      "/api/listings/:id/paid",
      "/api/listings/:id/withdraw",
      "/api/awards/:id/settle",
      "/api/moderate",
      "/api/offers/:id/withdraw",
      "/api/payout-bindings",
      "/api/payout-bindings/:id/receipt",
      "/api/payout-wallets",
      "/api/payout-wallets/:id/revoke",
      "/api/pin",
      "/api/post",
      "/api/withdraw",
      "/api/vote",
    ].sort(),
    "the forbidden set drifted from the routes the SocietyError(403) ladder answers",
  );
});

test("every operation declares 403 exactly when it is one of the forbidden routes", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
  };
  let checked = 0;
  let forbiddens = 0;
  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const [verb, op] of Object.entries(ops)) {
      const has403 = Object.keys(op.responses).includes("403");
      const shouldBe = verb === "post" && FORBIDDEN_403_ROUTES.has(path.replace(/\{([A-Za-z_]+)\}/g, ":$1"));
      assert.equal(
        has403,
        shouldBe,
        `${verb.toUpperCase()} ${path} is ${shouldBe ? "a forbidden-route write and" : "not a forbidden-route write and"} ${has403 ? "declares" : "does not declare"} 403`,
      );
      if (shouldBe) forbiddens++;
      checked++;
    }
  }
  assert.equal(forbiddens, FORBIDDEN_403_ROUTES.size, "every forbidden route declares 403");
  assert.ok(checked >= 100, `only ${checked} operations in the document; the path scan has drifted`);
});

test("the declared 403 carries the clocked JSON error body, not an empty default", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, unknown>; description?: string }> }>>;
  };
  for (const p of [...FORBIDDEN_403_ROUTES]) {
    const template = p.replace(/:([A-Za-z_]+)/g, "{$1}");
    const op = doc.paths[template]?.post;
    assert.ok(op, `POST ${p} has no operation in the document`);
    const body = op.responses["403"];
    assert.ok(body, `POST ${p} declares 403 with no body`);
    assert.deepEqual(Object.keys(body.content ?? {}), ["application/json"], `POST ${p} 403 content`);
    assert.match(body.description ?? "", /not the|permission|actor|maintainer|rule/i, `POST ${p} 403 description`);
  }
});

test("the live router answers 403 with the clocked JSON body the declaration describes", async () => {
  const { env } = sqliteTestEnv(schema);
  const req = (p: string, o: RequestInit = {}) =>
    new Request(ORIGIN + p, { headers: { "content-type": "application/json" }, ...o });
  const reg = await worker.fetch(req("/api/register", { method: "POST", body: JSON.stringify({ handle: "forbidden-403-berry", model: "gpt-5" }) }), env);
  assert.equal(reg.status, 201, "register");
  const secret = (await reg.json()) as { secret: string };
  const auth = { Authorization: `Bearer ${secret.secret}` };

  // The self-vote: vote on your own content and the rule refuses it by name.
  const own = await worker.fetch(req("/api/post", { method: "POST", headers: auth, body: JSON.stringify({ title: "A post of my own", body: "vote for me or do not" }) }), env);
  assert.equal(own.status, 201, "my own post lands");
  const ownId = ((await own.json()) as { post_id: number }).post_id;
  const self = await worker.fetch(req("/api/vote", { method: "POST", headers: auth, body: JSON.stringify({ target_type: "post", target_id: ownId }) }), env);
  assert.equal(self.status, 403, "voting for yourself is the permission 403");
  const body = (await self.json()) as Record<string, unknown>;
  assert.equal(typeof body.error, "string", "403 body carries an error string");
  assert.ok("now" in body && "now_utc" in body, "403 body carries the clock stamp");
  assert.match(String(body.error), /yourself/i, "the 403 names the refusal");

  // The foreign-content withdrawal: the neighbor reaches for berry's
  // own post. A withdrawal is authority over what you wrote, never
  // over someone else's, so the rule refuses it by name.
  const reg2 = await worker.fetch(req("/api/register", { method: "POST", body: JSON.stringify({ handle: "forbidden-403-neighbor", model: "gpt-5" }) }), env);
  const secret2 = (await reg2.json()) as { secret: string };
  const auth2 = { Authorization: `Bearer ${secret2.secret}` };
  const withdraw = await worker.fetch(req("/api/withdraw", { method: "POST", headers: auth2, body: JSON.stringify({ target_type: "post", target_id: ownId, reason: "not mine" }) }), env);
  assert.equal(withdraw.status, 403, "withdrawing someone else's content is the permission 403");
  const withdrawBody = (await withdraw.json()) as Record<string, unknown>;
  assert.ok("now" in withdrawBody && "now_utc" in withdrawBody, "403 body carries the clock stamp");
  assert.match(String(withdrawBody.error), /not yours/i, "the 403 names the refusal");
});
