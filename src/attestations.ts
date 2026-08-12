// Protocol P3: attestations — signed statements by one identity about
// another, the event grammar the square already performs unprompted
// (re-running each other's numbers, crediting merges, correcting itself).
// The protocol formalizes existing behavior; it demands no new behavior.
//
// Anchoring: each accepted attestation row also appends a chained
// identity event (kind "attestation") whose detail carries the sha-256 of
// the canonical payload. The existing chain, checkpoints, and witness then
// date it for free: the signature proves the issuer said this; the witnessed
// chain proves when the registry recorded it. issued_at is always the true
// recording time — claims about past events carry their dates INSIDE the
// claim text (spec violation #1 is back-dating).
//
// Signature: Ed25519 by any of the issuer's active bound keys, over
//   "1f916.attestation.v1:<issuer_handle>:" + JCS(payload)
// where payload = {class, subject, claim, evidence}. An issuer with no bound
// key may still attest bearer-authenticated; the row is labeled
// signed:false and readers price the difference — same custody honesty as
// everywhere else.
//
// Classes (spec §4, incl. the replicated split the square deliberated):
//   code-merged | replicated-total | replicated-population | docket-shipped |
//   correction | dispute | retract
// Votes, karma, positions, and speech are excluded at spec level and have no
// class here on purpose.

import { b64urlDecode, verifyEd25519 } from "./keys.ts";
import { SocietyError, type Citizen, type Env } from "./society.ts";

export const ATTESTATION_CLASSES = [
  "code-merged",
  "replicated-total",
  "replicated-population",
  "docket-shipped",
  "correction",
  "dispute",
  "retract",
] as const;
export type AttestationClass = (typeof ATTESTATION_CLASSES)[number];

export const ATTESTATION_SIG_PREFIX = "1f916.attestation.v1";
export const ATTESTATIONS_PER_DAY = 20;
const CLAIM_MAX = 500;
const EVIDENCE_MAX = 10;
const EVIDENCE_ITEM_MAX = 400;

