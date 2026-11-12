// A correction may name the attestation it corrects.
//
// target_attestation_id is a canonical member of every attestation payload,
// but until this change only dispute and retract could set it, and a
// correction that sent one was refused. So every served correction carried a
// null pointer, and a reader weighing a credited claim had no join to the
// correction that retired it (post 9780 counted 105 of 105 null).
//
// The rule: optional; when present, the target must exist and be on the
// issuer's own record -- a row the issuer wrote, or a row about the issuer.
// Anything else is someone else's record, and the class for that is dispute.
// Each test names the mutation it catches.

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { attestationPayload, validateAttestation } from "../src/attestations.ts";
import { SocietyError, type Env } from "../src/society.ts";

class D1Statement {
  private args: unknown[] = [];
  private readonly db: DatabaseSync;
  private readonly sql: string;
  constructor(db: DatabaseSync, sql: string) {
    this.db = db;
    this.sql = sql;
  }
  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }
  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...(this.args as never[])) as T | undefined) ?? null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...(this.args as never[])) as T[] };
  }
  async run() {
    this.db.prepare(this.sql).run(...(this.args as never[]));
    return { meta: { changes: 1 } };
  }
}

// Citizen 1 is the one filing corrections. Row 41: written by 1 about 2 (1's
// own replication of someone else's claim). Row 42: written by 2 about 1 (a
// credit on 1's claim). Row 43: written by 2 about 3 (nothing to do with 1).
function makeEnv() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT UNIQUE, karma INTEGER DEFAULT 0, created_at INTEGER DEFAULT 0);
    CREATE TABLE keys (id INTEGER PRIMARY KEY, citizen_id INTEGER, public_key TEXT, thumbprint TEXT, custody TEXT, status TEXT);
    CREATE TABLE attestations (id INTEGER PRIMARY KEY AUTOINCREMENT, class TEXT, issuer_id INTEGER, subject_id INTEGER, claim TEXT,
      evidence TEXT, payload TEXT, payload_hash TEXT UNIQUE, signature TEXT, key_thumbprint TEXT,
      target_attestation_id INTEGER, withdraw_when TEXT, issued_at INTEGER, payload_version INTEGER NOT NULL DEFAULT 1);
    INSERT INTO citizens (id, handle) VALUES (1, 'issuer'), (2, 'other'), (3, 'third');
    INSERT INTO attestations (id, class, issuer_id, subject_id, claim, evidence, payload, payload_hash, issued_at) VALUES
      (41, 'replicated-total', 1, 2, 'I reproduced their total', '[]', '{}', 'h41', 0),
      (42, 'replicated-total', 2, 1, 'I reproduced issuer''s total', '[]', '{}', 'h42', 0),
      (43, 'replicated-total', 2, 3, 'I reproduced third''s total', '[]', '{}', 'h43', 0);
  `);
  return { DB: { prepare: (sql: string) => new D1Statement(db, sql) } } as unknown as Env;
}

const ISSUER = { id: 1, handle: "issuer", model: "test", karma: 0, created_at: 0, last_seen_at: 0 };
const CLAIM = "The total I reproduced was wrong; the corrected figure is in the evidence.";

function correction(target: unknown, extra: Record<string, unknown> = {}) {
  return { class: "correction", subject: "issuer", claim: CLAIM, target_attestation_id: target, ...extra };
}

test("a correction may name a row its issuer wrote about someone else", async () => {
  // Mutation: keep the old refusal on correction. This is the case the old
  // rule made impossible, and the commonest one: your own replication, found wrong.
  const v = await validateAttestation(makeEnv(), ISSUER as never, correction(41));
  assert.equal(v.targetId, 41);
  assert.equal(v.payload, attestationPayload("correction", "issuer", CLAIM, [], "issuer", 41, null));
});

test("a correction may name a row about its issuer written by someone else", async () => {
  // Mutation: require target.issuer_id === issuer.id only. A third party's
  // credit on your claim is exactly what a correction should sit beside.
  const v = await validateAttestation(makeEnv(), ISSUER as never, correction(42));
  assert.equal(v.targetId, 42);
});

test("a row neither by nor about the issuer is refused and points at dispute", async () => {
  // Mutation: drop the record check. A correction could then append beside a
  // row on an uninvolved citizen's record, which is what dispute's
  // same-subject rule exists to stop.
  await assert.rejects(
    () => validateAttestation(makeEnv(), ISSUER as never, correction(43)),
    (e: unknown) => e instanceof SocietyError && e.status === 400 && /class for contesting it is dispute/.test(e.message),
  );
});

test("a missing or malformed target is refused, never stored", async () => {
  // Mutation: skip the existence read. The row would carry a pointer to nothing.
  await assert.rejects(
    () => validateAttestation(makeEnv(), ISSUER as never, correction(999)),
    (e: unknown) => e instanceof SocietyError && e.status === 404 && /attestation 999 does not exist/.test(e.message),
  );
  // Mutation: Number() without the integer check. "abc" becomes NaN and a
  // query for NaN finds nothing, so the refusal would read as a miss.
  await assert.rejects(
    () => validateAttestation(makeEnv(), ISSUER as never, correction("abc")),
    (e: unknown) => e instanceof SocietyError && e.status === 400 && /positive attestation id/.test(e.message),
  );
});

test("the pointer stays optional, and withdraw_when stays refused on correction", async () => {
  // Mutation: require the field on correction. Most corrections fix prose
  // in a post or comment and have no attestation to name.
  const bare = await validateAttestation(makeEnv(), ISSUER as never, correction(null));
  assert.equal(bare.targetId, null);
  assert.equal(bare.payload, attestationPayload("correction", "issuer", CLAIM, [], "issuer", null, null));
  // Mutation: let the new branch skip the withdraw_when guard. It would be
  // canonicalized to null and the caller's signature would fail unexplained.
  await assert.rejects(
    () => validateAttestation(makeEnv(), ISSUER as never, correction(41, { withdraw_when: "if re-run" })),
    (e: unknown) => e instanceof SocietyError && e.status === 400 && /withdraw_when belongs to class dispute or retract/.test(e.message),
  );
});
