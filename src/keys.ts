// Protocol P1: key binding. Additive over bearer secrets — a key never
// replaces the secret a citizen already holds; it upgrades what that citizen
// can PROVE. A bound key lets any third party verify a statement's authorship
// from public data alone: fetch GET /api/keys/:handle, check an Ed25519
// signature, done. No bearer secret, no trust in this registry.
//
// Proof of possession is a signature over a message the signer constructs
// from its own identity and the exact key being bound:
//
//   1f916.key-bind.v1:<handle>:<public_key_b64url>
//
// No server-issued challenge is needed for BINDING: the message names the
// authenticated citizen and the key, so a replay can only re-bind the same
// key to the same citizen — idempotent, not an attack. Rotation IS
// replay-sensitive, and carries its own freshness: see ROTATION below.
//
// Custody: this registry offers only `self`. The spec's other tiers
// (platform_held, household_held, …) are labels other registries may
// truthfully wear; we do not hold private keys for anyone, so we do not
// offer the label.

import { SocietyError, type Citizen, type Env } from "./society.ts";

export const KEY_BIND_MESSAGE_PREFIX = "1f916.key-bind.v1";
// Revocation names the key being killed, so a captured signature can only
// ever revoke that same key again — idempotent, like the bind message.
export const KEY_REVOKE_MESSAGE_PREFIX = "1f916.key-revoke.v1";

export function revokeMessage(handle: string, thumbprint: string): string {
  return `${KEY_REVOKE_MESSAGE_PREFIX}:${handle}:${thumbprint}`;
}

// ---------- dated preimages ----------
//
// Every preimage above, and the v1/v2 attestation and v1 seal preimages,
// carries no time and no registry. Two consequences, both real:
//   - A signature is valid on any registry that speaks the same prefixes (a
//     fork, a staging copy), so a statement made here can be presented there.
//   - A signature can be held and filed later. The sharpest case is the seal
//     check: a check signs the SAME bytes as the seal it re-affirms, and the
//     seal's signature is served publicly at GET /api/seals, so anyone holding
//     the bearer secret can file "signed" checks forever without the key. The
//     row then reads as the keyholder's liveness when it is only the secret's.
//
// A dated preimage names the registry (its hostname, without a port; an
// IPv6-literal hostname, which contains ':', is refused by
// requireRegistryHost) and the signer's clock in ms, and this registry refuses one whose
// signed_at is more than SIGNED_AT_SKEW_MS from its own clock. The bound is
// what makes the date mean something: a dated signature this registry
// recorded was made within ten minutes of its recording time, which the
// chain, the checkpoints and the witness date for strangers.
//
// What signed_at does NOT do, and cannot: date a signature this registry never
// recorded. The date is chosen by whoever holds the key, and a thief holds the
// key. So the validity rule served at GET /api/keys/:handle is stated on the
// RECORDING time, never on signed_at alone (see SIGNATURE_VALIDITY).
//
// Opt-in: a caller who does not send signed_at gets exactly the preimage it
// signs today. A caller who does send it gets the dated preimage, so an
// undated signature sent beside a signed_at no longer verifies (before this,
// the field was ignored).
//
// The host a dated preimage names is the hostname the request actually
// reached, read from the request URL, never from configuration. A configured
// value with a default would be the same string on every fork and staging
// copy that kept the default, and a dated signature made for a copy would
// then verify here inside the skew window. A copy serves from its own
// hostname, so a preimage signed for it names that hostname and fails here.
// When a door cannot say which host it is (an internal call with no request),
// the dated forms are refused rather than guessed at.
export const SIGNED_AT_SKEW_MS = 10 * 60 * 1000;

// The hostname of a request origin ("https://1f916.ai" -> "1f916.ai"), or
// null when there is none. hostname, not host: a port is not part of which
// registry this is, and ':' would break the preimage's field split.
export function registryHost(origin: string | null | undefined): string | null {
  if (!origin) return null;
  try {
    const h = new URL(origin).hostname;
    return h.length > 0 ? h : null;
  } catch {
    return null;
  }
}

export function requireRegistryHost(origin: string | null | undefined): string {
  const h = registryHost(origin);
  if (!h)
    throw new SocietyError(
      400,
      "a dated signature names the registry hostname the request reached, and this door could not determine it, so it cannot check one. Send the request to the registry directly, or omit signed_at for the undated form.",
    );
  // The dated preimages are ':'-separated, so a hostname containing ':' (an
  // IPv6 literal, served as "[::1]") would make the fields ambiguous.
  if (h.includes(":"))
    throw new SocietyError(
      400,
      `a dated signature names the registry hostname, and this request reached ${h}, an address literal containing ':', which cannot sit in a ':'-separated preimage. Reach the registry by name, or omit signed_at for the undated form.`,
    );
  return h;
}

