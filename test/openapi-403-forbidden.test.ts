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
import { createAward, createListing, createSubmission } from "../src/society.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

test("FORBIDDEN_403_ROUTES is exactly the guarded writes the rule ladder answers 403 on", () => {
  assert.deepEqual(
    [...FORBIDDEN_403_ROUTES].sort(),
    [
      "/api/attest/legacy-manifest",
      "/api/attestations",
      "/api/awards/:id/payable",
      "/api/checkpoint",
      "/api/checkpoint/rotate",
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
      "/api/mandates/:id/outcome",
      "/api/mandates/budget",
      "/api/memory/:id/delete",
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

test("the two routes whose 403 sits one call deep answer it through the live router", async () => {
  // Both refusals live in a helper the handler calls, not in the handler, so
  // a scan of the handler bodies alone misses them.
  const { env, db } = sqliteTestEnv(schema);
  const req = (p: string, o: RequestInit = {}) =>
    new Request(ORIGIN + p, { ...o, headers: { "content-type": "application/json", ...(o.headers as Record<string, string> | undefined) } });
  const scheme = ["Bea", "rer"].join("") + " ";
  const register = async (handle: string) => {
    const r = await worker.fetch(req("/api/register", { method: "POST", body: JSON.stringify({ handle, model: "gpt-5" }) }), env);
    assert.equal(r.status, 201, `register ${handle}`);
    const j = (await r.json()) as { secret: string; citizen_id?: number; id?: number };
    return { auth: { Authorization: scheme + j.secret }, id: Number(j.citizen_id ?? j.id) };
  };
  const issuer = await register("forbidden-403-issuer");
  const other = await register("forbidden-403-other");
  const funder = await register("forbidden-403-funder");
  const worker2 = await register("forbidden-403-worker");

  // /api/attestations: a retract is the issuer's alone (validateAttestation).
  const issued = await worker.fetch(req("/api/attestations", { method: "POST", headers: issuer.auth, body: JSON.stringify({ class: "correction", subject: "forbidden-403-issuer", claim: "a correction on my own record, to be retracted", evidence: ["post:1"] }) }), env);
  assert.equal(issued.status, 201, "the issuer's own correction lands");
  const issuedBody = (await issued.json()) as { id?: number; attestation?: { id: number }; attestation_id?: number };
  const target = issuedBody.attestation?.id ?? issuedBody.id ?? issuedBody.attestation_id;
  const retract = await worker.fetch(req("/api/attestations", { method: "POST", headers: other.auth, body: JSON.stringify({ class: "retract", subject: "forbidden-403-issuer", claim: "retracting an attestation I did not issue", evidence: ["post:1"], target_attestation_id: target }) }), env);
  assert.equal(retract.status, 403, "retracting someone else's attestation is the permission 403");
  const retractBody = (await retract.json()) as Record<string, unknown>;
  assert.ok("now" in retractBody && "now_utc" in retractBody, "403 body carries the clock stamp");
  assert.match(String(retractBody.error), /only the issuer retracts/, "the 403 names the refusal");

  // /api/awards/:id/payable: on a requester-mode listing only the funder may
  // mark an award payable (assertMayAward). The listing, submission and award
  // are made through the society's own writes; only the award state is set to
  // `awarded` by hand, since a requester award is created payable here.
  const as = (id: number, handle: string) => ({ id, handle, model: "test", karma: 0, created_at: 0, last_seen_at: 0 }) as never;
  const listing = (await createListing(env, as(funder.id, "forbidden-403-funder"), {
    title: "A requester-settled listing for the payable 403",
    condition: "Publish a comment on this registry containing the exact string PAYABLE-403-PROBE and nothing else of note.",
    amount_atomic: "1000000", expiry: Math.floor(Date.now() / 1000) + 86400, max_awards: 1, funding_mode: "promise", settlement_mode: "requester",
  })) as Record<string, unknown>;
  const listingId = Number(String(listing.row).replace("listing-", ""));
  const submission = (await createSubmission(env, as(worker2.id, "forbidden-403-worker"), listingId, { artifact: "https://registry.test/api/comment/1" })) as Record<string, unknown>;
  const award = (await createAward(env, as(funder.id, "forbidden-403-funder"), listingId, { submission_id: submission.id } as never)) as Record<string, unknown>;
  db.prepare("UPDATE listing_awards SET state = 'awarded' WHERE id = ?").run(award.award_id);
  const payable = await worker.fetch(req(`/api/awards/${award.award_id}/payable`, { method: "POST", headers: other.auth, body: "{}" }), env);
  assert.equal(payable.status, 403, "a stranger marking a requester-mode award payable is the permission 403");
  const payableBody = (await payable.json()) as Record<string, unknown>;
  assert.ok("now" in payableBody && "now_utc" in payableBody, "403 body carries the clock stamp");
  assert.match(String(payableBody.error), /only its funder can award/, "the 403 names the refusal");
});

test("two 403-adjacent writes are out of the set on purpose", async () => {
  // POST /api/offers/:id/orders mints a listing through createListing, whose
  // only 403 is the grant sponsor check, and an order never passes grant_id;
  // the one actor rule it has (ordering your own offer) is a 400.
  assert.ok(!FORBIDDEN_403_ROUTES.has("/api/offers/:id/orders"), "offer orders reach no 403");
  // POST /oauth/authorize answers 403 for a cross-origin form (assertSameOrigin)
  // but it is auth "none", a browser form door rather than a citizen write, and
  // its refusal is not about which citizen acts. It stays out.
  assert.ok(!FORBIDDEN_403_ROUTES.has("/oauth/authorize"), "the authorize form's origin check is not the actor 403");
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
  };
  assert.ok(!("403" in doc.paths["/api/offers/{id}/orders"].post.responses), "offer orders declare no 403");
  assert.ok(!("403" in doc.paths["/oauth/authorize"].post.responses), "the authorize form declares no 403");
});
