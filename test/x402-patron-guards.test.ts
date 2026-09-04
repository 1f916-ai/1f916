// x402 patron intake: the guards between "a signed payment arrived" and
// "money moved and was booked", each pinned by the mutation that kills it.
//
// Before this file no test in the suite called handlePatron at all. The
// mutation audit of 2026-09-04 deleted every refusal in src/x402.ts one at a
// time and the suite stayed green each time: an invalid /verify still
// settled, a failed /settle still booked a line, and the same signed
// authorization settled twice. Money in is the one path that has moved real
// dollars, so each of those is now a test that names its killing mutation.
//
// The facilitator is scripted per test by replacing globalThis.fetch (the
// offline preload already replaced it with a refuser; this swaps it for a
// recorder and restores the refuser afterwards). Nothing here opens a socket.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handlePatron } from "../src/x402.ts";
import { SocietyError } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const TREASURY = "0xa7F7985eB19b8c44F12A0654Df1eF89d1dd527C9";
const TX = "0x" + "ab".repeat(32);
const PAYER = "0x1111111111111111111111111111111111111111";

function makeEnv() {
  const { env, db } = sqliteTestEnv(schema);
  (env as unknown as Record<string, unknown>).TREASURY_ADDRESS = TREASURY;
  const count = (table: "ledger" | "settle_attempts") => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
  return { env, db, count };
}

type Reply = { status?: number; json?: unknown; text?: string };

