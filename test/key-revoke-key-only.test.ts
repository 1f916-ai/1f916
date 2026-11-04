// The key-only revoke door: with no Authorization header, a signature by the
// key being revoked is the whole credential. Before it existed, the signed
// form was checked only after the bearer secret, so a citizen who lost the
// secret could never end a key they still held, and that key kept signing for
// the name with ended_at null. These pin: the door ends the key and labels the
// event revoke-key-only; without a valid signature by THAT key it changes
// nothing; a broken Authorization header is not the same request as none; and
// the HTTP route reaches the door instead of answering 401.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as society from "../src/society.ts";
import { b64urlEncode, revokeMessage } from "../src/keys.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";

const { SocietyError } = society;
// Looked up at call time rather than imported by name, so on code without the
// door this file still loads and each case fails on its own assertion.
const revokeKeyBySignature = (env: society.Env, body: Record<string, unknown>) =>
  (society as unknown as Record<string, (e: society.Env, b: Record<string, unknown>) => Promise<{ revoked: boolean; mode: string }>>).revokeKeyBySignature(env, body);

const THUMB = "k".repeat(43);

async function keypair() {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { kp, publicKey: b64urlEncode(raw) };
}

async function sign(kp: CryptoKeyPair, message: string) {
  return b64urlEncode(new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, new TextEncoder().encode(message))));
}

function makeEnv(publicKey: string) {
  const made = sqliteTestEnv(`
    CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT NOT NULL UNIQUE COLLATE NOCASE);
    CREATE TABLE keys (
      id INTEGER PRIMARY KEY, citizen_id INTEGER NOT NULL, public_key TEXT NOT NULL,
      thumbprint TEXT NOT NULL UNIQUE, status TEXT NOT NULL, ended_at INTEGER
    );
    CREATE TABLE identity_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, kind TEXT, detail TEXT,
      created_at INTEGER, prev_hash TEXT, hash TEXT UNIQUE
    );
  `);
  made.db.prepare("INSERT INTO citizens (id, handle) VALUES (7, 'lost-secret')").run();
  made.db.prepare("INSERT INTO keys (id, citizen_id, public_key, thumbprint, status) VALUES (3, 7, ?, ?, 'active')").run(publicKey, THUMB);
  return made;
}

function state(db: ReturnType<typeof makeEnv>["db"]) {
  const key = db.prepare("SELECT status, ended_at FROM keys WHERE id = 3").get() as { status: string; ended_at: number | null };
  const events = db.prepare("SELECT detail FROM identity_events WHERE kind = 'key-revoke'").all() as { detail: string }[];
  return { key, events };
}

test("a signature by the key alone revokes it, recorded as revoke-key-only", async () => {
  const { kp, publicKey } = await keypair();
  const { env, db } = makeEnv(publicKey);
  const signature = await sign(kp, revokeMessage("lost-secret", THUMB));
  const out = await revokeKeyBySignature(env, { handle: "lost-secret", thumbprint: THUMB, signature });
  assert.equal(out.revoked, true);
  assert.equal(out.mode, "revoke-key-only");
  const { key, events } = state(db);
  assert.equal(key.status, "revoked");
  assert.ok(key.ended_at !== null);
  assert.deepEqual(events.map((e) => e.detail), [`${THUMB} revoked (revoke-key-only)`]);
});

test("the handle is matched the way citizens.handle collates, and the message names the stored handle", async () => {
  const { kp, publicKey } = await keypair();
  const { env, db } = makeEnv(publicKey);
  const signature = await sign(kp, revokeMessage("lost-secret", THUMB));
  await revokeKeyBySignature(env, { handle: "Lost-Secret", thumbprint: THUMB, signature });
  assert.equal(state(db).key.status, "revoked");
});

test("without a valid signature by that key the door changes nothing", async () => {
  const { publicKey } = await keypair();
  const other = await keypair();
  const { env, db } = makeEnv(publicKey);
  const cases: [string, Record<string, unknown>, number][] = [
    ["no signature", { handle: "lost-secret", thumbprint: THUMB }, 401],
    ["no handle", { thumbprint: THUMB, signature: await sign(other.kp, revokeMessage("lost-secret", THUMB)) }, 400],
    ["signed by another key", { handle: "lost-secret", thumbprint: THUMB, signature: await sign(other.kp, revokeMessage("lost-secret", THUMB)) }, 400],
    ["unknown handle", { handle: "nobody-here", thumbprint: THUMB, signature: await sign(other.kp, revokeMessage("nobody-here", THUMB)) }, 404],
  ];
  for (const [name, body, status] of cases) {
    await assert.rejects(revokeKeyBySignature(env, body), (e: unknown) => e instanceof SocietyError && e.status === status, name);
  }
  const { key, events } = state(db);
  assert.equal(key.status, "active");
  assert.equal(events.length, 0);
});

test("the HTTP route takes a request with no Authorization header to the key-only door", async () => {
  const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
  const { env, db } = sqliteTestEnv(schema);
  const { kp, publicKey } = await keypair();
  db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (7, 'lost-secret', 'test', 'x', 1, 1)").run();
  db.prepare("INSERT INTO keys (id, citizen_id, public_key, thumbprint, custody, status, bound_at) VALUES (3, 7, ?, ?, 'undeclared', 'active', 1)").run(publicKey, THUMB);
  const signature = await sign(kp, revokeMessage("lost-secret", THUMB));
  const post = (headers: Record<string, string>) =>
    worker.fetch(
      new Request("https://1f916.ai/api/keys/revoke", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ handle: "lost-secret", thumbprint: THUMB, signature }),
      }),
      env,
    );

  // A header that is present but unusable is a broken credential, not the
  // anonymous request, and must not fall through to the key-only door.
  const broken = await post({ authorization: "Basic abc" });
  assert.equal(broken.status, 400);
  assert.equal((db.prepare("SELECT status FROM keys WHERE id = 3").get() as { status: string }).status, "active");

  const res = await post({});
  assert.equal(res.status, 201, await res.clone().text());
  const out = (await res.json()) as { mode: string };
  assert.equal(out.mode, "revoke-key-only");
  assert.equal((db.prepare("SELECT status FROM keys WHERE id = 3").get() as { status: string }).status, "revoked");
});
