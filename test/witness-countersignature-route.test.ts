// POST /api/witnesses/:id/countersignatures, the door a witness uses to push
// the countersignature row it already published (#8308).
//
// The registry never calls out to fetch a witness file (src/witness-cadence.ts),
// so the only way it can learn how far behind a witness is runs the other way:
// the witness posts its row. The door takes no bearer; the credential is the
// Ed25519 signature itself, so these tests drive the router with real
// signatures made in the test, against a witness row and checkpoint rows
// inserted straight into the fixture database. The storing rules (what is
// kept, what is a repeat, what is older) belong to src/witness-push.ts; what
// is pinned here is the wiring: the route, the origin the preimage names, the
// status each answer carries, and that the served body is the one
// schemas/witness-countersignature.json describes.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { validate } from "./helpers/json-schema.ts";
import worker from "../src/index.ts";
import { b64urlDecode, b64urlEncode, verifyEd25519 } from "../src/keys.ts";
import { WITNESS_RECEIPT_PAYLOAD_PREFIX } from "../src/witness-push.ts";

const schemaSql = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const responseSchema = JSON.parse(readFileSync(join(import.meta.dirname, "..", "schemas", "witness-countersignature.json"), "utf8"));

const ORIGIN = "https://1f916.ai";
const LOG = "identity_events";
const ROOT_A = "a".repeat(64);
const ROOT_B = "b".repeat(64);
// The throwaway registry seed test/helpers/openapi-examples-fixture.ts uses, so
// the receipt can be signed; public test material that signs nothing real.
const TEST_SEED = "D035Q8lzsP7ML7jq8DOvw1hDfS6Y3NCrby-a98R8Qn8.-01jX9w97Bdqdy1p6lSbt1eeic_uAoVR4xgFCmHJPlg";

const sign = async (pair: CryptoKeyPair, origin: string, log: string, size: number, root: string) =>
  b64urlEncode(new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, new TextEncoder().encode(`1f916.witness.v1:${origin}:${log}:${size}:${root}`))));

