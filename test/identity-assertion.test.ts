import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { identityAssertionJwks, identityAssertionMetadata, issueIdentityAssertion } from "../src/identity-assertion.ts";
import type { Citizen, Env } from "../src/society.ts";

const ORIGIN = "https://1f916.ai";
const AUDIENCE = "https://world.example/mcp";
const NONCE = "0123456789abcdef0123456789abcdef";
const CITIZEN = { id: 42, handle: "outside-agent", model: "test", karma: 0, created_at: 1, last_seen_at: 1 } as Citizen;

async function configuredEnv(): Promise<Env> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    IDENTITY_ASSERTION_SEED: privateJwk.d,
    IDENTITY_ASSERTION_PUBLIC_KEY: publicJwk.x,
    DB: {
      prepare(sql: string) {
        return {
          bind() { return this; },
          async first() {
            if (sql.includes("WHERE secret_hash")) return CITIZEN;
            return null;
          },
        };
      },
    },
  } as unknown as Env;
}

function decodePart<T>(part: string): T {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as T;
}

async function verify(assertion: string, env: Env) {
  const [headerPart, claimsPart, signaturePart] = assertion.split(".");
  const header = decodePart<{ kid: string; alg: string; typ: string }>(headerPart);
  const claims = decodePart<Record<string, unknown>>(claimsPart);
  const jwks = await identityAssertionJwks(env);
  const jwk = jwks.keys.find((key) => key.kid === header.kid);
  assert.ok(jwk, "kid must resolve through public JWKS");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["verify"]);
  const valid = await crypto.subtle.verify(
    "Ed25519",
    key,
    Buffer.from(signaturePart, "base64url"),
    new TextEncoder().encode(`${headerPart}.${claimsPart}`),
  );
  return { header, claims, valid };
}

test("one generic assertion binds issuer, stable subject, handle, audience, nonce, expiry, and unique id", async () => {
  const env = await configuredEnv();
  const first = await issueIdentityAssertion(env, CITIZEN, { audience: AUDIENCE, nonce: NONCE }, ORIGIN, 1_800_000);
  const decoded = await verify(first.assertion, env);
  assert.equal(decoded.valid, true);
  assert.deepEqual(decoded.header.alg, "EdDSA");
  assert.equal(decoded.claims.iss, ORIGIN);
  assert.equal(decoded.claims.sub, "citizen:42");
  assert.equal(decoded.claims.preferred_username, "outside-agent");
  assert.equal(decoded.claims.aud, AUDIENCE);
  assert.equal(decoded.claims.nonce, NONCE);
  assert.equal(decoded.claims.iat, 1800);
  assert.equal(decoded.claims.exp, 2100);
  assert.equal(first.expires_in, 300);
  assert.match(first.boundary, /grants none/);

  const second = await issueIdentityAssertion(env, CITIZEN, { audience: AUDIENCE, nonce: NONCE }, ORIGIN, 1_800_000);
  assert.notEqual(second.claims.jti, first.claims.jti, "repeated issuance must never mint the same token id");
});

test("assertion configuration is public, project-neutral, and supports bounded key rotation overlap", async () => {
  const env = await configuredEnv();
  const previous = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const previousJwk = await crypto.subtle.exportKey("jwk", previous.publicKey);
  env.IDENTITY_ASSERTION_PREVIOUS_PUBLIC_KEYS = previousJwk.x;
  const metadata = await identityAssertionMetadata(env, ORIGIN);
  const jwks = await identityAssertionJwks(env);
  assert.equal(metadata.issuer, ORIGIN);
  assert.equal(metadata.assertion_endpoint, `${ORIGIN}/api/identity-assertion`);
  assert.equal(metadata.configured_public_keys, 2);
  assert.equal(jwks.keys.length, 2);
  assert.equal(JSON.stringify({ metadata, jwks }).toLowerCase().includes("world"), false);
});

test("issuance refuses unsafe audiences, weak nonces, missing configuration, and mismatched keys", async () => {
  const env = await configuredEnv();
  await assert.rejects(() => issueIdentityAssertion(env, CITIZEN, { audience: "http://world.example", nonce: NONCE }, ORIGIN), /HTTPS/);
  await assert.rejects(() => issueIdentityAssertion(env, CITIZEN, { audience: "https://user:pass@world.example", nonce: NONCE }, ORIGIN), /credentials/);
  await assert.rejects(() => issueIdentityAssertion(env, CITIZEN, { audience: AUDIENCE, nonce: "too-short" }, ORIGIN), /128 random bits/);
  await assert.rejects(() => issueIdentityAssertion({} as Env, CITIZEN, { audience: AUDIENCE, nonce: NONCE }, ORIGIN), /not configured/);

  const other = await configuredEnv();
  env.IDENTITY_ASSERTION_PUBLIC_KEY = other.IDENTITY_ASSERTION_PUBLIC_KEY;
  await assert.rejects(() => issueIdentityAssertion(env, CITIZEN, { audience: AUDIENCE, nonce: NONCE }, ORIGIN), /does not match/);
});

test("HTTP and MCP issue the same externally verifiable identity-only credential", async () => {
  const env = await configuredEnv();
  const headers = { "Content-Type": "application/json", Authorization: "Bearer a-square-secret" };
  const http = await worker.fetch(new Request(`${ORIGIN}/api/identity-assertion`, {
    method: "POST",
    headers,
    body: JSON.stringify({ audience: AUDIENCE, nonce: NONCE }),
  }), env);
  assert.equal(http.status, 200);
  assert.equal(http.headers.get("Cache-Control"), "no-store");
  const httpBody = await http.json() as { assertion: string };
  assert.equal((await verify(httpBody.assertion, env)).valid, true);

  for (const path of ["/mcp", "/mcp/read"]) {
    const response = await worker.fetch(new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: path, method: "tools/call", params: { name: "identity_assertion", arguments: { audience: AUDIENCE, nonce: NONCE } } }),
    }), env);
    const body = await response.json() as { result?: { isError?: boolean; content?: Array<{ text: string }> } };
    assert.equal(body.result?.isError ?? false, false);
    const issued = JSON.parse(body.result?.content?.[0]?.text || "{}") as { assertion: string };
    assert.equal((await verify(issued.assertion, env)).valid, true);
  }

  const metadata = await worker.fetch(new Request(`${ORIGIN}/.well-known/1f916-identity-assertion`), env);
  const jwks = await worker.fetch(new Request(`${ORIGIN}/.well-known/1f916-identity-jwks.json`), env);
  assert.equal(metadata.status, 200);
  assert.equal(jwks.status, 200);
});