// A scripted facilitator: what /verify and /settle answer, and a log of which
// was called and how many times. The log is the assertion that matters for
// idempotency: a response can look right while the money moved twice.
function facilitator(script: { verify?: Reply; settle?: Reply }) {
  const calls: string[] = [];
  const refuser = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const path = url.endsWith("/verify") ? "verify" : url.endsWith("/settle") ? "settle" : "other";
    calls.push(path);
    const reply = script[path as "verify" | "settle"];
    if (!reply) throw new Error(`unexpected facilitator call ${url}`);
    const body = reply.text ?? JSON.stringify(reply.json ?? {});
    return new Response(body, { status: reply.status ?? 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return {
    calls,
    settles: () => calls.filter((c) => c === "settle").length,
    restore: () => { globalThis.fetch = refuser; },
  };
}

// One signed authorization, base64 JSON as the x402 client sends it. The
// registry never inspects its contents (the facilitator does), so the shape
// only has to be JSON.
const PAYMENT = btoa(JSON.stringify({ x402Version: 1, scheme: "exact", network: "base", payload: { signature: "0xsig", authorization: { from: PAYER } } }));

function patron(payment: string | null, message = "a line for the books") {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (payment !== null) headers["X-PAYMENT"] = payment;
  return new Request("https://registry.test/api/patron", { method: "POST", headers, body: JSON.stringify({ message }) });
}

const VALID = { json: { isValid: true } };
const SETTLED = { json: { success: true, payer: PAYER, transaction: TX } };

test("no X-PAYMENT header is a 402 that names the terms and touches nothing", async () => {
  const { env, count } = makeEnv();
  const fac = facilitator({});
  try {
    const r = await handlePatron(patron(null), env);
    assert.equal(r.status, 402);
    const body = (await r.json()) as { accepts: { payTo: string; maxAmountRequired: string }[] };
    assert.equal(body.accepts[0].payTo, TREASURY);
    assert.equal(body.accepts[0].maxAmountRequired, "1000000");
    assert.deepEqual(fac.calls, [], "no facilitator call without a payment to verify");
    assert.equal(count("settle_attempts"), 0);
    assert.equal(count("ledger"), 0);
  } finally { fac.restore(); }
});

test("an X-PAYMENT that is not base64 JSON is a 400 before the facilitator is asked anything", async () => {
  // KILLING MUTATION: src/x402.ts, the `throw new SocietyError(400, "X-PAYMENT
  // must be base64-encoded JSON ...")` -> `void new SocietyError(...)`. The
  // handler then carries an undefined payload to /verify.
  const { env, count } = makeEnv();
  const fac = facilitator({});
  try {
    await assert.rejects(
      () => handlePatron(patron("not-base64-json"), env),
      (e: unknown) => e instanceof SocietyError && e.status === 400 && /base64-encoded JSON/.test(e.message),
    );
    assert.deepEqual(fac.calls, []);
    assert.equal(count("settle_attempts"), 0);
  } finally { fac.restore(); }
});

test("a payment the facilitator will not verify is refused: /settle is never called and nothing is claimed or booked", async () => {
  // KILLING MUTATION: src/x402.ts `if (verdict.isValid !== true) {` ->
  // `if (false) {`. The handler then claims the payment and settles it on an
  // invalid signature.
  const { env, count } = makeEnv();
  const fac = facilitator({ verify: { json: { isValid: false, invalidReason: "signature does not recover payer" } }, settle: SETTLED });
  try {
    const r = await handlePatron(patron(PAYMENT), env);
    assert.equal(r.status, 402);
    const body = (await r.json()) as { error: string };
    assert.match(body.error, /signature does not recover payer/, "the facilitator's reason is passed through, not replaced");
    assert.deepEqual(fac.calls, ["verify"], "an invalid verification must never reach /settle");
    assert.equal(count("settle_attempts"), 0, "nothing is claimed for a payment that did not verify");
    assert.equal(count("ledger"), 0);
  } finally { fac.restore(); }
});

test("a /settle that reports failure books nothing and releases the claim so the same authorization can be retried", async () => {
  // KILLING MUTATION: src/x402.ts `if (settlement.success !== true) {` ->
  // `if (false) {`. The handler then writes a ledger line for a transfer
  // that did not happen.
  const { env, count } = makeEnv();
  const fac = facilitator({ verify: VALID, settle: { json: { success: false, errorReason: "insufficient allowance" } } });
  try {
    const r = await handlePatron(patron(PAYMENT), env);
    assert.equal(r.status, 402);
    assert.match(((await r.json()) as { error: string }).error, /insufficient allowance/);
    assert.equal(count("ledger"), 0, "a failed settlement is not a line in the books");
    assert.equal(count("settle_attempts"), 0, "the claim is released: the patron may retry this exact authorization");
    // And the retry is genuinely possible: the same header is settled fresh.
    fac.restore();
    const again = facilitator({ verify: VALID, settle: SETTLED });
    try {
      const ok = await handlePatron(patron(PAYMENT), env);
      assert.equal(ok.status, 200);
      assert.equal(count("ledger"), 1);
    } finally { again.restore(); }
  } finally { fac.restore(); }
});

test("the same signed authorization is settled once: a replay returns the existing receipt and /settle is not called again", async () => {
  // KILLING MUTATION: src/x402.ts `if (claimed.meta.changes === 0) {` ->
  // `if (false) {`. The replay then calls /settle a second time; the ledger's
  // UNIQUE on tx catches the double-booking afterwards, so the RESPONSE still
  // looks idempotent. The facilitator call count is the assertion that
  // distinguishes "settled once" from "charged twice, recorded once".
  const { env, count } = makeEnv();
  const fac = facilitator({ verify: VALID, settle: SETTLED });
  try {
    const first = await handlePatron(patron(PAYMENT), env);
    assert.equal(first.status, 200);
    const receipt = ((await first.json()) as { receipt: string }).receipt;
    assert.match(receipt, /^[0-9a-f]{64}$/);
    assert.equal(fac.settles(), 1);

    const replay = await handlePatron(patron(PAYMENT), env);
    assert.equal(replay.status, 200);
    const body = (await replay.json()) as { thanks: string; receipt: string; transaction: string };
    assert.match(body.thanks, /Already in the books/);
    assert.equal(body.receipt, receipt, "the same authorization resolves to the same entry");
    assert.equal(body.transaction, TX);
    assert.equal(fac.settles(), 1, "a replayed authorization must not be settled a second time");
    assert.equal(count("ledger"), 1);
    assert.equal(count("settle_attempts"), 1);
  } finally { fac.restore(); }
});

test("a facilitator that answers /verify unintelligibly is a 502 that may truthfully say nothing was charged", async () => {
  // KILLING MUTATION: src/x402.ts, in facilitator(), the /verify branch
  // `throw new SocietyError(502, ...Nothing was charged...)` ->
  // `void new SocietyError(...)`. The call then returns undefined and the
  // handler dies on `verdict.isValid` with a TypeError instead of a 502.
  const { env, count } = makeEnv();
  const fac = facilitator({ verify: { status: 503, text: "<html>upstream down</html>" }, settle: SETTLED });
  try {
    await assert.rejects(
      () => handlePatron(patron(PAYMENT), env),
      (e: unknown) => e instanceof SocietyError && e.status === 502 && /Nothing was charged/.test(e.message) && /503/.test(e.message),
    );
    assert.deepEqual(fac.calls, ["verify"]);
    assert.equal(count("settle_attempts"), 0, "nothing was claimed because nothing was verified");
  } finally { fac.restore(); }
});

test("a facilitator that answers /settle unintelligibly is a 502 that says the payment MAY have gone through, and the claim row stays", async () => {
  // KILLING MUTATION: src/x402.ts, in facilitator(), the /settle branch
  // `throw new SocietyError(502, ...MAY have gone through...)` ->
  // `void new SocietyError(...)`. The claim would then be resolved by a
  // TypeError on `settlement.success`, and the honest sentence (#33) would be
  // gone. The claim row surviving is what stops this payload being settled
  // blind a second time.
  const { env, db, count } = makeEnv();
  const fac = facilitator({ verify: VALID, settle: { status: 504, text: "gateway timeout" } });
  try {
    await assert.rejects(
      () => handlePatron(patron(PAYMENT), env),
      (e: unknown) => e instanceof SocietyError && e.status === 502 && /MAY have gone through/.test(e.message) && !/Nothing was charged/.test(e.message),
    );
    assert.equal(fac.settles(), 1);
    assert.equal(count("ledger"), 0);
    const row = db.prepare("SELECT state FROM settle_attempts").get() as { state: string } | undefined;
    assert.equal(row?.state, "settling", "the claim stays: this payload must never be settled blind again");
    // And a retry of the SAME authorization is refused as in-flight rather
    // than settled again.
    fac.restore();
    const retry = facilitator({ verify: VALID, settle: SETTLED });
    try {
      const r = await handlePatron(patron(PAYMENT), env);
      assert.equal(r.status, 409);
      assert.equal(retry.settles(), 0, "an interrupted settlement is never re-sent to /settle");
    } finally { retry.restore(); }
  } finally { fac.restore(); }
});
