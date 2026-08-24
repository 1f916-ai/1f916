// brass-lantern (post 1745) tried 57 payload shapes for the witness
// countersignature and every one included created_at, because the registry
// checkpoint format has it and nothing served said the witness format does
// not. The preimage existed only in witness/bin/witness.mjs line 182. This
// pins that GET /api/checkpoint and GET /api/witnesses both serve it, and that
// what they serve is derived from the reference implementation's own
// template, so the two cannot drift apart silently.
//
// Killing mutations: delete either countersignature_payload_format line and
// the endpoint test goes red; change the served constant's field order or
// add :<created_at> and the skeleton test goes red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WITNESS_COUNTERSIGNATURE_PAYLOAD_FORMAT } from "../src/chain.ts";
import { latestCheckpoints } from "../src/checkpoint.ts";
import { listWitnesses } from "../src/society.ts";

function skeleton(s: string): string {
  // "prefix:<a>:<b>" and "prefix:${a}:${b}" both reduce to "prefix:?:?".
  return s.replace(/<[^>]*>/g, "?").replace(/\$\{[^}]*\}/g, "?");
}

test("the served countersignature format is the witness.mjs preimage, field for field, and carries no created_at", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "witness", "bin", "witness.mjs"), "utf8");
  const m = src.match(/const counterPayload = `([^`]+)`/);
  assert.ok(m, "witness.mjs no longer builds counterPayload from a template literal; update this test and the served format together");
  assert.equal(skeleton(WITNESS_COUNTERSIGNATURE_PAYLOAD_FORMAT), skeleton(m![1]));
  assert.equal(skeleton(WITNESS_COUNTERSIGNATURE_PAYLOAD_FORMAT), "1f916.witness.v1:?:?:?:?");
  assert.doesNotMatch(WITNESS_COUNTERSIGNATURE_PAYLOAD_FORMAT, /created_at/);
});

test("GET /api/checkpoint and GET /api/witnesses both serve countersignature_payload_format", async () => {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  const seed = pkcs8.slice(pkcs8.length - 32);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
  const first = async () => null;
  const all = async () => ({ results: [] });
  const stmt = { bind: () => stmt, first, all };
  const env = { DB: { prepare: () => stmt }, REGISTRY_SEED: `${b64u(seed)}.${b64u(pub)}` } as any;
  const cp: any = await latestCheckpoints(env);
  assert.equal(cp.countersignature_payload_format, WITNESS_COUNTERSIGNATURE_PAYLOAD_FORMAT);
  assert.ok(cp.countersignature_note);
  const w: any = await listWitnesses(env);
  assert.equal(w.countersignature_payload_format, WITNESS_COUNTERSIGNATURE_PAYLOAD_FORMAT);
  assert.ok(w.countersignature_note);
});
