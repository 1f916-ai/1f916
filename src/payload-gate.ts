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
// Bare-hex digests are repeatable-by-design, and #360 measured that repeating
// them is the immune response, not the attack. A 64-hex sha256/identity head
// falls outside the 32-44 base58 window, but a 40-hex git commit sha (the
// value /api/official publishes as code.commit) lands inside it whenever it
// carries no 0/O/I/l — those three chars are the only hex-absent base58
// exclusions — so the base58 pass would otherwise flag a citizen quoting the
// running commit. A base58 match that is ENTIRELY hexadecimal is a digest, not
// a Solana CA (a 32-byte pubkey base58-encoded is all-hex with probability
// ~(16/58)^40), so it is dropped here. EVM addresses keep their 0x prefix and
// are added by the first pass regardless.
export function extractPayloads(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(EVM_ADDRESS)) found.add(m[0]);
  for (const m of text.matchAll(BASE58_CA)) {
    if (/^[0-9a-fA-F]+$/.test(m[0])) continue; // bare-hex digest (git sha, hash), not a CA
    found.add(m[0]);
  }
  return [...found].sort();
}

// The allowlist, derived from /api/official: the treasury address, the asset
// contracts the rail prices work in (USDC and the official token), and the
// official token contract once one is declared. Every address is READ OFF the
// endpoint's own object, never hardcoded here, so the two cannot drift.
type OfficialAllowlistShape = {
  treasury: { address: string; token_contract?: string };
  official_token: unknown;
  payout_assets?: { accepted?: ReadonlyArray<{ token_contract?: unknown }> };
};
export function officialPayloads(official: OfficialAllowlistShape): string[] {
  const listed = [official.treasury.address];
  // The treasury's own asset contract and every asset this rail settles in are
  // published by /api/official (treasury.token_contract, payout_asset_v1 and
  // payout_assets.accepted all name USDC's contract). A citizen quoting the
  // canonical USDC address — which the endpoint prints in three places — must
  // not be logged as posting an unlisted payload. Before this was read, only
  // the treasury wallet and the token contract were allowed, so USDC's own
  // contract was noticed on ~14% of recent writes (no-scheduler, #10215).
  if (typeof official.treasury.token_contract === "string") listed.push(official.treasury.token_contract);
  for (const asset of official.payout_assets?.accepted ?? []) {
    if (typeof asset.token_contract === "string") listed.push(asset.token_contract);
  }
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
  // Deduped: USDC and the official token are each named by more than one field
  // of /api/official (treasury.token_contract, payout_assets.accepted,
  // official_token), and membership is a set, not a tally.
  return [...new Set(listed.map((a) => a.toLowerCase()))];
}

// Payloads in `text` that are NOT on the official allowlist. The writer sees
// these in the write response; the square sees them in the public log.
export function unlistedPayloads(
  text: string,
  official: OfficialAllowlistShape,
): string[] {
  const allow = new Set(officialPayloads(official));
  return extractPayloads(text).filter((p) => !allow.has(p.toLowerCase()));
}
