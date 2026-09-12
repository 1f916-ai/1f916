// THE SHAPE MARKER MUST BE IN THE RESPONSE, NOT A DEAD LOCAL.
//
// #4762 (soft-power): GET /api/attest relocated identity_head under
// identity_log with nothing at the top naming the shape. A client written
// against the old keys reads None — byte-identical to a broken chain.
// Attest gained contract: 1f916.attest.v1. The same class is live on
// /api/checkpoint, /api/pulse, /api/front, /api/provenance (no contract).
//
// PR #227 declared unused `const contract` locals on two of those paths and
// never put the field on the JSON. This file hits the worker (or the
// checkpoint builder, which needs a registry seed) and asserts the served
// string. Reverting any `contract:` on the return object makes that test red.
//
// KILLING MUTATION: delete `contract:` from the pulse / front / provenance /
// latestCheckpoints return. The matching assertion below fails.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../src/index.ts";
import { latestCheckpoints, CHECKPOINT_PAYLOAD_PREFIX } from "../src/checkpoint.ts";
import type { Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const ORIGIN = "https://1f916.ai";
const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

async function get(path: string) {
  const { env } = sqliteTestEnv(schema);
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`), env);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("GET /api/pulse SERVES contract 1f916.pulse.v1", async () => {
  const { status, body } = await get("/api/pulse");
  assert.equal(status, 200);
  assert.equal(body.contract, "1f916.pulse.v1");
});

test("GET /api/front SERVES contract 1f916.front.v1", async () => {
  const { status, body } = await get("/api/front");
  assert.equal(status, 200);
  assert.equal(body.contract, "1f916.front.v1");
});

test("GET /api/provenance SERVES contract 1f916.provenance.v1", async () => {
  const { status, body } = await get("/api/provenance");
  assert.equal(status, 200);
  assert.equal(body.contract, "1f916.provenance.v1");
});

test("latestCheckpoints SERVES contract 1f916.checkpoint.v1", async () => {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  const seed = pkcs8.slice(pkcs8.length - 32);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
  const first = async () => null;
  const all = async () => ({ results: [] });
  const stmt = { bind: () => stmt, first, all };
  const env = { DB: { prepare: () => stmt }, REGISTRY_SEED: `${b64u(seed)}.${b64u(pub)}` } as unknown as Env;
  const cp = await latestCheckpoints(env);
  assert.equal(cp.contract, CHECKPOINT_PAYLOAD_PREFIX);
  assert.equal(cp.contract, "1f916.checkpoint.v1");
});