// One registered citizen who owns witness 7 (a real key) and witness 8 (none).
async function fixture() {
  const { env, db } = sqliteTestEnv(schemaSql);
  (env as unknown as Record<string, unknown>).REGISTRY_SEED = TEST_SEED;
  const reg = await worker.fetch(
    new Request(`${ORIGIN}/api/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle: "push-witness", model: "gpt-5" }) }),
    env,
  );
  const citizenId = ((await reg.json()) as { citizen_id: number }).citizen_id;
  const pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const publicKey = b64urlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  const insertWitness = db.prepare("INSERT INTO witnesses (id, citizen_id, name, url, public_key, added_at, epoch, key_set_at) VALUES (?, ?, ?, ?, ?, 1000, 0, 1000)");
  insertWitness.run(7, citizenId, "pushing witness", "https://witness.example/countersignatures.jsonl", publicKey);
  insertWitness.run(8, citizenId, "keyless witness", "https://keyless.example/countersignatures.jsonl", null);
  const checkpoint = (log: string, size: number, root: string, at: number) =>
    db.prepare("INSERT INTO checkpoints (log, tree_size, root, sig, created_at) VALUES (?, ?, ?, 'unused', ?)").run(log, size, root, at);
  const stored = (log = LOG) => db.prepare("SELECT tree_size, root FROM witness_countersignatures WHERE witness_id = 7 AND log = ?").get(log) as { tree_size: number; root: string } | undefined;
  return { env, pair, checkpoint, stored };
}

type Pushed = { status: number; body: Record<string, any> };
async function push(env: unknown, id: number, body: unknown): Promise<Pushed> {
  const res = await worker.fetch(
    new Request(`${ORIGIN}/api/witnesses/${id}/countersignatures`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    env as never,
  );
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const rowFor = async (pair: CryptoKeyPair, size: number, root: string, origin = ORIGIN) => ({ log: LOG, tree_size: size, root, witness_sig: await sign(pair, origin, LOG, size, root) });

test("a signed row for a checkpoint this registry made is stored: 201, a receipt the registry's key verifies, and a body the schema accepts", async () => {
  const f = await fixture();
  f.checkpoint(LOG, 5, ROOT_A, 5_000);
  const r = await push(f.env, 7, await rowFor(f.pair, 5, ROOT_A));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.accepted, true);
  assert.deepEqual([r.body.witness_id, r.body.log, r.body.tree_size], [7, LOG, 5]);
  assert.deepEqual(validate(responseSchema, r.body), []);
  // The receipt is the registry's own word on what it stored, checkable with
  // the key the response names and nothing else.
  assert.ok(r.body.receipt.payload.startsWith(`${WITNESS_RECEIPT_PAYLOAD_PREFIX}:${ORIGIN}:7:`), r.body.receipt.payload);
  assert.ok(r.body.receipt.payload.includes(`:${LOG}:5:${ROOT_A}:`), r.body.receipt.payload);
  const verified = await verifyEd25519(b64urlDecode(r.body.registry_public_key.x), new TextEncoder().encode(r.body.receipt.payload), b64urlDecode(r.body.receipt.sig));
  assert.equal(verified, true, "the receipt signature verifies under registry_public_key");
  assert.deepEqual({ ...f.stored() }, { tree_size: 5, root: ROOT_A });
});

test("the same row again is a 200 repeat that hands back the stored receipt, not a new signature", async () => {
  const f = await fixture();
  f.checkpoint(LOG, 5, ROOT_A, 5_000);
  const row = await rowFor(f.pair, 5, ROOT_A);
  const first = await push(f.env, 7, row);
  const again = await push(f.env, 7, row);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.accepted, true);
  assert.equal(again.body.deduplicated, true);
  assert.deepEqual(again.body.receipt, first.body.receipt);
  assert.deepEqual(validate(responseSchema, again.body), []);
});

test("an older row after a newer one stores nothing and says so: 200 with accepted false", async () => {
  const f = await fixture();
  f.checkpoint(LOG, 5, ROOT_A, 5_000);
  f.checkpoint(LOG, 8, ROOT_B, 8_000);
  assert.equal((await push(f.env, 7, await rowFor(f.pair, 8, ROOT_B))).status, 201);
  const older = await push(f.env, 7, await rowFor(f.pair, 5, ROOT_A));
  assert.equal(older.status, 200, JSON.stringify(older.body));
  assert.equal(older.body.accepted, false);
  assert.equal(typeof older.body.reason, "string");
  assert.deepEqual(validate(responseSchema, older.body), []);
  assert.equal(f.stored()?.tree_size, 8, "the older row did not rewind the stored one");
});

test("the preimage names the registry origin: a signature made for another origin is a 422 and nothing is stored", async () => {
  const f = await fixture();
  f.checkpoint(LOG, 5, ROOT_A, 5_000);
  for (const origin of ["https://staging.example", `${ORIGIN}/`]) {
    const r = await push(f.env, 7, await rowFor(f.pair, 5, ROOT_A, origin));
    assert.equal(r.status, 422, `${origin}: ${JSON.stringify(r.body)}`);
    assert.equal(typeof r.body.error, "string");
  }
  assert.equal(f.stored(), undefined);
});

test("a validly signed row that is not a checkpoint this registry signed is a 422", async () => {
  const f = await fixture();
  f.checkpoint(LOG, 5, ROOT_A, 5_000);
  // Right size, wrong root; and a size no checkpoint has. Both are signed
  // correctly, so only the checkpoint lookup can refuse them.
  assert.equal((await push(f.env, 7, await rowFor(f.pair, 5, ROOT_B))).status, 422);
  assert.equal((await push(f.env, 7, await rowFor(f.pair, 6, ROOT_A))).status, 422);
  assert.equal(f.stored(), undefined);
});

test("an unknown witness is a 404 and a witness with no key is a 409", async () => {
  const f = await fixture();
  f.checkpoint(LOG, 5, ROOT_A, 5_000);
  const row = await rowFor(f.pair, 5, ROOT_A);
  assert.equal((await push(f.env, 99, row)).status, 404);
  const keyless = await push(f.env, 8, row);
  assert.equal(keyless.status, 409, JSON.stringify(keyless.body));
  assert.equal(typeof keyless.body.error, "string");
});

test("a body that is not the four fields is a 400: not JSON, not an object, an extra key", async () => {
  const f = await fixture();
  f.checkpoint(LOG, 5, ROOT_A, 5_000);
  const row = await rowFor(f.pair, 5, ROOT_A);
  assert.equal((await push(f.env, 7, "{not json")).status, 400);
  assert.equal((await push(f.env, 7, [row])).status, 400);
  assert.equal((await push(f.env, 7, { ...row, note: "extra" })).status, 400);
  assert.equal(f.stored(), undefined);
});

test("the door is POST only: a GET on the same path is not routed", async () => {
  const f = await fixture();
  const res = await worker.fetch(new Request(`${ORIGIN}/api/witnesses/7/countersignatures`), f.env);
  assert.equal(res.status, 404);
});
