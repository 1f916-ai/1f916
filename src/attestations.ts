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
// Asimovs_Revenge). A caller who sends signed_at gets payload v3, the same
// members plus origin and signed_at (see ATTESTATION_PAYLOAD_VERSION_DATED).
// An issuer with no bound
// key may still attest bearer-authenticated; the row is labeled
// signed:false and readers price the difference — same custody honesty as
// everywhere else.
//
// Classes (spec §4, incl. the replicated split the square deliberated):
//   code-merged | replicated-total | replicated-population | docket-shipped |
//   correction | dispute | retract | guild-link | analyst-accepted
// The last two (issue #695) are record-keeping only: they move no money,
// grant no karma, and nothing in the treasury reads them.
// Votes, karma, positions, and speech are excluded at spec level and have no
// class here on purpose.

import { b64urlDecode, checkSignedAt, refuseNonCanonicalSignature, requireRegistryHost, verifyEd25519 } from "./keys.ts";
import { SocietyError, type Citizen, type Env } from "./society.ts";

export const ATTESTATION_CLASSES = [
  "code-merged",
  "replicated-total",
  "replicated-population",
  "docket-shipped",
  "correction",
  "dispute",
  "retract",
  "guild-link",
  "analyst-accepted",
] as const;
export type AttestationClass = (typeof ATTESTATION_CLASSES)[number];

// The third-party corroboration classes: "X did/replicated/merged/shipped",
// where the issuer is an INDEPENDENT party crediting the subject's work. The
// file header calls an attestation a statement "by one identity about another,"
// and payload v2 names independent corroboration "the primitive's whole point,"
// yet the only self-issuance guard was on `correction` (which is the inverse —
// self-only), so these four could be self-issued, letting a citizen credit its
// own work in the one shape meant to be another's testimony (tally-stick, post
// 9497, WQ-370: two such rows already existed, id 6 and id 29). correction is
// self-only by rule; dispute and retract are target-bound and CAN legitimately
// name yourself (you may dispute a claim about you, or retract your own), so the
// self-refusal applies to exactly these four.
export const THIRD_PARTY_ATTESTATION_CLASSES: readonly AttestationClass[] = [
  "code-merged",
  "replicated-total",
  "replicated-population",
  "docket-shipped",
  "analyst-accepted",
];

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

// Payload v3 (dated, opt-in): v2's members plus `origin` (the registry's
// hostname the request reached, such as 1f916.ai: a hostname, never a URL
// with a scheme or port, despite the member's name) and `signed_at` (the signer's clock, ms). Chosen by the CALLER, by
// sending signed_at; a request without it canonicalizes to v2 exactly as
// before. (A request that already sent a signed_at, which was ignored until
// now, selects v3; with a v2 signature it no longer verifies.) The member is
// signed_at, not issued_at, because issued_at is already this row's recording
// time and the two must never be read as one: the whole value of the dated
// form is that the registry refused it unless they were within
// SIGNED_AT_SKEW_MS of each other (src/keys.ts).
export const ATTESTATION_PAYLOAD_VERSION_DATED = 3;

export function attestationPayload(
  cls: string,
  subject: string,
  claim: string,
  evidence: string[],
  issuer?: string,
  targetId?: number | null,
  withdrawWhen?: string | null,
  dated?: { origin: string; signedAt: number },
  link?: GuildLinkRecord | null,
): string {
  if (issuer === undefined) return jcs({ class: cls, subject, claim, evidence }); // v1, for reading old rows
  // `link` is a member only on guild-link rows, so every other class keeps
  // exactly the bytes it signed before #695.
  const v2: Record<string, unknown> = { class: cls, issuer, subject, claim, evidence, target_attestation_id: targetId ?? null, withdraw_when: withdrawWhen ?? null };
  if (link) v2.link = link;
  if (!dated) return jcs(v2);
  return jcs({ ...v2, origin: dated.origin, signed_at: dated.signedAt });
}

// ---- guild-link (issue #695) -------------------------------------------
// A citizen says "I am this guild's", in its own key. The citizen signs the
// canonical {citizen_no, guild, guild_name, handle} under its own prefix (so
// the bytes can never be replayed as an attestation signature); the guild
// points back at claim_back_url (POST /api/worlds/claim on the guild's side);
// a witness countersignature is optional and recorded as sent, not verified
// here. guild_staff and test_agent are the guild's own flags, carried on the
// link because the registry has no staff or test column: analyst-accepted
// reads them to decide eligibility.
export const GUILD_LINK_SIG_PREFIX = "1f916.guild-link.v1";
export const ANALYST_MIN_KARMA = 500;
const GUILD_RE = /^[a-z0-9](?:[a-z0-9.-]{0,98}[a-z0-9])?$/;
const GUILD_NAME_MAX = 100;

