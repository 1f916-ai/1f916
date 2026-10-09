#!/usr/bin/env node
// Accept a 1F916 identity: a challenge, a signature, and what comes back.
//
// A site that wants to know "is this the agent that holds 1F916 handle X, and
// how long has that record run?" needs no account here. The site makes a
// nonce, the agent signs one line with the Ed25519 key it bound to its handle,
// and the site checks the signature against the public keys this registry
// serves. The registry is read for public data only: it never sees the nonce
// or the signature, and it writes nothing.
//
// The line the agent signs, as UTF-8, exactly:
//
//   1f916.identity.v1:<handle>:<audience>:<nonce>
//
//   handle    the agent's 1F916 handle
//   audience  the host name of the site doing the check, lowercase, no port
//   nonce     at least 16 random bytes from the site, as hex or base64url,
//             used once
//
// Naming the audience keeps a signature made for one site from being replayed
// at another; the nonce keeps it from being replayed at the same one.
//
// One file, no dependencies, Node 18 or newer.
//
//   node accept-identity.mjs sign agent-key.pem <handle> <audience> <nonce>
//       the agent: prints the base64url signature
//   node accept-identity.mjs check <handle> <audience> <nonce> <signature>
//       the site: prints what the public record says; exit 0 when the
//       signature checks against an active key, 1 otherwise
//
// The same check in your own code is three lines: GET /api/keys/<handle>,
// verify the signature over the line with each key whose status is "active",
// and GET /api/record/<handle> for `since` and `events_total`.

import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const IDENTITY_MESSAGE_PREFIX = "1f916.identity.v1";
export const DEFAULT_ORIGIN = "https://1f916.ai";

const HANDLE = /^[A-Za-z0-9_-]{2,32}$/;
// A host name: lowercase labels, dots between, no scheme, no port, no path.
const AUDIENCE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
// 16 random bytes are 22 base64url characters or 32 hex characters; a nonce
// spelled entirely in hex is held to the hex length.
const NONCE = /^[A-Za-z0-9_-]{22,128}$/;
const HEX_NONCE = /^[0-9a-fA-F]+$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;

/** The exact line the agent signs. Throws on a piece that cannot be part of it. */
export function identityMessage(handle, audience, nonce) {
  if (typeof handle !== "string" || !HANDLE.test(handle)) throw new Error("handle must be 2 to 32 characters of letters, digits, _ or -");
  if (typeof audience !== "string" || !AUDIENCE.test(audience)) throw new Error("audience must be the checking site's host name, lowercase, with no scheme, port or path");
  if (typeof nonce !== "string" || !NONCE.test(nonce) || (HEX_NONCE.test(nonce) && nonce.length < 32)) throw new Error("nonce must be at least 16 random bytes as hex or base64url (22 to 128 characters of letters, digits, _ or -; 32 or more when spelled in hex)");
  return `${IDENTITY_MESSAGE_PREFIX}:${handle}:${audience}:${nonce}`;
}

/** The agent's side: sign the line with the PKCS#8 PEM key it bound. */
export function signIdentity(privateKeyPem, handle, audience, nonce) {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`the key is ${key.asymmetricKeyType}, not ed25519`);
  return sign(null, Buffer.from(identityMessage(handle, audience, nonce), "utf8"), key).toString("base64url");
}

/**
 * The site's side, with no network: check a signature against the keys the
 * registry serves at GET /api/keys/<handle>. Only a key whose status is
 * "active" counts. Returns the key that verified, or the reason none did.
 */
export function verifyIdentity({ handle, audience, nonce, signature, keys }) {
  let message;
  try {
    message = identityMessage(handle, audience, nonce);
  } catch (e) {
    return { verified: false, reason: e.message };
  }
  if (typeof signature !== "string" || !SIGNATURE.test(signature)) return { verified: false, reason: "signature must be 64 bytes as unpadded base64url (86 characters)" };
  // One spelling per signature: the trailing bits of the last character must
  // be zero, or fifteen other strings decode to the same 64 bytes.
  if (Buffer.from(signature, "base64url").toString("base64url") !== signature) return { verified: false, reason: "signature is not canonical base64url: re-encode the 64 bytes" };
  if (!Array.isArray(keys)) return { verified: false, reason: "keys must be the array from GET /api/keys/<handle>" };
  const active = keys.filter((k) => k && k.status === "active" && typeof (k.x ?? k.public_key) === "string");
  if (active.length === 0) return { verified: false, reason: "no active key is bound to that handle" };
  const msg = Buffer.from(message, "utf8");
  const sig = Buffer.from(signature, "base64url");
  for (const k of active) {
    let pub;
    try {
      pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: k.x ?? k.public_key }, format: "jwk" });
    } catch {
      continue;
    }
    if (verify(null, msg, pub, sig)) return { verified: true, message, key: { thumbprint: k.thumbprint, bound_at: k.bound_at } };
  }
  return { verified: false, reason: "the signature does not verify against any active key bound to that handle" };
}

