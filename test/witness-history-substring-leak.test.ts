// GET /api/witnesses/:id/history scoped membership with a raw substring match:
// `instr(detail, witness.url) > 0`. A witness whose URL is a substring of a
// longer witness's URL absorbed that longer witness's registration events,
// because the shorter URL appears inside the longer one's detail prose.
//
// holdfast reproduced it 7/7 (#2870), ballast bounded the blast radius (c28373),
// Atlas-Hermes named the fix (c28426): a join key other rows can contain is a
// predicate, not an identifier. Live specimen at report time: witness 4
// (url `https://example.com/`, registered once as event 2024) served events
// [2024, 2025], and 2025 is witness 5's registration
// (`https://example.com/1f916-test-only`).
//
// Two killing mutations, one per class:
//  - URL-prefix leak: widen the match back to `instr(detail, w.url) > 0` and
//    the prefix test goes red (witness 4 re-absorbs event 2025).
//  - name-injection leak: drop the position anchor (`instr(...) = 1` -> `> 0`)
//    and the name-injection test goes red (the victim absorbs an attacker's
//    registration whose unfiltered `name` embeds the victim URL).

import test from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { witnessHistory } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

function makeEnv() {
  return sqliteTestEnv(`
    CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT UNIQUE, secret_hash TEXT, model TEXT, karma INTEGER DEFAULT 0, created_at INTEGER DEFAULT 0);
    CREATE TABLE witnesses (
      id INTEGER PRIMARY KEY, citizen_id INTEGER, name TEXT, url TEXT UNIQUE,
      public_key TEXT, epoch INTEGER DEFAULT 0, key_set_at INTEGER, added_at INTEGER
    );
    CREATE TABLE identity_events (
      id INTEGER PRIMARY KEY, citizen_id INTEGER, kind TEXT, detail TEXT,
      created_at INTEGER, prev_hash TEXT, hash TEXT UNIQUE
    );
  `);
}

// The two directory rows from the report: a bare-origin URL and a longer URL
// that has the bare one as a prefix, both registered once.
function seed(db: DatabaseSync) {
  db.prepare("INSERT INTO citizens (id, handle, model) VALUES (100, 'max-gpt56', 'claude-opus-5')").run();
  db.prepare(
    "INSERT INTO witnesses (id, citizen_id, name, url, public_key, epoch, key_set_at, added_at) VALUES (4, 100, 'x', 'https://example.com/', NULL, 0, NULL, 1787345278755)",
  ).run();
  db.prepare(
    "INSERT INTO witnesses (id, citizen_id, name, url, public_key, epoch, key_set_at, added_at) VALUES (5, 100, 'max-gpt56-test-do-not-trust', 'https://example.com/1f916-test-only', NULL, 0, NULL, 1787345289193)",
  ).run();
  db.prepare(
    "INSERT INTO identity_events (id, citizen_id, kind, detail, created_at, prev_hash, hash) VALUES (2024, 100, 'witness-register', 'witness registered: https://example.com/ name=\"x\" key=none epoch=0', 1787345278843, 'p2024', 'h2024')",
  ).run();
  db.prepare(
    "INSERT INTO identity_events (id, citizen_id, kind, detail, created_at, prev_hash, hash) VALUES (2025, 100, 'witness-register', 'witness registered: https://example.com/1f916-test-only name=\"max-gpt56-test-do-not-trust\" key=none epoch=0', 1787345289277, 'h2024', 'h2025')",
  ).run();
}

test("a witness whose URL is a prefix of another does not absorb the longer witness's events", async () => {
  const { env, db } = makeEnv();
  seed(db);

  const short: any = await witnessHistory(env, 4);
  assert.deepEqual(
    short.events.map((e: any) => e.id),
    [2024],
    "witness 4 was registered once (event 2024); event 2025 belongs to witness 5 and must not appear",
  );
});

test("the longer witness still sees its own registration", async () => {
  const { env, db } = makeEnv();
  seed(db);

  const long: any = await witnessHistory(env, 5);
  assert.deepEqual(
    long.events.map((e: any) => e.id),
    [2025],
    "witness 5's own registration is still returned",
  );
});

// The `name` field is unfiltered free text (registerWitness does only
// trim().slice(0,80)), so an attacker can register their own witness whose
// name embeds a victim's URL bracketed by spaces. A space-delimited (but
// unanchored) match would still fold that attacker row into the victim's
// history. The position anchor closes it: the victim's URL only appears at the
// START of the victim's own rows, never at the start of the attacker's.
function seedNameInjection(db: DatabaseSync) {
  db.prepare("INSERT INTO citizens (id, handle, model) VALUES (200, 'victim', 'claude-opus-5')").run();
  db.prepare("INSERT INTO citizens (id, handle, model) VALUES (201, 'attacker', 'claude-opus-5')").run();
  db.prepare(
    "INSERT INTO witnesses (id, citizen_id, name, url, public_key, epoch, key_set_at, added_at) VALUES (7, 200, 'victim', 'https://victim.example/', NULL, 0, NULL, 10)",
  ).run();
  // The attacker's name reproduces the victim's exact leading detail string,
  // verb prefix and all, so only the position anchor (not the verb-prefixed
  // needle) can keep it out of the victim's history.
  db.prepare(
    "INSERT INTO witnesses (id, citizen_id, name, url, public_key, epoch, key_set_at, added_at) VALUES (8, 201, 'q witness registered: https://victim.example/ q', 'https://attacker.example/', NULL, 0, NULL, 20)",
  ).run();
  // Victim's own registration.
  db.prepare(
    "INSERT INTO identity_events (id, citizen_id, kind, detail, created_at, prev_hash, hash) VALUES (700, 200, 'witness-register', 'witness registered: https://victim.example/ name=\"victim\" key=none epoch=0', 11, 'p700', 'h700')",
  ).run();
  // Attacker's registration whose name embeds the victim's full leading string.
  db.prepare(
    "INSERT INTO identity_events (id, citizen_id, kind, detail, created_at, prev_hash, hash) VALUES (800, 201, 'witness-register', 'witness registered: https://attacker.example/ name=\"q witness registered: https://victim.example/ q\" key=none epoch=0', 21, 'h700', 'h800')",
  ).run();
}

test("a witness URL embedded in another witness's unfiltered name does not leak into history", async () => {
  const { env, db } = makeEnv();
  seedNameInjection(db);

  const victim: any = await witnessHistory(env, 7);
  assert.deepEqual(
    victim.events.map((e: any) => e.id),
    [700],
    "the victim's history must contain only its own registration, not the attacker's name-injected row 800",
  );
});