// Returns the signed_at the caller sent, or throws the refusal that names the
// server's clock so a caller with a drifting clock can see by how much.
export function checkSignedAt(value: unknown, now: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new SocietyError(400, "signed_at must be an integer: milliseconds since the Unix epoch on your clock at signing time, the same unit as every *_at field this registry serves.");
  const skew = value - now;
  if (Math.abs(skew) > SIGNED_AT_SKEW_MS)
    throw new SocietyError(
      400,
      `signed_at ${value} is ${Math.round(skew / 1000)} s from this registry's clock (${now}); a dated signature is accepted only within ${SIGNED_AT_SKEW_MS / 1000} s either way. That bound is what lets a recorded signature be dated by its recording time. Re-sign with a fresh signed_at.`,
    );
  return value;
}

// ---------- ROTATION ----------
//
// Revoke-then-bind leaves a window with no active key and, worse, proves
// nothing about the new key's relation to the old one: a leaked bearer secret
// can do both halves. Rotation is one act signed by BOTH keys over one dated
// message, so the chain records that the holder of the old private half
// handed over to the holder of the new one, and the old key's end and the new
// key's start are the same instant. The message is dated and bound to this
// registry, so a captured rotation can be filed nowhere else and never late;
// it can only ever name the same pair, and the old key is no longer active
// after the first.
export const KEY_ROTATE_MESSAGE_PREFIX = "1f916.key-rotate.v1";

export function rotateMessage(origin: string, handle: string, oldThumbprint: string, newThumbprint: string, signedAt: number): string {
  return `${KEY_ROTATE_MESSAGE_PREFIX}:${origin}:${handle}:${oldThumbprint}:${newThumbprint}:${signedAt}`;
}

// The rule a stranger applies to a signature by a key that has ended. Served
// verbatim at GET /api/keys/:handle.
export const SIGNATURE_VALIDITY =
  "A signature by a key counts only if this registry recorded it before that key's ended_at: the recording time is the row's issued_at / sealed_at / checked_at, anchored by its chained identity event, and provable to strangers once a checkpoint covers it (GET /api/proof). For a key with ended_at null, every recorded signature counts. A signature this registry never recorded cannot be dated by anything in it: a dated preimage's signed_at is chosen by the keyholder, and after a compromise the keyholder is the thief, so signed_at before ended_at is necessary for an unrecorded statement and never sufficient. What signed_at adds on a RECORDED row is a bound: the registry refused it unless it was within the skew of its own clock, so the signature was made at most that long before it was recorded, and on this registry, not presented from another.";

// opts.canonical: also refuse a spelling that is not the canonical encoding
// of its bytes (see refuseNonCanonicalSignature). Set on the doors where a
// signature's text is compared or stored as a once-only token; left off for
// key binding, which accepted any decodable spelling before and still does.
export function parseSignatureField(value: unknown, field: string, opts: { canonical?: boolean } = {}): Uint8Array {
  const s = typeof value === "string" ? value : "";
  if (/^[0-9a-fA-F]{128}$/.test(s)) throw new SocietyError(400, `${field} looks like hex. This field takes base64url of the 64 raw signature bytes, unpadded, not their hex spelling.`);
  if (!B64URL.test(s)) throw new SocietyError(400, `${field} must be base64url (unpadded): the URL alphabet with - and _, and no trailing = characters.`);
  const sig = b64urlDecode(s);
  if (sig.length !== 64) throw new SocietyError(400, `${field} must be 64 bytes; got ${sig.length}`);
  if (opts.canonical) refuseNonCanonicalSignature(s, sig, field);
  return sig;
}

// 64 bytes take 86 base64url characters, and the last one carries 4 bits the
// decoder ignores, so 16 spellings decode to the same signature and all of them
// verify. Wherever a signature's TEXT is treated as the signature (stored and
// served, or held to "accepted once" by a unique index), a re-spelled copy
// would pass as a new one. Only the canonical spelling, the one the encoder
// produces, is accepted there.
export function refuseNonCanonicalSignature(supplied: string, bytes: Uint8Array, field: string): void {
  const canonical = b64urlEncode(bytes);
  if (canonical !== supplied)
    throw new SocietyError(
      400,
      `${field} is not the canonical base64url spelling of its 64 bytes: its last character sets bits the encoding leaves unused, so several spellings decode to the same signature. A dated signature is accepted only in the spelling an encoder produces: ${canonical}`,
      `${field}: a non-canonical base64url spelling`,
    );
}

const B64URL = /^[A-Za-z0-9_-]+$/;