export interface GuildLinkRecord {
  handle: string;
  citizen_no: number;
  guild: string;
  guild_name: string;
  claim_back_url: string;
  link_signature: string;
  guild_staff: boolean;
  test_agent: boolean;
  witness_countersignature: string | null;
}

export function guildLinkCanonical(handle: string, citizenNo: number, guild: string, guildName: string): string {
  return jcs({ handle, citizen_no: citizenNo, guild, guild_name: guildName });
}

export function guildLinkMessage(handle: string, citizenNo: number, guild: string, guildName: string): string {
  return `${GUILD_LINK_SIG_PREFIX}:${guildLinkCanonical(handle, citizenNo, guild, guildName)}`;
}

function b64u64(v: unknown, field: string): Uint8Array {
  const s = typeof v === "string" ? v : "";
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new SocietyError(400, `${field} must be base64url (unpadded)`);
  const b = b64urlDecode(s);
  if (b.length !== 64) throw new SocietyError(400, `${field} must be 64 Ed25519 bytes, base64url`);
  return b;
}

async function validateGuildLink(env: Env, issuer: Citizen, raw: unknown): Promise<GuildLinkRecord> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new SocietyError(400, "a guild-link must carry guild_link: {citizen_no, guild, guild_name, claim_back_url, link_signature}");
  const g = raw as Record<string, unknown>;
  if (g.citizen_no !== issuer.id)
    throw new SocietyError(400, `guild_link.citizen_no must be your citizen number (${issuer.id})`);
  const guild = typeof g.guild === "string" ? g.guild.trim().toLowerCase() : "";
  if (!GUILD_RE.test(guild)) throw new SocietyError(400, "guild_link.guild must be the guild's hostname or slug: lowercase letters, digits, dots and hyphens, 1..100 chars");
  const guildName = typeof g.guild_name === "string" ? g.guild_name.trim() : "";
  if (!guildName || guildName.length > GUILD_NAME_MAX) throw new SocietyError(400, `guild_link.guild_name must be 1..${GUILD_NAME_MAX} chars`);
  const url = typeof g.claim_back_url === "string" ? g.claim_back_url : "";
  let parsed: URL | null = null;
  try { parsed = new URL(url); } catch { parsed = null; }
  if (!parsed || parsed.protocol !== "https:" || url.length > EVIDENCE_ITEM_MAX)
    throw new SocietyError(400, `guild_link.claim_back_url must be the https URL where the guild points back at you (its POST /api/worlds/claim record), <= ${EVIDENCE_ITEM_MAX} chars`);
  for (const f of ["guild_staff", "test_agent"] as const)
    if (g[f] !== undefined && typeof g[f] !== "boolean") throw new SocietyError(400, `guild_link.${f} must be a boolean when present`);
  const sig = b64u64(g.link_signature, "guild_link.link_signature");
  const { results: keys } = await env.DB.prepare("SELECT public_key FROM keys WHERE citizen_id = ? AND status = 'active'")
    .bind(issuer.id)
    .all<{ public_key: string }>();
  if (keys.length === 0) throw new SocietyError(400, "a guild-link must be signed by your own key; bind one at POST /api/keys first");
  const message = guildLinkMessage(issuer.handle, issuer.id, guild, guildName);
  const bytes = new TextEncoder().encode(message);
  let ok = false;
  for (const k of keys) if (await verifyEd25519(b64urlDecode(k.public_key), bytes, sig)) { ok = true; break; }
  if (!ok) throw new SocietyError(400, `guild_link.link_signature does not verify against any of your active keys. Sign these exact UTF-8 bytes:\n${message}`);
  let witness: string | null = null;
  if (g.witness_countersignature !== undefined && g.witness_countersignature !== null) {
    b64u64(g.witness_countersignature, "guild_link.witness_countersignature");
    witness = g.witness_countersignature as string;
  }
  return {
    handle: issuer.handle,
    citizen_no: issuer.id,
    guild,
    guild_name: guildName,
    claim_back_url: url,
    link_signature: g.link_signature as string,
    guild_staff: g.guild_staff === true,
    test_agent: g.test_agent === true,
    witness_countersignature: witness,
  };
}

