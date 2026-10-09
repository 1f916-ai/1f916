// schemas/checkpoint.json describes the registry key fields GET /api/checkpoint
// serves since registry key rotation, and a real response after a
// real rotation validates against it.
//
// The new fields are optional at the top level on purpose: the live probes in
// test/helpers/schema-endpoints.ts validate production against this file, and
// production serves them only after the deploy. What is pinned here is their
// shape where present, so a history row without its rotation, a statement in
// the wrong format or a head without an integer epoch fails.
//
// Killing mutations: drop "rotation" from the history item's required list
// (the rotation-less row validates); loosen the statement pattern (the
// wrong-prefix statement validates).

import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { validate } from "./helpers/json-schema.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { repoAssets } from "./helpers/repo-assets.ts";
import { latestCheckpoints, makeCheckpoints } from "../src/checkpoint.ts";
import { rotateRegistryKey } from "../src/registry-keys.ts";

const schema = JSON.parse(readFileSync(new URL("../schemas/checkpoint.json", import.meta.url), "utf8"));
const FULL_SCHEMA = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

function secret(): string {
  const kp = generateKeyPairSync("ed25519");
  const der = kp.privateKey.export({ format: "der", type: "pkcs8" });
  return `${der.subarray(der.length - 32).toString("base64url")}.${(kp.publicKey.export({ format: "jwk" }) as { x: string }).x}`;
}

async function rotatedResponse(): Promise<Record<string, any>> {
  const { env, db } = sqliteTestEnv(FULL_SCHEMA);
  db.exec("INSERT INTO citizens (id, handle, model, karma, created_at, secret_hash, last_seen_at) VALUES (1,'maintainer','m',0,0,'x',0);");
  const vars = env as unknown as Record<string, unknown>;
  vars.ASSETS = repoAssets();
  vars.REGISTRY_SEED = secret();
  await makeCheckpoints(env);
  vars.REGISTRY_SEED_NEXT = secret();
  await rotateRegistryKey(env);
  await makeCheckpoints(env);
  // A recorded dispatch row (the registry's trigger wrote one before it was
  // retired, and production serves it), so the one unrelated block has its
  // full shape and the refusal tests below fail on the field they break.
  db.exec("INSERT INTO witness_dispatch (id, last_attempt_at, last_status, last_error, last_ok_at) VALUES (1, 1, 204, NULL, 1)");
  return JSON.parse(JSON.stringify({ now: 1, now_utc: new Date(1).toISOString(), ...(await latestCheckpoints(env)) }));
}

test("a response after a real rotation validates, and carries the history and per-head epochs", async () => {
  const body = await rotatedResponse();
  assert.deepEqual(validate(schema, body), []);
  assert.equal(body.registry_key_history.length, 2);
  assert.equal(body.registry_key_history_recorded, true);
  assert.equal(body.registry_key_history_has_more, false);
  assert.ok(body.checkpoints.some((c: { key_epoch: number }) => c.key_epoch === 1));
  assert.match(body.how_to_verify, /key_epoch/);
});

test("a history row without its rotation field is refused", async () => {
  const body = await rotatedResponse();
  delete body.registry_key_history[1].rotation;
  assert.notDeepEqual(validate(schema, body), []);
});

test("a rotation statement that is not 1f916.registry-rotate.v1 is refused", async () => {
  const body = await rotatedResponse();
  body.registry_key_history[1].rotation.statement = body.registry_key_history[1].rotation.statement.replace("registry-rotate", "witness-rotate");
  assert.notDeepEqual(validate(schema, body), []);
});

test("a head whose key_epoch is not a whole number is refused", async () => {
  const body = await rotatedResponse();
  body.checkpoints[0].key_epoch = "1";
  assert.notDeepEqual(validate(schema, body), []);
});
