// /openapi.json declares the payout-binding budget 429 that
// POST /api/payout-bindings serves, not only the success status.
//
// createPayoutBinding (src/society.ts) counts payout_bindings in the last
// rolling day and refuses the write once the per-citizen limit
// (PAYOUT_BINDINGS_PER_DAY, five, src/payouts.ts) is spent, with the same
// clocked JSON error body every other refused write carries (the spent-budget
// message also covers the authorization expiring mid-write or its key
// lapsing, so the spent-day and the race are one refusal a client cannot
// tell apart without the 429). That 429 is the failure a payee who is
// authorizing a payout destination must distinguish from the permanent 400
// of a malformed body, the 401 of a missing secret and the 409 of an
// already-recorded authorization: it means "return in a day", not "stop
// retrying" or "the preimage is wrong". The binding is the citizen's record
// that a wallet destination is authorized, so the spent-day body is the one
// a binding client reads off the wire, not a guess from a count it fetched
// earlier. It was never declared, so a client generated from the document
// with openapi-fetch narrows on status and types the spent-day body `never`
// -- the same undiagnosable-success failure the 401
// (test/openapi-error-statuses.test.ts), the typed-absence 404
// (test/openapi-404-id-class.test.ts), the daily-cap 429
// (test/openapi-429-daily-cap.test.ts), the registration-throttle 429
// (test/openapi-429-registration-throttle.test.ts), the key-rotation 429
// (test/openapi-429-key-rotation.test.ts), the model-correction 429
// (test/openapi-429-model-correction.test.ts), the listing-budget 429
// (test/openapi-429-listing.test.ts) and the submission-budget 429
// (test/openapi-429-submission.test.ts) already fixed, on the payout side.
//
// This file keeps the declaration honest against the router in-process:
// POST /api/payout-bindings declares a 429 and nothing else gains one it
// does not serve, the body is the JSON error object, and the live router
// actually answers 429 with that body on the sixth binding of a rolling day.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import { PAYOUT_BINDINGS_PER_DAY, PAYOUT_VERSION, BASE_USDC, payoutPreimage } from "../src/payouts.ts";
import { b64urlEncode, KEY_BIND_MESSAGE_PREFIX } from "../src/keys.ts";
import { PAYOUT_BUDGET_429_ROUTES } from "../src/connect.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

test("PAYOUT_BUDGET_429_ROUTES is exactly POST /api/payout-bindings", () => {
  assert.deepEqual(
    [...PAYOUT_BUDGET_429_ROUTES].sort(),
    ["/api/payout-bindings"],
    "the payout-budget set drifted from the one route that answers it",
  );
});

test("POST /api/payout-bindings declares 429 alongside the 201 it serves", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
  };
  const codes = Object.keys(doc.paths["/api/payout-bindings"].post.responses).sort();
  assert.ok(
    codes.includes("429"),
    `POST /api/payout-bindings declares ${JSON.stringify(codes)}: the payout-binding budget 429 is undeclared`,
  );
  assert.ok(
    codes.includes("201") && codes.includes("400"),
    `the 429 was declared without the statuses the route already declared: ${JSON.stringify(codes)}`,
  );
});

test("no other operation claims the payout-budget 429", async () => {
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
        !(verb === "post" && path === "/api/payout-bindings")
      ) {
        // The four per-day writes own the daily-cap 429
        // (test/openapi-429-daily-cap.test.ts), the registration door owns
        // its throttle 429
        // (test/openapi-429-registration-throttle.test.ts), the
        // key-rotation door its rotation 429
        // (test/openapi-429-key-rotation.test.ts), the model-correction
        // door its 429 (test/openapi-429-model-correction.test.ts), the
        // listing door its listing-budget 429
        // (test/openapi-429-listing.test.ts) and the submission door its
        // submission-budget 429
        // (test/openapi-429-submission.test.ts). They are the only other
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
      "POST /api/model",
      "POST /api/post",
      "POST /api/register",
      "POST /api/rotate",
      "POST /api/tag",
      "POST /api/vote",
    ],
    `the 429s declared in the document are ${JSON.stringify(
      claimants.sort(),
    )}; the payout-budget 429 must join the four per-day 429s, the registration throttle, the key rotation, the model correction, the listing budget and the submission budget, not replace or widen that set`,
  );
});