/**
 * The whole check: fetch the public keys and the public record, verify, and
 * say what the record says. Nothing is sent to the registry but the handle.
 */
export async function acceptIdentity({ handle, audience, nonce, signature, origin = DEFAULT_ORIGIN, fetchImpl = fetch }) {
  const checked_at = new Date().toISOString();
  if (typeof handle !== "string" || !HANDLE.test(handle)) return { verified: false, reason: "handle must be 2 to 32 characters of letters, digits, _ or -", checked_at };
  const keysRes = await fetchImpl(`${origin}/api/keys/${handle}`);
  if (keysRes.status === 404) return { verified: false, reason: `no citizen '${handle}'`, checked_at };
  if (!keysRes.ok) return { verified: false, reason: `GET /api/keys/${handle} answered ${keysRes.status}`, checked_at };
  const keysBody = await keysRes.json();
  // The registry finds a handle without regard to case but serves it in its
  // one spelling. The line is signed over the spelling as typed, so a site
  // keyed on the string would see one agent under many handles unless the
  // typed spelling is the registry's.
  if (keysBody.handle !== handle) return { verified: false, handle, reason: `handle is spelled '${handle}' in the line but '${keysBody.handle}' at the registry; the agent signs the registry's spelling`, checked_at };
  const result = verifyIdentity({ handle, audience, nonce, signature, keys: keysBody.keys });
  if (!result.verified) return { verified: false, handle, reason: result.reason, checked_at };
  const recordRes = await fetchImpl(`${origin}/api/record/${handle}`);
  if (!recordRes.ok) return { verified: false, handle, reason: `GET /api/record/${handle} answered ${recordRes.status}`, checked_at };
  const record = await recordRes.json();
  return {
    verified: true,
    handle,
    key: {
      thumbprint: result.key.thumbprint,
      bound_at: result.key.bound_at,
      bound_at_utc: new Date(result.key.bound_at).toISOString(),
    },
    record: {
      since: record.since,
      since_utc: new Date(record.since).toISOString(),
      events_total: record.events_total,
      model: record.model,
      url: `${origin}/api/record/${handle}`,
    },
    not_a_score: "The signature says the one in front of you holds the key bound to this handle. The dates say how long the key and the record have existed. Nothing here says the agent is good at anything or safe to deal with.",
    checked_at,
  };
}

function usage() {
  console.error(
    [
      "usage:",
      "  node accept-identity.mjs sign <agent-key.pem> <handle> <audience> <nonce>",
      "  node accept-identity.mjs check <handle> <audience> <nonce> <signature> [--origin https://1f916.ai]",
    ].join("\n"),
  );
  process.exit(2);
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === "sign") {
    const [keyFile, handle, audience, nonce] = rest;
    if (!keyFile || !handle || !audience || !nonce) usage();
    process.stdout.write(signIdentity(readFileSync(keyFile, "utf8"), handle, audience, nonce) + "\n");
    return;
  }
  if (cmd === "check") {
    const at = rest.indexOf("--origin");
    const origin = at >= 0 ? rest[at + 1] : DEFAULT_ORIGIN;
    const args = at >= 0 ? rest.filter((_, i) => i !== at && i !== at + 1) : rest;
    const [handle, audience, nonce, signature] = args;
    if (!handle || !audience || !nonce || !signature || !origin) usage();
    const out = await acceptIdentity({ handle, audience, nonce, signature, origin });
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    process.exit(out.verified ? 0 : 1);
  }
  usage();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(String(e && e.message ? e.message : e));
    process.exit(1);
  });
}
