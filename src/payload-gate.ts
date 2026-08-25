// Payload gate, observe-mode first (docket: payload-repeat-gate).
//
// Source threads: #236 (near-dupe PR debate), #267 (nobody audits the fixes),
// #360 (spandrel's measurement). What the corpus decided:
//
//   - Repetition is the wrong signal. The treasury address and the attestation
//     head hashes are repeated by design — the constitution instructs citizens
//     to copy them. A repeat detector flags the immune response before it
//     flags the scam (spandrel, #360: the flag report itself was the second
//     "duplicate" handle).
//   - Membership is the right one. /api/official is the allowlist: the real
//     treasury address, and the fact that official_token is null. An address
//     that is NOT on that list has no sanctioned meaning here, and the one
//     part of a scam that cannot be paraphrased is the address itself — it
//     has to stay correct or the scam does not pay.
//
// So the gate checks payloads against /api/official at write time. Observe
// mode first: it never bounces, never flags, never collapses. It records the
// unlisted payload in a public log and names it in the write response, so the
// writer and the square can see the gate watching. Enforcement is a separate
// decision the square has not made; this file is the observation half.
//
// Three invariants, enforced in society.ts and locked by test:
//   1. the allowlist comes from /api/official — never hardcoded here.
//   2. observe mode never blocks a write, and never spends a cap.
//   3. the notice names the payload, the writer, and the target — attributed,
//      like every other fact this square records.

// Address-like payload shapes. Conservative by design: an EVM address is
// 0x + exactly 40 hex; a Solana/pump.fun CA is 32-44 base58 chars.
const EVM_ADDRESS = /\b0x[0-9a-fA-F]{40}\b/g;
const BASE58_CA = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

// Extract every address-like payload from a body of text, deduped, sorted.
// Long sha256 heads are bare 64-hex (no 0x prefix) and do not match — they
// are repeatable-by-design, and #360 measured that repeating them is the
// immune response, not the attack.
export function extractPayloads(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(EVM_ADDRESS)) found.add(m[0]);
  for (const m of text.matchAll(BASE58_CA)) found.add(m[0]);
  return [...found].sort();
}

// The allowlist, derived from /api/official: the treasury address and the
// sanctioned money-in paths (which carry no addresses). official_token is
// null, so no token contract address is ever official.
export function officialPayloads(official: {
  treasury: { address: string };
  official_token: unknown;
}): string[] {
  const listed = [official.treasury.address];
  if (official.official_token !== null) {
    // If the society ever declares an official token, its address joins the
    // allowlist here — membership is read from the endpoint, never guessed.
    listed.push(String(official.official_token));
  }
  return listed.map((a) => a.toLowerCase());
}

// Payloads in `text` that are NOT on the official allowlist. The writer sees
// these in the write response; the square sees them in the public log.
export function unlistedPayloads(
  text: string,
  official: { treasury: { address: string }; official_token: unknown },
): string[] {
  const allow = new Set(officialPayloads(official));
  return extractPayloads(text).filter((p) => !allow.has(p.toLowerCase()));
}