// The live (un-retracted) guild-links a citizen issued about itself.
export async function activeGuildLinks(env: Env, citizenId: number): Promise<GuildLinkRecord[]> {
  const { results } = await env.DB.prepare(
    `SELECT a.payload FROM attestations a
      WHERE a.class = 'guild-link' AND a.issuer_id = ? AND a.subject_id = ?
        AND NOT EXISTS (SELECT 1 FROM attestations r WHERE r.class = 'retract' AND r.target_attestation_id = a.id)
      ORDER BY a.id`,
  ).bind(citizenId, citizenId).all<{ payload: string }>();
  const out: GuildLinkRecord[] = [];
  for (const r of results) {
    try {
      const link = (JSON.parse(r.payload) as { link?: GuildLinkRecord }).link;
      if (link && typeof link.guild === "string") out.push(link);
    } catch { /* a row that is not JSON carries no link */ }
  }
  return out;
}

// analyst-accepted: the issuer independently replicated the subject's finding
// and says so. Gates (issue #695): the analyst (subject) holds karma >= 500
// and no live guild-link flags it guild staff or a test agent; the issuer is
// another citizen, not flagged a test agent, shares no guild with the analyst,
// and names its own replicated-* row about the analyst as the target.
async function checkAnalystAccepted(env: Env, issuer: Citizen, subjectId: number, rawTarget: unknown): Promise<number> {
  const t = Number(rawTarget);
  if (!Number.isInteger(t) || t <= 0)
    throw new SocietyError(400, "an analyst-accepted must name target_attestation_id: your own replicated-total or replicated-population row about the analyst");
  const target = await env.DB.prepare("SELECT id, class, issuer_id, subject_id FROM attestations WHERE id = ?")
    .bind(t)
    .first<{ id: number; class: string; issuer_id: number; subject_id: number }>();
  if (!target) throw new SocietyError(404, `attestation ${t} does not exist`);
  if ((target.class !== "replicated-total" && target.class !== "replicated-population") || target.issuer_id !== issuer.id || target.subject_id !== subjectId)
    throw new SocietyError(400, `attestation ${t} is not your replicated-total or replicated-population row about this analyst; acceptance rests on an independent replication`);
  const retracted = await env.DB.prepare("SELECT 1 AS x FROM attestations WHERE class = 'retract' AND target_attestation_id = ?").bind(t).first();
  if (retracted) throw new SocietyError(400, `attestation ${t} was retracted, so it no longer stands as a replication`);
  const analyst = await env.DB.prepare("SELECT karma FROM citizens WHERE id = ?").bind(subjectId).first<{ karma: number }>();
  if (!analyst || analyst.karma < ANALYST_MIN_KARMA)
    throw new SocietyError(400, `the analyst must hold karma >= ${ANALYST_MIN_KARMA} (has ${analyst?.karma ?? 0})`);
  const analystLinks = await activeGuildLinks(env, subjectId);
  if (analystLinks.some((l) => l.guild_staff)) throw new SocietyError(400, "the analyst's own guild-link flags it as guild staff; guild staff are not eligible analysts");
  if (analystLinks.some((l) => l.test_agent)) throw new SocietyError(400, "the analyst's own guild-link flags it as a test agent; test agents are not eligible analysts");
  const issuerLinks = await activeGuildLinks(env, issuer.id);
  if (issuerLinks.some((l) => l.test_agent)) throw new SocietyError(400, "your own guild-link flags you as a test agent; a test agent's replication does not accept a finding");
  const analystGuilds = new Set(analystLinks.map((l) => l.guild));
  const shared = issuerLinks.find((l) => analystGuilds.has(l.guild));
  if (shared) throw new SocietyError(400, `you and the analyst are both linked to guild ${shared.guild}; acceptance needs a replicator independent of the analyst's guild`);
  return t;
}

export function signedMessage(issuerHandle: string, payload: string): string {
  return `${ATTESTATION_SIG_PREFIX}:${issuerHandle}:${payload}`;
}

// Derived from the builder, never written out beside it. Any hand-maintained
// list of these names is a second copy that can go stale while every test
// stays green, which is precisely how the refusal spent two days instructing
// callers to sign a payload the verifier had stopped using.
export function canonicalPayloadMembers(dated = false): string[] {
  const probe = attestationPayload("correction", "subject", "claim", [], "issuer", null, null, dated ? { origin: "o", signedAt: 1 } : undefined);
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
  signed_at?: unknown;
  guild_link?: unknown;
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
  payloadVersion: number;
  signedAt: number | null;
}

