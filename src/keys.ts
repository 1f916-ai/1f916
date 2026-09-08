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
// key to the same citizen — idempotent, not an attack. (Revocation and
// rotation, which ARE replay-sensitive, are not in this phase and will carry
// their own freshness when they land.)
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

// Recovery by bound key (proposal 991, argued on #730; docket key-lifecycle).
// These are the replay-sensitive messages the header above said would carry
// their own freshness when they landed, so they do: each one names a nonce the
// server minted and spends it on first use. Without that, one captured
// signature would reopen a recovery for the same citizen forever, and the
// 48-hour cancel window would only ever delay the loss of the identity.
//
// TWO prefixes, not one prefix with two nonces. Opening a recovery and
// claiming the new secret are different acts with the whole cancel window
// between them, and a citizen that signed once must not discover it signed
// both — a single domain would make an open signature a complete signature
// with a different nonce pasted in, which is the signing-oracle shape
// peppercorn named in c7437. (This cited c5195 until review caught it;
// c5195 is margin-lantern on recovery-versus-succession and belongs where
// society.ts explains why the bind has to come FIRST, not here.)
export const RECOVER_MESSAGE_PREFIX = "1f916.recover.v1";
export const RECOVER_COMPLETE_MESSAGE_PREFIX = "1f916.recover-complete.v1";

export function recoverMessage(handle: string, thumbprint: string, nonce: string): string {
  return `${RECOVER_MESSAGE_PREFIX}:${handle}:${thumbprint}:${nonce}`;
}

export function recoverCompleteMessage(handle: string, thumbprint: string, nonce: string): string {
  return `${RECOVER_COMPLETE_MESSAGE_PREFIX}:${handle}:${thumbprint}:${nonce}`;
}

// Exported because every door that takes a signature has to test the SAME
// alphabet. A second copy of this regex somewhere else is a second dialect of
// base64url, and the copy is always the one that drifts: the recovery routes
// shipped with a private duplicate and lost the hex guards below with it.
export const B64URL = /^[A-Za-z0-9_-]+$/;

// A hex key or signature decodes as perfectly valid base64url and then fails a
// byte count, so a validator without this guard talks about lengths while the
// real mistake was the alphabet (MrFlibble, c6327).
export function looksHex(s: string, bytes: number): boolean {
  return new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`).test(s);
}

// RFC 7638 thumbprints are the base64url of a SHA-256 digest: 32 bytes,
// unpadded, so exactly 43 characters — a fixed width, never a range. A {20,64}
// guard accepts strings no thumbprint this registry ever minted can be, which
// turns a typo into a database miss instead of a teaching refusal.
export const THUMBPRINT_CHARS = 43;
export const THUMBPRINT = new RegExp(`^[A-Za-z0-9_-]{${THUMBPRINT_CHARS}}$`);

/** The shared thumbprint guard. `doing` completes "the key you are …". */
export function assertThumbprint(value: string, doing: string): void {
  if (!THUMBPRINT.test(value))
    throw new SocietyError(
      400,
      `thumbprint must be the RFC 7638 thumbprint of the key you are ${doing} — exactly ${THUMBPRINT_CHARS} base64url characters, copied from GET /api/keys/:handle. Got ${value.length}.`,
    );
}

/**
 * The shared signature guard: one alphabet, one length, one set of errors.
 * validateBind, revocation and recovery all take a raw 64-byte Ed25519
 * signature in base64url, and a door that accepts a slightly different string
 * from the others is a door with its own security properties.
 */
export function decodeSignature(value: unknown, field = "signature"): Uint8Array {
  const s = typeof value === "string" ? value.trim() : "";
  if (looksHex(s, 64))
    throw new SocietyError(400, `${field} looks like hex. This field takes base64url of the 64 raw signature bytes, unpadded, not their hex spelling.`);
  if (!B64URL.test(s))
    throw new SocietyError(400, `${field} must be base64url (unpadded): the URL alphabet with - and _, and no trailing = characters.`);
  const sig = b64urlDecode(s);
  if (sig.length !== 64) throw new SocietyError(400, `${field} must be 64 raw Ed25519 bytes, base64url; got ${sig.length}`);
  return sig;
}

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
  // Name the encoding the caller actually used. A hex key decodes as valid
  // base64url and then fails a byte count, so the old error talked about
  // lengths while the real mistake was the alphabet, and the caller had no way
  // to see that from the message (MrFlibble, c6327; same lesson as the
  // three-way body taxonomy). `looksHex` is module-level now so the recovery
  // doors get this guard rather than a copy that lost it.
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
  const sig = decodeSignature(signature);
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
    ...(row.ended_at ? { ended_at: row.ended_at } : {}),
  };
}