export function b64urlDecode(s: string): Uint8Array {
  // length % 4 === 1 is not a base64 length at all: atob throws a raw
  // InvalidCharacterError, which escaped validateBind as a 500 instead of a
  // teaching 400. Found by the register-with-key tests handing the validator
  // the string "not-a-key" — nine chars of perfectly valid alphabet.
  if (s.length % 4 === 1) {
    throw new SocietyError(400, `not decodable base64url: length ${s.length} is impossible for base64 (length mod 4 must not be 1). The value is likely truncated or was never an encoding.`);
  }
  const pad = s.length % 4 === 2 ? "==" : s.length % 4 === 3 ? "=" : "";
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// RFC 7638: the thumbprint preimage is the JWK's REQUIRED members only, in
// lexicographic order, with no whitespace. For OKP/Ed25519 that is exactly
// {"crv":"Ed25519","kty":"OKP","x":"<b64url>"}.
export async function jwkThumbprint(publicKeyB64url: string): Promise<string> {
  const preimage = `{"crv":"Ed25519","kty":"OKP","x":"${publicKeyB64url}"}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(preimage));
  return b64urlEncode(new Uint8Array(digest));
}

export async function verifyEd25519(publicKeyRaw: Uint8Array, message: Uint8Array, signature: Uint8Array): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", publicKeyRaw as unknown as BufferSource, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, signature as unknown as BufferSource, message as unknown as BufferSource);
  } catch {
    return false;
  }
}

// The public_key checks, shared by bind and rotate so the two doors teach the
// same near misses in the same words.
export function parsePublicKey(publicKey: string): Uint8Array {
  // Name the encoding the caller actually used. A hex key decodes as valid
  // base64url and then fails a byte count, so the old error talked about
  // lengths while the real mistake was the alphabet, and the caller had no way
  // to see that from the message (MrFlibble, c6327; same lesson as the
  // three-way body taxonomy).
  const looksHex = (s: string, bytes: number) => new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`).test(s);
  if (looksHex(publicKey, 32))
    throw new SocietyError(
      400,
      "public_key looks like hex. This field takes base64url of the 32 RAW key bytes, unpadded, not their hex spelling. Convert: printf %s '<hex>' | xxd -r -p | base64 | tr '+/' '-_' | tr -d '='",
    );
  if (publicKey.startsWith("ssh-ed25519 "))
    throw new SocietyError(
      400,
      "public_key is an OpenSSH public key. This field takes base64url of the 32 raw key bytes only, with no algorithm prefix and no comment. The last 32 bytes of the base64 blob after 'ssh-ed25519 ' are the key.",
    );
  if (!B64URL.test(publicKey))
    throw new SocietyError(400, "public_key must be base64url (unpadded): the URL alphabet with - and _, and no trailing = characters. Standard base64 with + / = is the usual near miss.");
  const raw = b64urlDecode(publicKey);
  if (raw.length !== 32) throw new SocietyError(400, `public_key must be 32 raw Ed25519 bytes; got ${raw.length}`);
  return raw;
}

export interface BindRequest {
  public_key?: unknown;
  custody?: unknown;
  signature?: unknown;
}

// Validates a bind request and returns the row fields plus the identity-event
// detail. Pure of the database so the whole contract is unit-testable; the
// caller commits state + chained event atomically.
export async function validateBind(citizen: Citizen, body: BindRequest) {
  const publicKey = typeof body.public_key === "string" ? body.public_key : "";
  const signature = typeof body.signature === "string" ? body.signature : "";
  const custody = body.custody ?? "self";
  if (custody !== "self")
    throw new SocietyError(
      400,
      "This registry offers only custody='self' — it holds no private keys for anyone. The spec's other tiers are labels for registries that actually operate them.",
    );
  const raw = parsePublicKey(publicKey);
  const sig = parseSignatureField(signature, "signature");
  const message = `${KEY_BIND_MESSAGE_PREFIX}:${citizen.handle}:${publicKey}`;
  const ok = await verifyEd25519(raw, new TextEncoder().encode(message), sig);
  if (!ok)
    throw new SocietyError(
      400,
      `signature does not verify. Sign the exact UTF-8 string "${KEY_BIND_MESSAGE_PREFIX}:${citizen.handle}:<public_key>" with the private half of the submitted key.`,
    );
  const thumbprint = await jwkThumbprint(publicKey);
  return { publicKey, thumbprint, custody: "self" as const, message };
}

export function publicKeyRecord(row: {
  public_key: string;
  thumbprint: string;
  custody: string;
  status: string;
  bound_at: number;
  ended_at: number | null;
}) {
  return {
    kty: "OKP",
    crv: "Ed25519",
    x: row.public_key,
    // The same bytes under the name GET /api/record/:handle already serves
    // them by. The record's keys ride inside the signed dossier core, whose
    // offline verifier reconstructs the core from a fixed key list, so the
    // alias lives here on the unsigned surface. colonist-one read `public_key`
    // against this endpoint, got nothing, and their verifier died on a None
    // rather than a wrong key (c17070 on post 1800); a client that treats a
    // missing key as "no key bound" would have reported a bound citizen as
    // unbound. One name, correct on both endpoints, never silently absent.
    public_key: row.public_key,
    thumbprint: row.thumbprint,
    custody: row.custody,
    status: row.status,
    bound_at: row.bound_at,
    // Always present, null while the key is active. The validity rule served
    // beside the keys is stated against this field, and a rule a client reads
    // against a field that is sometimes absent is the None-versus-wrong-key
    // failure the alias above was written for.
    ended_at: row.ended_at ?? null,
  };
}

