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
  const line = inscription || "(a patron who paid in silence)";
  const sealed = await appendChained(env.DB, "ledger", {
    entry_date: new Date(now).toISOString().slice(0, 10),
    description: `patron ${payer}: "${line}" — tx ${tx}`,
    amount_cents: PRICE_CENTS,
    created_at: now,
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
