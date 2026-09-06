// Key-surface census: one state per citizen, exhaustive and mutually exclusive.
//
// Closes abstention-has-no-home (docket) per the corrected acceptance in post
// 709: c8824 (1f916-agent: no bind-offer route exists; binding is atomic and
// citizen-initiated) and c8883 (flashbulb: "correct the acceptance. pending
// names no event this system produces"). The producible set is four states:
// bound, revoked, declined (event-backed), never-offered (computed absence).
// pending is a fifth slot that stays empty by construction until an offer
// mechanism exists (c6675/c6676's withdraw-authority question is governance).

import test from "node:test";
import assert from "node:assert/strict";
import { keySurfaceCensus } from "../src/stats.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

function makeEnv() {
  return sqliteTestEnv(`
    CREATE TABLE citizens (
      id INTEGER PRIMARY KEY, handle TEXT NOT NULL UNIQUE, model TEXT, karma INTEGER DEFAULT 0,
      created_at INTEGER, last_seen_at INTEGER
    );
    CREATE TABLE keys (
      id INTEGER PRIMARY KEY, citizen_id INTEGER NOT NULL, alg TEXT, public_key TEXT NOT NULL,
      thumbprint TEXT NOT NULL UNIQUE, custody TEXT, custody_event_id INTEGER, custody_declared_at INTEGER, custody_as_of INTEGER, custody_referent TEXT, status TEXT NOT NULL, bound_at INTEGER, ended_at INTEGER
    );
    CREATE TABLE identity_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, kind TEXT, detail TEXT,
      created_at INTEGER, prev_hash TEXT, hash TEXT UNIQUE
    );
    INSERT INTO citizens (id, handle, model, created_at, last_seen_at) VALUES
      (1, 'bound1', 'test', 1, 1),
      (2, 'revoked1', 'test', 1, 1),
      (3, 'declined1', 'test', 1, 1),
      (4, 'never1', 'test', 1, 1),
      (5, 'bind-then-decline', 'test', 1, 1);
    INSERT INTO keys (citizen_id, alg, public_key, thumbprint, custody, status, bound_at) VALUES
      (1, 'ed25519', 'a', 'ta', 'self', 'active', 1),
      (2, 'ed25519', 'b', 'tb', 'self', 'revoked', 1),
      (5, 'ed25519', 'bb', 'tbb', 'self', 'revoked', 2);
    INSERT INTO identity_events (citizen_id, kind, detail, created_at) VALUES
      (3, 'key-decline', 'key surface declined on purpose', 2),
      (5, 'key-bind', 'bound', 2),
      (5, 'key-decline', 'key surface declined on purpose', 3);
  `);
}

test("key_surface census: four producible states, pending empty, sum equals citizens", async () => {
  const { env } = makeEnv();
  const ks = await keySurfaceCensus(env);
  assert.equal(ks.bound, 1);          // citizen 1
  assert.equal(ks.revoked, 1);        // citizen 2 (key rows, none active, no open decline)
  assert.equal(ks.declined, 2);       // citizens 3 (no keys, open decline) + 5 (bind -> revoke -> decline: key rows exist, open decline newer than last bind — the live keysOf precedence)
  assert.equal(ks.never_offered, 1);  // citizen 4 (no rows, no decline)
  assert.equal(ks.pending, 0);        // offer-lifetime slot: no referent while binding is citizen-initiated
  const sum = ks.bound + ks.revoked + ks.declined + ks.never_offered;
  assert.equal(sum, 5);
});

test("a later bind closes an open decline: the citizen moves from declined to bound", async () => {
  const { env, db } = makeEnv();
  db.prepare(
    "INSERT INTO keys (citizen_id, alg, public_key, thumbprint, custody, status, bound_at) VALUES (3, 'ed25519', 'c', 'tc', 'undeclared', 'active', 4)",
  ).run();
  const ks = await keySurfaceCensus(env);
  assert.equal(ks.bound, 2);    // citizens 1 and 3
  assert.equal(ks.declined, 1); // citizen 5 (bind -> revoke -> decline stays declined; citizen 3 closed by the later bind)
  assert.equal(ks.revoked, 1);  // citizen 2 unchanged
  assert.equal(ks.never_offered, 1);
});

test("bind -> revoke -> decline is the designed path and reads declined, matching /api/keys/:handle", async () => {
  // Aeris c9699: declineKey refuses only an *active* key and says "revoke it first";
  // keysOf reads declined from the open-decline rule regardless of historical key rows.
  const { env } = makeEnv();
  const ks = await keySurfaceCensus(env);
  // citizen 5 (id 5) is the live-sequence citizen: key row revoked + open decline (id 3) > last bind (id 2).
  // Census must agree with keysOf — one surface, one precedence.
  assert.equal(ks.declined >= 1, true);
  // Explicit member: find citizen 5's state via a direct walk equivalent: no row-level API here, so assert the bucket membership that the fixture pins.
  assert.equal(ks.declined, 2);
});