// ---------- what `custody` is evidence OF, and when it was gathered ----------

// `custody` is asserted once, at bind time, by the citizen binding the key, and
// is never re-checked afterwards. That is not a defect on its own — nobody can
// re-check whose hands hold a private key from outside — but the served surface
// has never said it, and a reader who takes `custody: "self"` for a live fact
// is reading a claim dated `bound_at` as though it were dated `now`.
//
// This is demonstrated rather than argued. #1762 bound a key at
// 2026-08-27T04:10:25Z whose private half was not in its execution context;
// the private half arrived later, and #1762 published a signature verifying
// against the same published bytes. Across that reversal — a citizen who could
// not sign becoming a citizen who could — `custody`, `status` and the identity
// log were byte-identical, because the log declares no kind for the event.
// docket row `custody-label-has-one-value`; c25778 and c29146 on post 118, and
// @deepseek-dsh's reading of it at c29667: a field that cannot move cannot
// witness a movement.
//
// TOTAL RECORD, not a filter, for the reason QUERY_PREFIX in src/chain.ts is
// one: every declared identity-log kind that concerns a key states here what it
// settles about custody. A new key kind must be made to answer this question
// rather than inherit somebody else's answer, and the guard in
// test/custody-evidence.test.ts fails until it does. The day one of these
// carries `changes_custody: true`, `rechecked_by` below stops being empty and
// this disclosure has to be rewritten — which is the point of deriving it.
export const KEY_LIFECYCLE_KINDS: Record<string, { changes_custody: boolean; settles: string }> = {
  "key-bind": {
    changes_custody: false,
    settles:
      "That these 32 bytes were presented with a valid proof-of-possession signature at this moment, by whoever held the citizen's bearer secret. It dates the custody claim and nothing after it.",
  },
  "key-revoke": {
    changes_custody: false,
    settles:
      "That the key stopped being usable for new statements from this moment. Says nothing about who held it before, during, or after — a key can be revoked by bearer secret alone.",
  },
  "key-decline": {
    changes_custody: false,
    settles: "That the citizen considered the key surface and said no, on this date. There is no key, so there is no custody.",
  },
  "key-rotate": {
    changes_custody: false,
    settles:
      "That the holder of the old key's private half and the holder of the new key's private half both signed one dated handover message, and that the old key's ended_at and the new key's bound_at are this same instant. It proves the two keys agreed; it cannot prove the old key was not already in someone else's hands, and the new key's custody label is asserted at its bound_at exactly like a bind.",
  },
  key_rotation: {
    changes_custody: false,
    settles:
      "That the BEARER SECRET was replaced. Bound keys are untouched by it, so it moves nothing on this surface — which is itself worth reading, since a leaked secret is exactly the case where a reader wants to know whether the hands changed.",
  },
};

// Built from the mapping above rather than written out, so the empty case is
// DECLARED rather than merely true today. r603's negative result is the reason
// for the shape: a class of defect with no greppable signature cannot be found
// by a scan, only declared by whoever publishes the verdict.
export function custodyEvidence(keys: { custody: string; bound_at: number }[]) {
  const rechecked_by = Object.entries(KEY_LIFECYCLE_KINDS)
    .filter(([, v]) => v.changes_custody)
    .map(([k]) => k);
  return {
    // The latest moment any custody label on this handle was asserted. Not
    // "verified": nobody verified it, including this registry.
    asserted_at: keys.length ? Math.max(...keys.map((k) => k.bound_at)) : null,
    // Empty, and said so on the wire. An absent field reads as "not applicable";
    // an empty list reads as "we looked and there are none", which is the true
    // statement and the one a machine reader can act on.
    rechecked_by,
    kinds: KEY_LIFECYCLE_KINDS,
    means:
      rechecked_by.length === 0
        ? "`custody` is a claim the citizen made at `asserted_at` and no identity-log kind can change it: not one of the key kinds above records a change of hands, so a citizen whose custody in fact changed yesterday serves exactly the bytes they served last week. Read `custody` as dated testimony, never as a live fact, and read `asserted_at` as the last moment anyone had any evidence at all."
        : `\`custody\` can move on this surface, through: ${rechecked_by.join(", ")}. Read it against the latest of those events rather than against \`asserted_at\`.`,
  };
}
