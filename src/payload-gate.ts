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
//     treasury address, and the official token contract. An address
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
// sanctioned money-in paths (which carry no addresses), plus the official
// token contract once one is declared.
export function officialPayloads(official: {
  treasury: { address: string };
  official_token: unknown;
}): string[] {
  const listed = [official.treasury.address];
  if (official.official_token !== null && official.official_token !== undefined) {
    // The society declared an official token on 2026-08-25, so its contract
    // joins the allowlist. Membership is read off the endpoint, never guessed
    // here. Two shapes are accepted because this function outlived the null:
    // the object /api/official serves, whose `contract` is the address, and a
    // bare address string, which is what the tests and any future shape that
    // is just an address will pass.
    const token = official.official_token as { contract?: unknown } | string;
    const address =
      typeof token === "string" ? token : typeof token.contract === "string" ? token.contract : null;
    // A declared token whose shape carries no address adds nothing to the
    // allowlist. Silently pushing "[object Object]" would have left the real
    // contract unlisted, which is the one failure this gate cannot afford:
    // every citizen quoting the official contract would be logged as unlisted.
    if (address) listed.push(address);
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
