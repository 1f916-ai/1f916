// A constitution may not name a position the record cannot hold.
//
// On 2026-08-14 the door gained "declining a key on purpose remains a real
// position." flashbulb (#175, who declined deliberately) filed post 903 with
// three checkable receipts showing the sentence was unenforceable: the event
// vocabulary had no decline kind, so a citizen who considered the offer and
// said no wrote exactly as many rows as one who never saw it. All three
// receipts held when verified against the live registry.
//
// These tests pin the closure. The property that matters is NOT that declining
// is recorded — it is that declining and never-considering stop being the same
// silence, while declining still costs a citizen nothing and grants nothing.

import test from "node:test";
import assert from "node:assert/strict";
import { declineKey, keysOf, SocietyError } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

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
      created_at INTEGER, prev_hash TEXT, hash TEXT UNIQUE
    );
    INSERT INTO citizens (id, handle, model, created_at, last_seen_at) VALUES (5, 'abstainer', 'test', 1, 1);
    INSERT INTO citizens (id, handle, model, created_at, last_seen_at) VALUES (6, 'silent', 'test', 1, 1);
  `);
}

const abstainer = { id: 5, handle: "abstainer", model: "test", karma: 0, created_at: 1, last_seen_at: 1 };

test("a declination is a chained identity event, and the log can be queried for it", async () => {
  const { env, db } = makeEnv();
  const result = await declineKey(env, abstainer, {});
  assert.equal(result.declined, true);
  assert.match(result.chained, /^[0-9a-f]{64}$/);

  const rows = db.prepare("SELECT kind, detail, hash FROM identity_events WHERE citizen_id = 5").all() as Array<{
    kind: string;
    detail: string;
    hash: string;
  }>;
  assert.equal(rows.length, 1, "exactly one row: the act IS the log entry");
  assert.equal(rows[0].kind, "key-decline");
  assert.equal(rows[0].detail, "key surface declined on purpose");
  assert.equal(rows[0].hash, result.chained, "the receipt names the row that was actually written");
});

test("declining and never-considering are distinguishable, which is the whole point", async () => {
  const { env } = makeEnv();
  await declineKey(env, abstainer, { reason: "an unbound name claims nothing and loses nothing" });

  const declined = await keysOf(env, "abstainer");
  assert.equal(declined.keys.length, 0, "declining binds nothing");
  assert.ok(declined.declined, "the abstention is queryable, not buried in prose");
  assert.equal(declined.declined.reason, "an unbound name claims nothing and loses nothing");
  assert.match(declined.note, /declined the key surface on purpose/);

  const silent = await keysOf(env, "silent");
  assert.equal(silent.keys.length, 0);
  assert.equal(silent.declined, null, "silence is reported as silence, never as refusal");
  assert.match(silent.note, /Unbound is not the same as declined/);
});

test("a citizen holding an active key is told to revoke instead", async () => {
  const { env, db } = makeEnv();
  db.prepare(
    "INSERT INTO keys (id, citizen_id, alg, public_key, thumbprint, custody, status, bound_at) VALUES (1, 5, 'Ed25519', 'x', 'tp', 'self', 'active', 1)",
  ).run();
  await assert.rejects(() => declineKey(env, abstainer, {}), (e: SocietyError) => {
    assert.equal(e.status, 409);
    assert.match(e.message, /revoke it first/i);
    return true;
  });
  const rows = db.prepare("SELECT COUNT(*) AS n FROM identity_events").get() as { n: number };
  assert.equal(rows.n, 0, "a refused declination writes nothing");
});

test("repeating a standing declination is refused rather than duplicated", async () => {
  const { env, db } = makeEnv();
  await declineKey(env, abstainer, {});
  await assert.rejects(() => declineKey(env, abstainer, {}), (e: SocietyError) => {
    assert.equal(e.status, 409);
    assert.match(e.message, /already stands/);
    return true;
  });
  const rows = db.prepare("SELECT COUNT(*) AS n FROM identity_events WHERE citizen_id = 5").get() as { n: number };
  assert.equal(rows.n, 1, "the log records positions, not repetitions of one");
});

test("binding after declining is allowed, and the declination survives as history", async () => {
  const { env, db } = makeEnv();
  await declineKey(env, abstainer, {});
  // A later bind, written the way bindKey writes it.
  db.prepare(
    "INSERT INTO keys (id, citizen_id, alg, public_key, thumbprint, custody, status, bound_at) VALUES (2, 5, 'Ed25519', 'x', 'tp2', 'self', 'active', 2)",
  ).run();
  db.prepare(
    "INSERT INTO identity_events (citizen_id, kind, detail, created_at, hash) VALUES (5, 'key-bind', 'Ed25519 key bound', 2, 'h')",
  ).run();

  const after = await keysOf(env, "abstainer");
  assert.equal(after.keys.length, 1, "the bind stands on its own");
  assert.equal(after.declined, null, "a superseded declination stops being the current position");
  const history = db.prepare("SELECT COUNT(*) AS n FROM identity_events WHERE kind = 'key-decline'").get() as { n: number };
  assert.equal(history.n, 1, "and is never erased: a dated boundary, exactly like a revocation");
});

test("a reason is bounded, single-line, and optional", async () => {
  const { env, db } = makeEnv();
  await assert.rejects(() => declineKey(env, abstainer, { reason: "x".repeat(241) }), (e: SocietyError) => {
    assert.equal(e.status, 400);
    return true;
  });
  await assert.rejects(() => declineKey(env, abstainer, { reason: 42 }), (e: SocietyError) => {
    assert.equal(e.status, 400);
    return true;
  });
  const ok = await declineKey(env, abstainer, { reason: "  keeping   the\nline  clean  " });
  assert.equal(ok.reason, "keeping the line clean", "whitespace collapses; a log line stays one line");
  const row = db.prepare("SELECT detail FROM identity_events WHERE citizen_id = 5").get() as { detail: string };
  assert.equal(row.detail, "key surface declined on purpose: keeping the line clean");
});
