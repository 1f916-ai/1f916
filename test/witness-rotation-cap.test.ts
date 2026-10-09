// A same-URL cross-signed rotation updates one row; the three-witness
// registration cap must not prevent that update. Exercise real signatures
// and SQLite transactions against the production schema, not canned DB reads.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { registerWitness, SocietyError, type Citizen } from "../src/society.ts";
import { b64urlEncode } from "../src/keys.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const oldPair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
const newPair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
const oldPub = b64urlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", oldPair.publicKey)));
const newPub = b64urlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", newPair.publicKey)));
const message = new TextEncoder().encode(`1f916.witness-rotate.v1:1:1:${oldPub}:${newPub}`);
const oldSig = b64urlEncode(new Uint8Array(await crypto.subtle.sign("Ed25519", oldPair.privateKey, message)));
const newSig = b64urlEncode(new Uint8Array(await crypto.subtle.sign("Ed25519", newPair.privateKey, message)));
const rotation = { name: "first", url: "https://example.test/w1/", public_key: newPub, old_sig: oldSig, new_sig: newSig };

function fixture() {
  const { env, db } = sqliteTestEnv(schema);
  db.exec("INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (1, 'owner', 'test', 'h1', 0, 0), (2, 'other', 'test', 'h2', 0, 0)");
  for (let id = 1; id <= 3; id++) {
    db.prepare("INSERT INTO witnesses (id, citizen_id, name, url, public_key, epoch, key_set_at, added_at) VALUES (?, 1, ?, ?, ?, 0, 0, 0)")
      .run(id, `w${id}`, `https://example.test/w${id}/`, oldPub);
  }
  return { env, db, citizen: { id: 1, handle: "owner" } as Citizen };
}

const count = (db: DatabaseSync, table: "witnesses" | "identity_events") =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

function state(db: DatabaseSync) {
  return {
    witnesses: db.prepare("SELECT * FROM witnesses ORDER BY id").all(),
    events: db.prepare("SELECT * FROM identity_events ORDER BY id").all(),
  };
}

test("a full witness directory permits a cross-signed same-row rotation", async (t) => {
  const { env, db, citizen } = fixture();
  t.after(() => db.close());
  const result = await registerWitness(env, citizen, rotation);
  assert.equal(result.rotated, true);
  assert.equal(result.witness_id, 1);
  assert.equal(result.epoch, 1);
  assert.equal(result.public_key, newPub);
  assert.equal(count(db, "witnesses"), 3, "rotation does not consume a registration slot");
  const row = db.prepare("SELECT public_key, epoch FROM witnesses WHERE id = 1").get();
  assert.deepEqual({ ...row }, { public_key: newPub, epoch: 1 });
  assert.equal(count(db, "identity_events"), 1);
  const event = db.prepare("SELECT kind, hash FROM identity_events").get();
  assert.deepEqual({ ...event }, { kind: "witness-rotate", hash: result.chained });
});

test("at capacity, new registrations and invalid rotations still refuse without writes", async (t) => {
  const cases = [
    { name: "fourth URL", body: { ...rotation, url: "https://example.test/w4/" }, status: 429, reason: /at most 3 registered witnesses/ },
    { name: "missing old signature", body: { ...rotation, old_sig: undefined }, status: 400, reason: /cross-signatures/ },
    { name: "missing new signature", body: { ...rotation, new_sig: undefined }, status: 400, reason: /cross-signatures/ },
    { name: "wrong old signer", body: { ...rotation, old_sig: newSig }, status: 400, reason: /cross-signatures/ },
    { name: "wrong new signer", body: { ...rotation, new_sig: oldSig }, status: 400, reason: /cross-signatures/ },
    { name: "unchanged key", body: { ...rotation, public_key: oldPub }, status: 409, reason: /already registered/ },
    { name: "another owner's URL", body: rotation, status: 409, reason: /registered by another citizen/ },
  ];
  for (const c of cases) {
    await t.test(c.name, async (t) => {
      const { env, db, citizen } = fixture();
      t.after(() => db.close());
      if (c.name === "another owner's URL") {
        db.prepare("UPDATE witnesses SET citizen_id = 2 WHERE id = 1").run();
        db.prepare("INSERT INTO witnesses (citizen_id, name, url, public_key, epoch, added_at) VALUES (1, 'extra', 'https://example.test/extra/', ?, 0, 0)").run(oldPub);
      }
      const before = state(db);
      await assert.rejects(registerWitness(env, citizen, c.body),
        (e: unknown) => e instanceof SocietyError && e.status === c.status && c.reason.test(e.message));
      assert.deepEqual(state(db), before, "refusals cannot change the witness or event chain");
    });
  }
});
