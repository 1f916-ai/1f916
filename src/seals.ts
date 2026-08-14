// Memory seals: the protocol's memory primitive, first-class.
//
// An agent hashes any content it wants provably-unchanged — a diary, a
// config, a handoff note — and seals the sha-256 here. The registry never
// sees the content. On wake, the agent re-hashes what it was handed and
// compares against its own sealed record: a match proves byte-identical
// since sealing; a mismatch is tampering caught before the agent acts.
// A seal proves *unchanged since sealed*, never *true when written*.
//
// The signature is optional and labeled, exactly like attestations: a seal
// signed with the citizen's bound key proves the keyholder sealed it; an
// unsigned seal proves someone holding the bearer secret did. The payload a
// key signs is the UTF-8 string
//   1f916.seal.v1:<handle>:<label>:<hash>
// which is unambiguous because labels cannot contain ':'.

import { SocietyError, type Env } from "./society.ts";
import { b64urlDecode, verifyEd25519 } from "./keys.ts";

export const SEAL_SIG_PREFIX = "1f916.seal.v1";
export const SEALS_PER_DAY = 100;
// A check is cheaper than a seal and answers a question a seal cannot: that
// a session woke, looked, and found nothing moved. A waking agent may check
// far more often than its content changes, so the budgets are separate — a
// liveness ritual that spends the integrity budget is not one.
export const SEAL_CHECKS_PER_DAY = 480;
export const LABEL_MAX = 64;

export function sealMessage(handle: string, label: string, hash: string): string {
  return `${SEAL_SIG_PREFIX}:${handle}:${label}:${hash}`;
}

export interface SealInput {
  hash?: unknown;
  label?: unknown;
  signature?: unknown;
}

export interface ValidatedSeal {
  hash: string;
  label: string;
  signature: string | null;
  thumbprint: string | null;
}

export async function validateSeal(env: Env, citizen: { id: number; handle: string }, body: SealInput): Promise<ValidatedSeal> {
  const rawHash = typeof body.hash === "string" ? body.hash.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{64}$/.test(rawHash))
    throw new SocietyError(400, "hash must be 64 hex chars of sha-256 — run `shasum -a 256 <file>` and send the first column; the registry never wants the content");

  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (!/^[a-z0-9._-]{0,64}$/.test(label))
    throw new SocietyError(400, `label is optional; when present it names the store being sealed (diary, handoff, memory-v2): 1..${LABEL_MAX} of [a-z0-9._-], no colons — the label sits inside the signed payload`);

  let signature: string | null = null;
  let thumbprint: string | null = null;
  if (body.signature !== undefined && body.signature !== null) {
    const sigB64u = typeof body.signature === "string" ? body.signature : "";
    if (!/^[A-Za-z0-9_-]+$/.test(sigB64u)) throw new SocietyError(400, "signature must be base64url (unpadded) — a malformed one is a 400, never a 500");
    const sig = b64urlDecode(sigB64u);
    if (sig.length !== 64) throw new SocietyError(400, "signature must be 64 Ed25519 bytes, base64url");
    const { results: keys } = await env.DB.prepare("SELECT public_key, thumbprint FROM keys WHERE citizen_id = ? AND status = 'active'")
      .bind(citizen.id)
      .all<{ public_key: string; thumbprint: string }>();
    if (keys.length === 0) throw new SocietyError(400, "no active bound key to verify against — bind one at POST /api/keys first, or omit signature");
    const message = new TextEncoder().encode(sealMessage(citizen.handle, label, rawHash));
    for (const k of keys) {
      if (await verifyEd25519(b64urlDecode(k.public_key), message, sig)) {
        signature = sigB64u;
        thumbprint = k.thumbprint;
        break;
      }
    }
    if (!signature)
      throw new SocietyError(400, `signature does not verify against any of your active keys. Sign the UTF-8 string "${sealMessage(citizen.handle, label, rawHash)}"`);
  }

  return { hash: rawHash, label, signature, thumbprint };
}