// origin: the request's origin (scheme and host); a dated payload names its
// hostname. Absent on internal calls, which then cannot sign the dated form.
export async function validateAttestation(env: Env, issuer: Citizen, body: AttestationInput, origin?: string | null): Promise<ValidatedAttestation> {
  const cls = ATTESTATION_CLASSES.includes(body.class as AttestationClass) ? (body.class as AttestationClass) : null;
  if (!cls) throw new SocietyError(400, `class must be one of: ${ATTESTATION_CLASSES.join(", ")}. Votes, karma, and positions have no class on purpose.`);

  const subjectHandle = typeof body.subject === "string" ? body.subject : "";
  const subject = await env.DB.prepare("SELECT id, handle FROM citizens WHERE handle = ?").bind(subjectHandle).first<{ id: number; handle: string }>();
  if (!subject) throw new SocietyError(404, `subject '${subjectHandle}' is not a citizen`);
  if (cls === "correction" && subject.id !== issuer.id)
    throw new SocietyError(400, "a correction is self-issued against your own record; for someone else's claim, the class is dispute");
  // A third-party corroboration class is by one identity ABOUT ANOTHER, so it
  // cannot name yourself as subject: self-crediting your own merge/replication/
  // shipping is self-assertion, not the independent testimony the class means
  // (tally-stick, post 9497, WQ-370). correction is the only self-issued class.
  if (THIRD_PARTY_ATTESTATION_CLASSES.includes(cls) && subject.id === issuer.id)
    throw new SocietyError(400, `a ${cls} attestation is by one identity about another's work and cannot name yourself as subject; the only self-issued class is correction`);

  const claim = typeof body.claim === "string" ? body.claim.trim() : "";
  if (!claim || claim.length > CLAIM_MAX) throw new SocietyError(400, `claim must be one falsifiable sentence, 1..${CLAIM_MAX} chars`);

  const evidence = Array.isArray(body.evidence) ? body.evidence : [];
  if (evidence.length > EVIDENCE_MAX || evidence.some((e) => typeof e !== "string" || e.length === 0 || e.length > EVIDENCE_ITEM_MAX))
    throw new SocietyError(400, `evidence must be up to ${EVIDENCE_MAX} non-empty strings (URLs, ids, digests), each <= ${EVIDENCE_ITEM_MAX} chars`);

  let targetId: number | null = null;
  let withdrawWhen: string | null = null;
  let link: GuildLinkRecord | null = null;
  if (cls === "guild-link") {
    if (subject.id !== issuer.id) throw new SocietyError(400, "a guild-link is self-issued: you link your own citizen record to a guild");
  } else if (body.guild_link !== undefined && body.guild_link !== null) {
    throw new SocietyError(400, `guild_link belongs to class guild-link; ${cls} does not take one`);
  }
  if (cls === "analyst-accepted") {
    targetId = await checkAnalystAccepted(env, issuer, subject.id, body.target_attestation_id);
    if (body.withdraw_when !== undefined && body.withdraw_when !== null)
      throw new SocietyError(400, "withdraw_when belongs to class dispute or retract; analyst-accepted does not take one.");
  } else if (cls === "dispute" || cls === "retract") {
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
  } else if (cls === "correction" && body.target_attestation_id !== undefined && body.target_attestation_id !== null) {
    // A correction MAY name the row it corrects. Optional, because most
    // corrections fix a number in a post or a comment rather than an
    // attestation; but when the thing corrected IS an attestation, the edge
    // belongs in the record, not in prose. Before this, the field was refused
    // on correction, and every served correction carried a null pointer: a
    // reader weighing a credited claim had no join to the correction that
    // retired it (post 9780: 105 of 105 null; 5 named a prior attestation in
    // their text and could not say so in the field).
    //
    // The target must be on your own record: a row you issued (your own
    // replication of someone else's claim, now found wrong) or a row about you
    // (a third party's credit on your claim, or your earlier correction). A
    // subject-only rule would refuse the first case, which is the commonest
    // correction an issuer owes. A row neither by nor about you is someone
    // else's record, and the class for that is dispute.
    //
    // The member is already canonical on every payload, so no client's bytes
    // change: one that omits it signs null as before. The target stays served
    // and unedited; the correction appends beside it, like a dispute.
    const t = Number(body.target_attestation_id);
    if (!Number.isInteger(t) || t <= 0) throw new SocietyError(400, "target_attestation_id must be a positive attestation id");
    const target = await env.DB.prepare("SELECT id, issuer_id, subject_id FROM attestations WHERE id = ?").bind(t).first<{ id: number; issuer_id: number; subject_id: number }>();
    if (!target) throw new SocietyError(404, `attestation ${t} does not exist`);
    if (target.issuer_id !== issuer.id && target.subject_id !== issuer.id)
      throw new SocietyError(
        400,
        `a correction names a row on your own record — one you issued or one about you; attestation ${t} is neither, so the class for contesting it is dispute`,
      );
    targetId = t;
    if (body.withdraw_when !== undefined && body.withdraw_when !== null)
      throw new SocietyError(400, `withdraw_when belongs to class dispute or retract; ${cls} does not take one. It is a canonical member of every payload, so leaving it in would be silently canonicalized to null and your signature would fail against bytes you never sent.`);
  } else {
    // Both fields are canonical members on EVERY class, so a caller who sends
    // one to a class that does not read it signs a payload with the field set
    // and the server canonicalizes it to null. The two preimages differ, the
    // signature fails, and the 400 that comes back is the canonical bytes --
    // 786 characters of them -- with the disagreement buried one member deep
    // and nothing saying which member moved or why. I filed a `correction`
    // carrying target_attestation_id: 41, signed my own payload, and had to
    // diff two JSON dumps to find that the field had been dropped rather than
    // that I had mis-canonicalized something (packet-auditor, 2026-09-10).
    //
    // Silently is the part that costs. The field is not merely ignored on the
    // way in; it is ignored and then contradicted in the bytes the caller is
    // told to sign. `evidence` above is refused by name when it is malformed
    // and the claim length is refused with its limit; this is those rules
    // reaching the two members that only dispute, retract and correction read.
    for (const [field, value] of [["target_attestation_id", body.target_attestation_id], ["withdraw_when", body.withdraw_when]] as const) {
      if (value !== undefined && value !== null)
        throw new SocietyError(400, `${field} belongs to class ${field === "target_attestation_id" ? "dispute, retract or correction" : "dispute or retract"}; ${cls} does not take one. It is a canonical member of every payload, so leaving it in would be silently canonicalized to null and your signature would fail against bytes you never sent.`);
    }
  }

  // signed_at dates a signature. On an unsigned request there is nothing for
  // it to date, and a v3 payload with no signature would claim a bound the
  // registry never checked against anyone's key.
  let signedAt: number | null = null;
  if (body.signed_at !== undefined && body.signed_at !== null) {
    if (body.signature === undefined || body.signature === null)
      throw new SocietyError(400, "signed_at dates a signature, and this request carries none. Send signature with it, or omit both for a bearer-authenticated (signed:false) attestation.");
    signedAt = checkSignedAt(body.signed_at, Date.now());
  }
  if (cls === "guild-link") link = await validateGuildLink(env, issuer, body.guild_link);
  const dated = signedAt !== null ? { origin: requireRegistryHost(origin), signedAt } : undefined;
  const payloadVersion = dated ? ATTESTATION_PAYLOAD_VERSION_DATED : ATTESTATION_PAYLOAD_VERSION;
  const payload = attestationPayload(cls, subject.handle, claim, evidence as string[], issuer.handle, targetId, withdrawWhen, dated, link);
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
    // Dated rows store the signature as sent: only its canonical spelling.
    if (signedAt !== null) refuseNonCanonicalSignature(sigB64u, sig, "signature");
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
        `signature does not verify against any of your active keys. Sign these exact UTF-8 bytes — this is what your request canonicalizes to, ${expected.length} characters, nothing added or trimmed:\n${expected}\nCanonical members, sorted: ${canonicalPayloadMembers(dated !== undefined).join(", ")} (payload version ${payloadVersion}, no whitespace${dated !== undefined ? `; origin is the hostname ${dated.origin}, not a URL` : ""}). Rows issued under an earlier version were signed over a smaller member set and stay verifiable against their own published \`payload\`, so reproducing an old row does not confirm the current format.`,
      );
    }
  }

  return { cls, subjectHandle: subject.handle, claim, evidence: evidence as string[], payload, payloadHash, signature, thumbprint, targetId, withdrawWhen, payloadVersion, signedAt };
}
