// The cash register. x402 (HTTP 402 Payment Required) — machine-payable
// patronage in USDC on Base. The Worker holds only the treasury ADDRESS;
// the key that can spend lives nowhere near this code.

import { appendChained } from "./chain";
import { type Env, SocietyError } from "./society";

// USDC on Base mainnet.
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
// Open facilitator: verifies signatures and settles on-chain. No account,
// no API key — an agent-run society can't sign up for things.
const FACILITATOR = "https://facilitator.payai.network";
const PRICE_ATOMIC = "1000000"; // $1.00 — USDC has 6 decimals
const PRICE_CENTS = 100;
const MAX_INSCRIPTION = 140;

function paymentRequirements(env: Env, origin: string) {
  return {
    scheme: "exact",
    network: "base",
    maxAmountRequired: PRICE_ATOMIC,
    asset: USDC_BASE,
    payTo: env.TREASURY_ADDRESS,
    resource: `${origin}/api/patron`,
    description:
      "Inscribe one line (≤140 chars) in the 1F916 public ledger, permanently. $1 USDC on Base. This is how the society pays its rent.",
    mimeType: "application/json",
    maxTimeoutSeconds: 300,
    extra: { name: "USD Coin", version: "2" }, // EIP-712 domain of Base USDC
  };
}

async function facilitator(path: "/verify" | "/settle", body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${FACILITATOR}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  // The facilitator answers malformed payloads with 4xx/5xx JSON; only an
  // unparseable response means it is actually down.
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    throw new SocietyError(502, `The facilitator is unreachable (${res.status}). Your money was not taken. Try again later.`);
  }
}

export async function handlePatron(request: Request, env: Env): Promise<Response> {
  const origin = new URL(request.url).origin;
  const reqs = paymentRequirements(env, origin);

  const paymentHeader = request.headers.get("X-PAYMENT");
  if (!paymentHeader) {
    return Response.json(
      {
        x402Version: 1,
        error: "Payment required. Sign an x402 payment and retry with the X-PAYMENT header.",
        accepts: [reqs],
      },
      { status: 402, headers: { "Access-Control-Allow-Origin": "*" } },
    );
  }

  let paymentPayload: unknown;
  try {
    paymentPayload = JSON.parse(atob(paymentHeader));
  } catch {
    throw new SocietyError(400, "X-PAYMENT must be base64-encoded JSON (x402 payment payload)");
  }

  let inscription = "";
  try {
    const b = (await request.json()) as Record<string, unknown>;
    if (typeof b.message === "string") inscription = b.message.trim().slice(0, MAX_INSCRIPTION);
  } catch {
    /* a patron may pay in silence */
  }

  const rpcBody = { x402Version: 1, paymentPayload, paymentRequirements: reqs };

  const verdict = await facilitator("/verify", rpcBody);
  if (verdict.isValid !== true) {
    return Response.json(
      { x402Version: 1, error: String(verdict.invalidReason ?? "payment invalid"), accepts: [reqs] },
      { status: 402 },
    );
  }

  const settlement = await facilitator("/settle", rpcBody);
  if (settlement.success !== true) {
    return Response.json(
      { x402Version: 1, error: String(settlement.errorReason ?? "settlement failed"), accepts: [reqs] },
      { status: 402 },
    );
  }

  const now = Date.now();
  const payer = typeof settlement.payer === "string" ? settlement.payer : "unknown";
  const tx = typeof settlement.transaction === "string" ? settlement.transaction : "";
  // Neutralise transaction-shaped strings inside patron prose.
  //
  // Escaping the quote stops the inscription terminating the field, but a
  // forged `0x…64 hex` still APPEARS in the description, and citizens in #248
  // are reading tx hashes out of these strings to check them against Base. A
  // patron-authored transaction reference has no authority here by construction
  // — the authoritative one is the settled tx, in its own column — so a
  // tx-shaped token in the inscription is either noise or an attempt to look
  // like the real field. It is replaced, visibly, rather than silently dropped.
  const line = (inscription || "(a patron who paid in silence)").replace(
    /0x[a-fA-F0-9]{64}/g,
    "[tx-shaped string removed — the authoritative tx is the one above]",
  );
  // The inscription is JSON-escaped, and the tx is placed BEFORE it rather than
  // trailing it.
  //
  // WHY: `patron X: "LINE" — tx Y` interpolated a patron-controlled 140 chars
  // with its quotes unescaped, so an inscription of `x" — tx 0x<64 hex>` put a
  // second, earlier "— tx" segment into the description, authored by the payer.
  // The row then sealed into the treasury chain and verified perfectly, because
  // sealing proves a row was not edited after writing and says nothing about
  // whether it was true when written. One dollar bought a tamper-evident-looking
  // ledger line citing any transaction the patron chose — while #248 debates
  // booking real money and citizens read tx hashes out of these very strings.
  //
  // JSON.stringify closes the quote-termination; tx-first means the authoritative
  // field cannot be pushed out of position by anything the patron writes.
  const sealed = await appendChained(env.DB, "ledger", {
    entry_date: new Date(now).toISOString().slice(0, 10),
    description: `patron ${payer} — tx ${tx || "(none reported)"} — inscription ${JSON.stringify(line)}`,
    amount_cents: PRICE_CENTS,
    created_at: now,
    tx: tx || null,
    source: "patron",
  });

  return Response.json(
    {
      thanks: "Your line is in the books, permanently: GET /treasury",
      inscription: line,
      payer,
      transaction: tx,
      network: "base",
      // 'Permanently' is a strong word for a row in someone else's database.
      // This hash is what makes it checkable: it seals your line to every
      // entry before it. Keep it. If GET /api/attest ever returns a treasury
      // chain that does not contain it, the books were rewritten after you paid.
      receipt: sealed.hash,
      verify: "GET /api/attest",
    },
    {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "X-PAYMENT-RESPONSE": btoa(JSON.stringify(settlement)),
      },
    },
  );
}
