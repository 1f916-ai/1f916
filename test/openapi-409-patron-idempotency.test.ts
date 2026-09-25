// /openapi.json declares the x402 idempotency 409 the patron write serves,
// not only the 200, the 400 and the payment-required 402.
//
// POST /api/patron answers 409 the instant a signed X-PAYMENT authorization
// this exact payload has already claimed a settle row and that row is not yet
// booked (src/x402.ts handlePatron: the claim INSERT OR IGNORE is a no-op, the
// prior row is not `booked`, so the handler returns
//   { error: "This payment is already in flight or was interrupted after
//     settling. It has NOT been charged again. ...", transaction: <tx|null>,
//     since: <created_at|null> }
// with status 409). That 409 is the safety-critical refusal a paying client
// must distinguish from the 402 ("no payment, sign and retry"), the 200
// ("same receipt, already booked") and the 502 ("do NOT re-sign blindly, the
// money MAY have gone through"): it says the money was NOT taken a second
// time and the client must retry with a NEW authorization, not re-sign this
// one. The route declared only the 200/400/402, so a client generated from
// the document with openapi-fetch narrowed on status and typed the 409 body
// `never` -- the undiagnosable-success failure the payment-required 402 on
// this same route already fixed, on the already-claimed side.
//
// The 409 sits beside the four everyday writes' already-applied 409
// (ALREADY_APPLIED_409_ROUTES, test/openapi-409-already-applied.test.ts) and
// the front door's taken-handle 409 (test/openapi-register-409.test.ts) as a
// named single-route exception. Like the 402 it carries no clock stamp: the
// patron route answers with Response.json directly, not the registry's
// clocking json() wrapper. The 502 (facilitator unreachable, where the money
// MAY have moved) is a server-failure class the document leaves undeclared,
// as it leaves the 500 and the edge-429 undeclared.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { sha256Hex } from "../src/chain.ts";
import worker from "../src/index.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";
const TREASURY = "0xa7F7985eB19b8c44F12A0654Df1eF89d1dd527C9";
// One signed authorization, base64 JSON as the x402 client sends it. The
// registry never inspects the payload (the facilitator does); the idempotency
// key is sha256Hex of the raw X-PAYMENT header string.
const PAYMENT_HEADER = btoa(JSON.stringify({ x402Version: 1, scheme: "exact", network: "base", payload: { signature: "0xsig", authorization: "0xabababababababababababababababababababab" } }));

// The doc shape the assertions need. Named (not an inline multi-line object
// literal in the cast) because the registry's type-stripping parser wants the
// cast's inner type on one line.
type PatronDoc = {
  paths: {
    "/api/patron": {
      post: {
        responses: {
          [status: string]: { content?: Record<string, unknown>; description?: string };
        };
      };
    };
  };
};

type Reply = { status?: number; json?: unknown };
// A scripted facilitator: only /verify answers here, because the idempotency
// 409 fires at the claim step, before /settle is ever asked. The settle call
// count is the assertion that nothing was re-settled.
function facilitator(script: { verify?: Reply }) {
  const calls: string[] = [];
  const refuser = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const path = url.endsWith("/verify") ? "verify" : url.endsWith("/settle") ? "settle" : "other";
    calls.push(path);
    const reply = script[path as "verify"];
    if (!reply) throw new Error(`unexpected facilitator call ${url}`);
    return new Response(JSON.stringify(reply.json ?? {}), { status: reply.status ?? 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { settles: () => calls.filter((c) => c === "settle").length, restore: () => { globalThis.fetch = refuser; } };
}

test("POST /api/patron declares the idempotency 409 beside the 200/400/402", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as unknown as PatronDoc;
  const responses = Object.keys(doc.paths["/api/patron"].post.responses).sort();
  // The five are the four the patron route itself serves plus the edge
  // rate-limit 429 that now sits on every /api path (Cloudflare's plain-text
  // 1015, no JSON body -- distinct from the society's budget 429s, which do not
  // cover this route). The idempotency 409 must hold its place beside the
  // success, the malformed-payload 400 and the payment-required 402.
  assert.deepEqual(
    responses,
    ["200", "400", "402", "409", "429"],
    `POST /api/patron declares ${JSON.stringify(responses)}; it must carry the idempotency 409 beside the success, the malformed-payload 400 and the payment-required 402, plus the edge rate-limit 429 shared by every /api route`,
  );
});

test("the declared 409 carries the JSON error body and names the already-claimed payment", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as unknown as PatronDoc;
  const body = doc.paths["/api/patron"].post.responses["409"];
  assert.ok(body, "POST /api/patron declares the idempotency 409");
  assert.deepEqual(Object.keys(body.content ?? {}), ["application/json"], "the 409 body is the JSON error object");
  assert.match(body.description ?? "", /already claimed|not been charged again/i, "the 409 description names the already-claimed, not-re-charged refusal");
});

test("the live router answers 409 with the not-re-charged body on a claimed, unbooked authorization", async () => {
  const { env, db } = sqliteTestEnv(schema);
  (env as unknown as Record<string, unknown>).TREASURY_ADDRESS = TREASURY;
  // Seed the claim row a first, incomplete attempt would leave: settled but
  // interrupted before the ledger line was booked, so it is not `booked`.
  const now = Date.now();
  const idemKey = await sha256Hex(PAYMENT_HEADER);
  db.prepare("INSERT INTO settle_attempts (idem_key, state, inscription, created_at, updated_at) VALUES (?, 'settling', 'seed', ?, ?)")
    .run(idemKey, now, now);

  const fac = facilitator({ verify: { json: { isValid: true } } });
  try {
    const r = await worker.fetch(
      new Request(ORIGIN + "/api/patron", {
        method: "POST",
        headers: { "content-type": "application/json", "X-PAYMENT": PAYMENT_HEADER },
        body: JSON.stringify({ message: "a line for the books" }),
      }),
      env,
    );
    assert.equal(r.status, 409, "the claimed, unbooked authorization is refused with 409, not 402/200");
    assert.equal(fac.settles(), 0, "the already-claimed authorization is not settled a second time");
    const body = (await r.json()) as Record<string, unknown>;
    assert.equal(typeof body.error, "string", "the 409 body carries an error string");
    assert.match(String(body.error), /NOT been charged again/i, "the 409 error names the not-re-charged refusal");
    assert.match(String(body.error), /new authorization/i, "the 409 error tells the client to retry with a NEW authorization");
    assert.ok("transaction" in body && "since" in body, "the 409 body carries the recorded transaction and the since timestamp");
    assert.ok(!("now" in body) && !("now_utc" in body), "the 409 body carries no clock stamp (Response.json, not the clocking wrapper)");
  } finally {
    fac.restore();
  }
});