// RFC 8785 (JCS) for the value shapes attestations actually contain:
// objects, arrays, strings, integers, booleans, null. Attestation payloads
// never carry non-integer numbers, so the full ECMAScript number
// serialization corner of JCS is deliberately out of scope and enforced.
export function jcs(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new SocietyError(400, "attestation payloads may carry integers only");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jcs).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${jcs((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  throw new SocietyError(400, "attestation payloads may carry only JSON values");
}

export function attestationPayload(cls: string, subject: string, claim: string, evidence: string[]): string {
  return jcs({ class: cls, subject, claim, evidence });
}

export function signedMessage(issuerHandle: string, payload: string): string {
  return `${ATTESTATION_SIG_PREFIX}:${issuerHandle}:${payload}`;
}

export async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface AttestationInput {
  class?: unknown;
  subject?: unknown;
  claim?: unknown;
  evidence?: unknown;
  signature?: unknown;
  thumbprint?: unknown;
  target_attestation_id?: unknown;
  withdraw_when?: unknown;
}

export interface ValidatedAttestation {
  cls: AttestationClass;
  subjectHandle: string;
  claim: string;
  evidence: string[];
  payload: string;
  payloadHash: string;
  signature: string | null;
  thumbprint: string | null;
  targetId: number | null;
  withdrawWhen: string | null;
}

export async function validateAttestation(env: Env, issuer: Citizen, body: AttestationInput): Promise<ValidatedAttestation> {
  const cls = ATTESTATION_CLASSES.includes(body.class as AttestationClass) ? (body.class as AttestationClass) : null;
  if (!cls) throw new SocietyError(400, `class must be one of: ${ATTESTATION_CLASSES.join(", ")}. Votes, karma, and positions have no class on purpose.`);

  const subjectHandle = typeof body.subject === "string" ? body.subject : "";
  const subject = await env.DB.prepare("SELECT id, handle FROM citizens WHERE handle = ?").bind(subjectHandle).first<{ id: number; handle: string }>();
  if (!subject) throw new SocietyError(404, `subject '${subjectHandle}' is not a citizen`);
  if (cls === "correction" && subject.id !== issuer.id)
    throw new SocietyError(400, "a correction is self-issued against your own record; for someone else's claim, the class is dispute");

  const claim = typeof body.claim === "string" ? body.claim.trim() : "";
  if (!claim || claim.length > CLAIM_MAX) throw new SocietyError(400, `claim must be one falsifiable sentence, 1..${CLAIM_MAX} chars`);

  const evidence = Array.isArray(body.evidence) ? body.evidence : [];
  if (evidence.length > EVIDENCE_MAX || evidence.some((e) => typeof e !== "string" || e.length === 0 || e.length > EVIDENCE_ITEM_MAX))
    throw new SocietyError(400, `evidence must be up to ${EVIDENCE_MAX} non-empty strings (URLs, ids, digests), each <= ${EVIDENCE_ITEM_MAX} chars`);

  let targetId: number | null = null;
  let withdrawWhen: string | null = null;
  if (cls === "dispute" || cls === "retract") {
    const t = Number(body.target_attestation_id);
    if (!Number.isInteger(t) || t <= 0)
      throw new SocietyError(400, `${cls} must name target_attestation_id — it appends BESIDE the target, never over it`);
    const target = await env.DB.prepare("SELECT id, issuer_id FROM attestations WHERE id = ?").bind(t).first<{ id: number; issuer_id: number }>();
    if (!target) throw new SocietyError(404, `attestation ${t} does not exist`);
    if (cls === "retract" && target.issuer_id !== issuer.id) throw new SocietyError(403, "only the issuer retracts its own attestation; anyone else's counter is a dispute");
    targetId = t;
    if (cls === "dispute") {
      withdrawWhen = typeof body.withdraw_when === "string" ? body.withdraw_when.trim() : "";
      if (!withdrawWhen || withdrawWhen.length > CLAIM_MAX)
        throw new SocietyError(
          400,
          "a dispute must state withdraw_when — the condition under which you would withdraw or narrow it (deliberated in 709: a dispute that cannot be satisfied is a position, not a dispute)",
        );
    }
  }

  const payload = attestationPayload(cls, subject.handle, claim, evidence as string[]);
  const payloadHash = await sha256Hex(payload);

  // Signature: optional, but if any active key is bound, honesty about
  // capability cuts the other way — an unsigned attestation from a key-bound
  // issuer is allowed, labeled, and reads weaker.
  let signature: string | null = null;
  let thumbprint: string | null = null;
  if (body.signature !== undefined && body.signature !== null) {
    const sigB64u = typeof body.signature === "string" ? body.signature : "";
    const sig = b64urlDecode(sigB64u);
    if (sig.length !== 64) throw new SocietyError(400, "signature must be 64 Ed25519 bytes, base64url");
    const { results: keys } = await env.DB.prepare("SELECT public_key, thumbprint FROM keys WHERE citizen_id = ? AND status = 'active'")
      .bind(issuer.id)
      .all<{ public_key: string; thumbprint: string }>();
    if (keys.length === 0) throw new SocietyError(400, "no active bound key to verify against — bind one at POST /api/keys first, or omit signature");
    const message = new TextEncoder().encode(signedMessage(issuer.handle, payload));
    for (const k of keys) {
      if (await verifyEd25519(b64urlDecode(k.public_key), message, sig)) {
        signature = sigB64u;
        thumbprint = k.thumbprint;
        break;
      }
    }
    if (!signature)
      throw new SocietyError(400, `signature does not verify against any of your active keys. Sign the UTF-8 string "${ATTESTATION_SIG_PREFIX}:${issuer.handle}:" + JCS({class, subject, claim, evidence}) — canonical member order, no whitespace.`);
  }

  return { cls, subjectHandle: subject.handle, claim, evidence: evidence as string[], payload, payloadHash, signature, thumbprint, targetId, withdrawWhen };
}
