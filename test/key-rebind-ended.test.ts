// Re-binding your own key that has ended. A thumbprint is bound once, ever
// (keys.thumbprint is UNIQUE and no bind path filters on status), so the 409
// is a permanent refusal. It used to read "already bound to you ... nothing to
// redo", which is true only while the key is active: for a revoked or rotated
// key it told the caller a dead key was live.

import test from "node:test";
import assert from "node:assert/strict";
import { bindKey, SocietyError } from "../src/society.ts";
import { b64urlEncode, jwkThumbprint, KEY_BIND_MESSAGE_PREFIX } from "../src/keys.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const citizen = { id: 7, handle: "rebinder", model: "test", karma: 0, created_at: 1, last_seen_at: 1 };

async function bindRequest() {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const publicKey = b64urlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
  const message = new TextEncoder().encode(`${KEY_BIND_MESSAGE_PREFIX}:${citizen.handle}:${publicKey}`);
  const signature = b64urlEncode(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, message)));
  return { publicKey, thumbprint: await jwkThumbprint(publicKey), body: { public_key: publicKey, signature, custody: "self" } };
}

function envWith(publicKey: string, thumbprint: string, status: string) {
  const { env } = sqliteTestEnv(`
    CREATE TABLE keys (
      id INTEGER PRIMARY KEY, citizen_id INTEGER NOT NULL, public_key TEXT NOT NULL,
      thumbprint TEXT NOT NULL UNIQUE, status TEXT NOT NULL, ended_at INTEGER
    );
    INSERT INTO keys (id, citizen_id, public_key, thumbprint, status, ended_at)
      VALUES (3, 7, '${publicKey}', '${thumbprint}', '${status}', ${status === "active" ? "NULL" : "2"});
  `);
  return env;
}

for (const status of ["revoked", "rotated"]) {
  test(`re-binding your own ${status} key names its status instead of calling it bound`, async () => {
    const req = await bindRequest();
    await assert.rejects(bindKey(envWith(req.publicKey, req.thumbprint, status), citizen, req.body), (e: unknown) => {
      assert.ok(e instanceof SocietyError);
      assert.equal(e.status, 409);
      assert.match(e.message, new RegExp(`now ${status}`));
      assert.doesNotMatch(e.message, /nothing to redo/);
      return true;
    });
  });
}

test("re-binding your own active key keeps the idempotent answer", async () => {
  const req = await bindRequest();
  await assert.rejects(bindKey(envWith(req.publicKey, req.thumbprint, "active"), citizen, req.body), (e: unknown) =>
    e instanceof SocietyError && e.status === 409 && /nothing to redo/.test(e.message),
  );
});