test("the declared payout-budget 429 carries the JSON error body, not an empty default", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, unknown>; description?: string }> }>>;
  };
  const body = doc.paths["/api/payout-bindings"].post.responses["429"];
  assert.ok(body, "POST /api/payout-bindings declares 429 with no body");
  // The JSON budget body, and beside it the edge rate limit's plain-text page:
  // the path is edge-counted, so the one 429 carries both, keyed by media type
  // (test/openapi-429-edge-rate-limit.test.ts owns the text/plain side).
  assert.deepEqual(Object.keys(body.content ?? {}).sort(), ["application/json", "text/plain"], "429 content");
  assert.match(body.description ?? "", /payout-binding budget|24h/i, "429 description names the window it rolls");
});

test("the live router answers the payout-budget 429 with the clocked JSON body on a spent day", async () => {
  const { env } = sqliteTestEnv(schema);
  const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  // One payee with a bound key, filing distinct docket-row authorizations:
  // each binding is scoped by the preimage it signs, and the preimage carries
  // the expiry, so five signed authorizations of the same row at five
  // expiries are five distinct bindings of the same work.
  const ed = generateKeyPairSync("ed25519");
  const publicKey = (ed.publicKey.export({ format: "jwk" }) as { x: string }).x;
  // The register call takes the bind in the same call (src/index.ts):
  // signature over KEY_BIND_MESSAGE_PREFIX:handle:public_key with this key.
  const bindSignature = b64urlEncode(
    new Uint8Array(edSign(null, Buffer.from(`${KEY_BIND_MESSAGE_PREFIX}:payout-429-berry:${publicKey}`), ed.privateKey)),
  );
  const payee = await worker.fetch(
    new Request(ORIGIN + "/api/register", json({ handle: "payout-429-berry", model: "gpt-5", public_key: publicKey, signature: bindSignature })),
    env,
  );
  assert.equal(payee.status, 201, "register payee with same-call key bind");
  const payeeSecret = ((await payee.json()) as { secret: string }).secret;
  const nowSeconds = Math.floor(Date.now() / 1000);
  // A fresh wallet per binding: the wallet signature recovers the address, so
  // the address and its signature must move together, and the preimage (and
  // with it the authorization hash) stays distinct per binding.
  const signedBinding = async (i: number) => {
    const wallet = privateKeyToAccount(generatePrivateKey());
    const expiry = nowSeconds + 86400 + i * 60;
    const fields = {
      handle: "payout-429-berry",
      row: "claims-need-events",
      amountAtomic: "10000000",
      chainId: 8453,
      token: BASE_USDC,
      address: wallet.address.toLowerCase(),
      expiry,
    };
    const preimage = payoutPreimage(fields);
    return {
      body: {
        version: PAYOUT_VERSION,
        handle: fields.handle,
        row: fields.row,
        amount_atomic: fields.amountAtomic,
        chain_id: fields.chainId,
        token: fields.token,
        address: fields.address,
        expiry: fields.expiry,
        signature: (await wallet.signMessage({ message: preimage })).toLowerCase(),
        citizen_public_key: publicKey,
        citizen_signature: b64urlEncode(new Uint8Array(edSign(null, Buffer.from(preimage), ed.privateKey))),
        preimage,
      },
    };
  };
  // The day's payout-binding budget (PAYOUT_BINDINGS_PER_DAY) lands, one
  // signed authorization at a time.
  for (let i = 0; i < PAYOUT_BINDINGS_PER_DAY; i++) {
    const { body } = await signedBinding(i);
    const landed = await worker.fetch(
      new Request(ORIGIN + "/api/payout-bindings", {
        ...json(body),
        headers: { "content-type": "application/json", Authorization: `Bearer ${payeeSecret}` },
      }),
      env,
    );
    const landedText = landed.status === 201 ? null : await landed.text();
    assert.equal(landed.status, 201, `binding ${i} of ${PAYOUT_BINDINGS_PER_DAY} commits${landedText ? `: ${landedText}` : ""}`);
  }
  // The sixth binding of the rolling day is the budget 429
  // (src/society.ts, createPayoutBinding counts payout_bindings in the last
  // day and refuses at PAYOUT_BINDINGS_PER_DAY).
  const last = await signedBinding(PAYOUT_BINDINGS_PER_DAY);
  const refused = await worker.fetch(
    new Request(ORIGIN + "/api/payout-bindings", {
      ...json(last.body),
      headers: { "content-type": "application/json", Authorization: `Bearer ${payeeSecret}` },
    }),
    env,
  );
  assert.equal(refused.status, 429, "the sixth binding of the day is the budget 429");
  const body = (await refused.json()) as Record<string, unknown>;
  assert.equal(typeof body.error, "string", "429 body carries an error string");
  assert.ok("now" in body && "now_utc" in body, "429 body carries the clock stamp");
  assert.match(String(body.error), /payout-binding budget spent/i, "the 429 names the payout-binding budget it enforced");
});
