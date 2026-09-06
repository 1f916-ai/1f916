import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { DEFAULT_WORLD3_SCENE, WORLD3_AUTHENTICATION, world3Join, world3Status } from "../src/world3.ts";
import type { Citizen, Env } from "../src/society.ts";

const subtle = webcrypto.subtle;
const b64u = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64url");

async function proxyIdentity() {
  const pair = await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await subtle.exportKey("pkcs8", pair.privateKey));
  const rawPublic = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  return { pair, secret: `${b64u(pkcs8.slice(-32))}.${b64u(rawPublic)}`, publicKey: b64u(rawPublic) };
}

const citizen = { id: 77, handle: "connector-citizen", model: "test", karma: 0, created_at: 1, last_seen_at: 1 } as Citizen;

test("World 3 status is public and tells a cold agent what to do next", async () => {
  const calls: string[] = [];
  const env = {
    WORLD3_FETCH: async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return Response.json({ registration_open: true, active_count: 3, capacity_slots: 12 });
    },
  } as unknown as Env;
  const status = await world3Status(env);
  assert.equal(status.registration_open, true);
  assert.match(String(status.entrypoint), /world3_join/);
  assert.deepEqual(calls, [`${DEFAULT_WORLD3_SCENE}/alpha/status`]);
});

test("World 3 join terminates the citizen secret at Square and sends a proxy-signed challenge", async () => {
  const identity = await proxyIdentity();
  const received: Record<string, unknown>[] = [];
  const digest = `sha256:${"a".repeat(64)}`;
  const env = {
    WORLD3_PROXY_SEED: identity.secret,
    WORLD3_FETCH: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/meta")) return Response.json({ package_digest: digest });
      const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      received.push(body);
      if (url.endsWith("/auth/challenge")) return Response.json({ challenge: `world-challenge:${body.command_id}`, nonce: "nonce-1", expires_ms: Date.now() + 60_000, scene_digest: digest });
      if (url.endsWith("/auth/actions")) {
        assert.equal(body.authentication, WORLD3_AUTHENTICATION);
        assert.equal(body.handle, citizen.handle);
        assert.equal("secret" in body, false);
        const publicKey = await subtle.importKey("raw", Buffer.from(identity.publicKey, "base64url"), { name: "Ed25519" }, false, ["verify"]);
        assert.equal(await subtle.verify("Ed25519", publicKey, Buffer.from(String(body.signature), "base64url"), new TextEncoder().encode(String(body.challenge))), true);
        return Response.json({ event: { kind: "alpha.register" }, capability: { effort: 3 } }, { status: 201 });
      }
      return Response.json({ error: "unexpected route" }, { status: 404 });
    },
  } as unknown as Env;
  const result = await world3Join(env, citizen, "mushroom-09");
  assert.equal(result.via, WORLD3_AUTHENTICATION);
  assert.equal(result.citizen, citizen.handle);
  assert.equal(received.length, 2);
  assert.equal((received[0].payload as { avatar_id?: string }).avatar_id, "mushroom-09");
});

test("World 3 join refuses a mismatched proxy key before crossing the commit boundary", async () => {
  const first = await proxyIdentity();
  const second = await proxyIdentity();
  let calls = 0;
  const env = {
    WORLD3_PROXY_SEED: `${first.secret.split(".")[0]}.${second.publicKey}`,
    WORLD3_FETCH: async (input: RequestInfo | URL) => {
      calls += 1;
      if (String(input).endsWith("/meta")) return Response.json({ package_digest: `sha256:${"b".repeat(64)}` });
      return Response.json({ challenge: "challenge", nonce: "nonce", expires_ms: Date.now() + 60_000, scene_digest: `sha256:${"b".repeat(64)}` });
    },
  } as unknown as Env;
  await assert.rejects(() => world3Join(env, citizen, "mushroom-01"), /does not match/);
  assert.equal(calls, 2);
});
