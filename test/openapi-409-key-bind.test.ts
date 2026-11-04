// POST /api/keys can refuse a repeated Ed25519 key bind with 409, but the generated
// contract currently declares only 201/400/401/429. A retry after a lost success
// needs to distinguish the already-bound idempotent result from an invalid bind.

import assert from "node:assert/strict";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { b64urlEncode, KEY_BIND_MESSAGE_PREFIX } from "../src/keys.ts";
import { KEY_BIND_409_ROUTES } from "../src/connect.ts";
import worker from "../src/index.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

test("KEY_BIND_409_ROUTES is exactly the key-bind endpoint", () => {
  assert.deepEqual([...KEY_BIND_409_ROUTES], ["/api/keys"]);
});

test("POST /api/keys declares the duplicate-binding 409 with the JSON error envelope", async () => {
  const { env } = sqliteTestEnv(schema);
  const doc = (await (await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env)).json()) as {
    paths: Record<string, Record<string, { responses: Record<string, { content?: Record<string, { schema?: unknown }>; description?: string }> }>>;
  };
  const response = doc.paths["/api/keys"].post.responses["409"];
  assert.ok(response, "POST /api/keys serves 409 on an already-bound thumbprint but the document omits it");
  assert.deepEqual(Object.keys(response.content ?? {}), ["application/json"], "409 is the registry JSON refusal, not the edge text response");
  assert.deepEqual(response.content?.["application/json"]?.schema, { $ref: "#/components/schemas/Error" });
  assert.match(response.description ?? "", /already bound|already been bound/i, "409 description names the duplicate-key conflict");
});

test("the live router answers a repeated active key bind with the clocked 409 envelope", async () => {
  const { env } = sqliteTestEnv(schema);
  const handle = "bind409-berry";
  const register = await worker.fetch(
    new Request(`${ORIGIN}/api/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle, model: "gpt-5" }),
    }),
    env,
  );
  assert.equal(register.status, 201, "register test citizen");
  const { secret } = (await register.json()) as { secret: string };

  const ed = generateKeyPairSync("ed25519");
  const publicKey = (ed.publicKey.export({ format: "jwk" }) as { x: string }).x;
  const signature = b64urlEncode(
    new Uint8Array(edSign(null, Buffer.from(`${KEY_BIND_MESSAGE_PREFIX}:${handle}:${publicKey}`), ed.privateKey)),
  );
  const bind = () =>
    worker.fetch(
      new Request(`${ORIGIN}/api/keys`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${secret}` },
        body: JSON.stringify({ public_key: publicKey, signature }),
      }),
      env,
    );

  assert.equal((await bind()).status, 201, "first key bind succeeds");
  const repeated = await bind();
  assert.equal(repeated.status, 409, "same active thumbprint is refused idempotently");
  const body = (await repeated.json()) as Record<string, unknown>;
  assert.match(String(body.error), /already bound to you.*idempotent/i);
  assert.equal(typeof body.now, "number");
  assert.equal(typeof body.now_utc, "string");
});
