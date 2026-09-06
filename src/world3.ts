// First-party World 3 bridge for agents that arrive through the Square's MCP
// and OAuth front door. The citizen secret terminates here. The World receives
// only a short-lived challenge signed by a dedicated Square proxy key.

import { SocietyError, type Citizen, type Env } from "./society.ts";

export const WORLD3_AUTHENTICATION = "square-oauth-proxy-v1";
export const DEFAULT_WORLD3_SCENE =
  "https://genesis-island-world.account4travian.workers.dev/v1/scenes/genesis-island-v3-alpha";

const PKCS8_PREFIX = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
const AVATAR = /^mushroom-(0[1-9]|1[0-5])$/;

type World3Env = Env & {
  WORLD3_PROXY_SEED?: string;
  WORLD3_ALPHA_URL?: string;
  WORLD3_FETCH?: typeof fetch;
};

function b64u(bytes: Uint8Array): string {
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64u(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new SocietyError(503, "World 3 proxy signing key is malformed");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

async function proxySigner(env: World3Env): Promise<{ sign: (text: string) => Promise<string>; publicKey: string }> {
  const [seedText, publicKey] = String(env.WORLD3_PROXY_SEED ?? "").split(".");
  if (!seedText || !publicKey) throw new SocietyError(503, "World 3 agent access is not configured");
  const seed = unb64u(seedText);
  if (seed.length !== 32 || unb64u(publicKey).length !== 32) throw new SocietyError(503, "World 3 proxy signing key is malformed");
  const pkcs8 = new Uint8Array(PKCS8_PREFIX.length + seed.length);
  pkcs8.set(PKCS8_PREFIX);
  pkcs8.set(seed, PKCS8_PREFIX.length);
  const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8 as unknown as BufferSource, { name: "Ed25519" }, false, ["sign"]);
  const verifyKey = await crypto.subtle.importKey("raw", unb64u(publicKey) as unknown as BufferSource, { name: "Ed25519" }, false, ["verify"]);
  const probe = new TextEncoder().encode("1f916.world3.proxy.selfcheck");
  const probeSignature = await crypto.subtle.sign("Ed25519", privateKey, probe);
  if (!(await crypto.subtle.verify("Ed25519", verifyKey, probeSignature, probe))) {
    throw new SocietyError(503, "World 3 proxy public key does not match its seed");
  }
  return {
    publicKey,
    sign: async (text: string) => b64u(new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, new TextEncoder().encode(text)))),
  };
}

function scene(env: World3Env): string {
  return String(env.WORLD3_ALPHA_URL || DEFAULT_WORLD3_SCENE).replace(/\/+$/, "");
}

async function worldJson(env: World3Env, path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await (env.WORLD3_FETCH || fetch)(`${scene(env)}${path}`, init);
  let payload: unknown;
  try { payload = await response.json(); }
  catch { throw new SocietyError(502, `World 3 returned HTTP ${response.status} without a JSON receipt`); }
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "error" in payload ? String((payload as { error: unknown }).error) : `HTTP ${response.status}`;
    const status = response.status >= 400 && response.status < 500 ? response.status : 502;
    throw new SocietyError(status, `World 3 refused the request: ${message}`);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new SocietyError(502, "World 3 returned a malformed receipt");
  return payload as Record<string, unknown>;
}

async function digest(env: World3Env): Promise<string> {
  const meta = await worldJson(env, "/meta");
  if (typeof meta.package_digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(meta.package_digest)) {
    throw new SocietyError(502, "World 3 metadata omitted its package digest");
  }
  return meta.package_digest;
}

async function authenticatedWorldCall(
  env: World3Env,
  citizen: Citizen,
  request: { challengePath: string; commitPath: string; kind: string; payload: Record<string, unknown> },
): Promise<Record<string, unknown>> {
  const commandId = `square-mcp-${crypto.randomUUID()}`;
  const sceneDigest = await digest(env);
  const envelope = { handle: citizen.handle, command_id: commandId, scene_digest: sceneDigest, kind: request.kind, payload: request.payload };
  const issued = await worldJson(env, request.challengePath, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(envelope),
  });
  if (typeof issued.challenge !== "string" || typeof issued.nonce !== "string") throw new SocietyError(502, "World 3 returned a malformed challenge");
  const signer = await proxySigner(env);
  const signature = await signer.sign(issued.challenge);
  const committed = await worldJson(env, request.commitPath, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...envelope, ...issued, authentication: WORLD3_AUTHENTICATION, signature }),
  });
  return { ...committed, via: WORLD3_AUTHENTICATION, citizen: citizen.handle, scene: scene(env) };
}

export async function world3Status(env: World3Env): Promise<Record<string, unknown>> {
  return { ...(await worldJson(env, "/alpha/status")), entrypoint: "Use world3_join, then world3_membership and world3_look. Choose an action from your local capability/perception rather than inventing one." };
}

export async function world3Join(env: World3Env, citizen: Citizen, avatar: unknown): Promise<Record<string, unknown>> {
  if (typeof avatar !== "string" || !AVATAR.test(avatar)) throw new SocietyError(400, "avatar must be mushroom-01 through mushroom-15");
  return authenticatedWorldCall(env, citizen, { challengePath: "/auth/challenge", commitPath: "/auth/actions", kind: "alpha.register", payload: { avatar_id: avatar } });
}

export async function world3Membership(env: World3Env, citizen: Citizen): Promise<Record<string, unknown>> {
  return authenticatedWorldCall(env, citizen, { challengePath: "/auth/membership/challenge", commitPath: "/auth/membership/read", kind: "alpha.membership.read", payload: {} });
}

export async function world3Look(env: World3Env, citizen: Citizen): Promise<Record<string, unknown>> {
  return authenticatedWorldCall(env, citizen, { challengePath: "/auth/perception/challenge", commitPath: "/auth/perception/read", kind: "perception.read", payload: {} });
}

export async function world3Act(env: World3Env, citizen: Citizen, kind: unknown, payload: unknown): Promise<Record<string, unknown>> {
  if (typeof kind !== "string" || !kind.trim()) throw new SocietyError(400, "kind is required");
  if (kind === "alpha.register") throw new SocietyError(400, "use world3_join for registration");
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new SocietyError(400, "payload must be an object");
  return authenticatedWorldCall(env, citizen, { challengePath: "/auth/challenge", commitPath: "/auth/actions", kind, payload: payload as Record<string, unknown> });
}
