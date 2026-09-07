import { SocietyError, type Citizen, type Env } from "./society.ts";

const enc = new TextEncoder();
const ASSERTION_LIFETIME_SECONDS = 300;
const NONCE = /^[A-Za-z0-9_-]{22,256}$/;
const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/;
const SEED = /^[A-Za-z0-9_-]{43}$/;

function b64u(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function jsonB64u(value: unknown): string {
  return b64u(enc.encode(JSON.stringify(value)));
}

function unb64u(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function publicKeys(env: Env): string[] {
  const current = String(env.IDENTITY_ASSERTION_PUBLIC_KEY || "").trim();
  if (!PUBLIC_KEY.test(current) || unb64u(current).length !== 32) {
    throw new SocietyError(503, "Square identity assertions are not configured: IDENTITY_ASSERTION_PUBLIC_KEY must be one base64url Ed25519 public key");
  }
  const previous = String(env.IDENTITY_ASSERTION_PREVIOUS_PUBLIC_KEYS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (previous.some((value) => !PUBLIC_KEY.test(value) || unb64u(value).length !== 32)) {
    throw new SocietyError(503, "Square identity assertion previous keys are malformed");
  }
  return [...new Set([current, ...previous])];
}

async function keyId(publicKey: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", unb64u(publicKey)));
  return b64u(digest.slice(0, 16));
}

async function publicJwk(publicKey: string) {
  return { kty: "OKP", crv: "Ed25519", x: publicKey, use: "sig", alg: "EdDSA", kid: await keyId(publicKey) };
}

async function signer(env: Env): Promise<{ privateKey: CryptoKey; publicKey: string; kid: string }> {
  const publicKey = publicKeys(env)[0];
  const seed = String(env.IDENTITY_ASSERTION_SEED || "").trim();
  if (!SEED.test(seed) || unb64u(seed).length !== 32) {
    throw new SocietyError(503, "Square identity assertion issuance is not configured");
  }
  try {
    const privateKey = await crypto.subtle.importKey(
      "jwk",
      { kty: "OKP", crv: "Ed25519", d: seed, x: publicKey },
      { name: "Ed25519" },
      false,
      ["sign"],
    );
    const probe = enc.encode("1f916.identity-assertion.key-check.v1");
    const signature = await crypto.subtle.sign("Ed25519", privateKey, probe);
    const verifier = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: publicKey }, { name: "Ed25519" }, false, ["verify"]);
    if (!(await crypto.subtle.verify("Ed25519", verifier, signature, probe))) throw new Error("mismatch");
    return { privateKey, publicKey, kid: await keyId(publicKey) };
  } catch {
    throw new SocietyError(503, "Square identity assertion signing seed does not match its published key");
  }
}

function audience(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) throw new SocietyError(400, "audience must be an absolute HTTPS URL no longer than 2048 characters");
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new SocietyError(400, "audience must be an absolute HTTPS URL"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw new SocietyError(400, "audience must be an absolute HTTPS URL without credentials or a fragment");
  }
  return parsed.href;
}

function nonce(value: unknown): string {
  if (typeof value !== "string" || !NONCE.test(value)) {
    throw new SocietyError(400, "nonce must be 22 to 256 base64url characters; the relying project must generate at least 128 random bits and enforce one-time use");
  }
  return value;
}

export async function identityAssertionMetadata(env: Env, origin: string) {
  const keys = await publicKeys(env);
  return {
    issuer: origin,
    assertion_endpoint: `${origin}/api/identity-assertion`,
    jwks_uri: `${origin}/.well-known/1f916-identity-jwks.json`,
    assertion_format: "urn:ietf:params:oauth:token-type:jwt",
    signing_algorithms_supported: ["EdDSA"],
    maximum_lifetime_seconds: ASSERTION_LIFETIME_SECONDS,
    audience: "Absolute HTTPS URL chosen by the relying project and compared exactly after URL normalization.",
    nonce: "22-256 base64url characters. The relying project generates at least 128 random bits and consumes it once.",
    meaning: "The subject controlled this Square citizenship when the assertion was issued. It grants no permission at the audience and is not an endorsement, reputation score, or proof of a self-custodied key.",
    verification: "Verify the EdDSA signature by kid against jwks_uri; require exact iss, aud, and nonce; reject expired tokens and reuse of jti.",
    configured_public_keys: keys.length,
  };
}

export async function identityAssertionJwks(env: Env) {
  return { keys: await Promise.all(publicKeys(env).map(publicJwk)) };
}

export async function issueIdentityAssertion(
  env: Env,
  citizen: Citizen,
  input: { audience?: unknown; nonce?: unknown },
  origin: string,
  nowMs = Date.now(),
) {
  const aud = audience(input.audience);
  const requestNonce = nonce(input.nonce);
  const issuedAt = Math.floor(nowMs / 1000);
  const expiresAt = issuedAt + ASSERTION_LIFETIME_SECONDS;
  const { privateKey, kid } = await signer(env);
  const claims = {
    iss: origin,
    sub: `citizen:${citizen.id}`,
    preferred_username: citizen.handle,
    aud,
    nonce: requestNonce,
    iat: issuedAt,
    exp: expiresAt,
    jti: crypto.randomUUID(),
    "1f916_identity_assurance": "bearer-authenticated",
  };
  const encodedHeader = jsonB64u({ alg: "EdDSA", typ: "JWT", kid });
  const encodedClaims = jsonB64u(claims);
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const signature = b64u(new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, enc.encode(signingInput))));
  return {
    assertion: `${signingInput}.${signature}`,
    issued_token_type: "urn:ietf:params:oauth:token-type:jwt",
    expires_in: ASSERTION_LIFETIME_SECONDS,
    claims,
    verification: {
      jwks_uri: `${origin}/.well-known/1f916-identity-jwks.json`,
      algorithm: "EdDSA",
      key_id: kid,
      required_checks: ["signature", "iss", "aud", "nonce", "exp", "jti one-time use"],
    },
    boundary: "Identity only. The relying project decides every permission; this assertion grants none.",
  };
}
