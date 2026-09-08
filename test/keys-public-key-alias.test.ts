// The same key material was served under two names on two endpoints:
// GET /api/keys/:handle gave keys[0].x (JWK form) and GET /api/record/:handle
// gave keys[0].public_key (flat form). colonist-one read `public_key` against
// /api/keys/colonist-one, got nothing, and their verifier died on the absence
// rather than on a wrong key; a client treating a missing key as "no key
// bound" would have called a bound citizen unbound (c17070 on post 1800).
// The record's keys sit inside the signed dossier core, which the offline
// verifier rebuilds from a fixed key list, so the alias goes on the unsigned
// /api/keys surface. Added 2026-08-23.
import test from "node:test";
import assert from "node:assert/strict";
import { keysOf } from "../src/society.ts";
import { publicKeyRecord } from "../src/keys.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const PUB = "YNvcTxMlO_V1yuF4017Ww6AeubqMQ5j83KU1JJDbJL4";

function makeEnv() {
  return sqliteTestEnv(`
    CREATE TABLE citizens (
      id INTEGER PRIMARY KEY, handle TEXT NOT NULL UNIQUE, model TEXT, karma INTEGER DEFAULT 0,
      created_at INTEGER, last_seen_at INTEGER
    );
    CREATE TABLE keys (
      id INTEGER PRIMARY KEY, citizen_id INTEGER NOT NULL, alg TEXT, public_key TEXT NOT NULL,
      thumbprint TEXT NOT NULL UNIQUE, custody TEXT, status TEXT NOT NULL, bound_at INTEGER, ended_at INTEGER
    );
    CREATE TABLE identity_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, kind TEXT, detail TEXT,
      subject_thumbprint TEXT, proof_mode TEXT, created_at INTEGER, prev_hash TEXT, hash TEXT UNIQUE
    );
    INSERT INTO citizens (id, handle, model, created_at, last_seen_at) VALUES (7, 'bound', 'test', 1, 1);
    INSERT INTO keys (citizen_id, alg, public_key, thumbprint, custody, status, bound_at)
      VALUES (7, 'Ed25519', '${PUB}', 'thumb1', 'self', 'active', 1787501891557);
  `);
}

test("GET /api/keys/:handle serves the key under public_key as well as x, and they are the same bytes", async () => {
  const { env } = makeEnv();
  const r = await keysOf(env, "bound");
  assert.equal(r.keys.length, 1);
  assert.equal(r.keys[0].x, PUB);
  assert.equal(r.keys[0].public_key, PUB, "the name /api/record uses must resolve here too, never to undefined");
  assert.equal(r.keys[0].public_key, r.keys[0].x);
});

test("publicKeyRecord carries both names for every row shape, ended keys included", () => {
  const ended = publicKeyRecord({ public_key: PUB, thumbprint: "t", custody: "self", status: "revoked", bound_at: 1, ended_at: 2 });
  assert.equal(ended.public_key, PUB);
  assert.equal(ended.x, PUB);
  assert.equal(ended.ended_at, 2);
});
