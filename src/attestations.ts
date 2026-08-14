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
// where payload is the CURRENT member set — see attestationPayload and
// canonicalPayloadMembers below, never a copy written out here. A copy is
// what broke: this comment and the refusal message both named the v1
// members for two days after the payload moved to v2, so a caller doing
// exactly what the door said could not succeed (protocol issue #4,
// Asimovs_Revenge). An issuer with no bound
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

// Payload v2 (2026-08-12, self-audit). v1 covered only
// {class, subject, claim, evidence}, which left two holes:
//   - a dispute's TARGET and its withdraw_when were validated, stored, and
//     displayed beside `signed: true` while no signature covered them, so
//     whoever held the bearer secret — or the registry itself — could aim a
//     signed dispute at any attestation and rewrite its withdrawal condition.
//   - the issuer was outside the payload while payload_hash is globally
//     UNIQUE, so two citizens could never make the same claim about the same
//     subject: independent corroboration, the primitive's whole point, was
//     structurally impossible, and a claim string could be squatted.
// v2 covers all of it. Rows keep the exact string that was signed plus their
// version, so v1 signatures stay verifiable forever.
export const ATTESTATION_PAYLOAD_VERSION = 2;

export function attestationPayload(
  cls: string,
  subject: string,
  claim: string,
  evidence: string[],
  issuer?: string,
  targetId?: number | null,
  withdrawWhen?: string | null,
): string {
  if (issuer === undefined) return jcs({ class: cls, subject, claim, evidence }); // v1, for reading old rows
  return jcs({ class: cls, issuer, subject, claim, evidence, target_attestation_id: targetId ?? null, withdraw_when: withdrawWhen ?? null });
}

export function signedMessage(issuerHandle: string, payload: string): string {
  return `${ATTESTATION_SIG_PREFIX}:${issuerHandle}:${payload}`;
}

// Derived from the builder, never written out beside it. Any hand-maintained
// list of these names is a second copy that can go stale while every test
// stays green, which is precisely how the refusal spent two days instructing
// callers to sign a payload the verifier had stopped using.
export function canonicalPayloadMembers(): string[] {
  const probe = attestationPayload("correction", "subject", "claim", [], "issuer", null, null);
  return Object.keys(JSON.parse(probe) as Record<string, unknown>);
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
    const target = await env.DB.prepare("SELECT id, issuer_id, subject_id FROM attestations WHERE id = ?").bind(t).first<{ id: number; issuer_id: number; subject_id: number }>();
    if (!target) throw new SocietyError(404, `attestation ${t} does not exist`);
    if (cls === "retract" && target.issuer_id !== issuer.id) throw new SocietyError(403, "only the issuer retracts its own attestation; anyone else's counter is a dispute");
    // A dispute sits BESIDE its target, so it must be about the same citizen.
    // Without this, a dispute aimed at an attestation about alice could be
    // filed as an attestation about bob: it lands on an uninvolved record and
    // vanishes from the one it contests (self-audit, 2026-08-12).
    if (target.subject_id !== subject.id)
      throw new SocietyError(
        400,
        `a ${cls} must name the same subject as its target — attestation ${t} is about a different citizen, and a dispute filed elsewhere would neither reach the claim it contests nor belong on the record it lands on`,
      );
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

  const payload = attestationPayload(cls, subject.handle, claim, evidence as string[], issuer.handle, targetId, withdrawWhen);
  const payloadHash = await sha256Hex(payload);

  // Signature: optional, but if any active key is bound, honesty about
  // capability cuts the other way — an unsigned attestation from a key-bound
  // issuer is allowed, labeled, and reads weaker.
  let signature: string | null = null;
  let thumbprint: string | null = null;
  if (body.signature !== undefined && body.signature !== null) {
    const sigB64u = typeof body.signature === "string" ? body.signature : "";
    if (!/^[A-Za-z0-9_-]+$/.test(sigB64u)) throw new SocietyError(400, "signature must be base64url (unpadded) — a malformed one is a 400, never a 500");
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
    if (!signature) {
      // The refusal hands back the exact bytes rather than a description of
      // them. A description is a copy of the contract and drifts from it; the
      // bytes ARE the contract. Everything below is the caller's own request
      // canonicalized, so nothing here is disclosed that they did not send.
      const expected = signedMessage(issuer.handle, payload);
      throw new SocietyError(
        400,
        `signature does not verify against any of your active keys. Sign these exact UTF-8 bytes — this is what your request canonicalizes to, ${expected.length} characters, nothing added or trimmed:\n${expected}\nCanonical members, sorted: ${canonicalPayloadMembers().join(", ")} (payload version ${ATTESTATION_PAYLOAD_VERSION}, no whitespace). Rows issued under an earlier version were signed over a smaller member set and stay verifiable against their own published \`payload\`, so reproducing an old row does not confirm the current format.`,
      );
    }
  }

  return { cls, subjectHandle: subject.handle, claim, evidence: evidence as string[], payload, payloadHash, signature, thumbprint, targetId, withdrawWhen };
}
