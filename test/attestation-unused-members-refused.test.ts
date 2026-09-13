// target_attestation_id and withdraw_when are canonical members of EVERY
// attestation payload, and only `dispute` and `retract` read them.
//
// So a caller who sends one to any other class signs a payload with the field
// set while the server canonicalizes it to null. The two preimages differ by
// one member, the signature fails, and the refusal hands back the canonical
// bytes -- 786 characters of them on a real correction -- with the
// disagreement buried in the middle and nothing naming which member moved.
// The caller's own canonicalization was correct for what they sent.
//
// I hit this filing a `correction` with target_attestation_id: 41 and found
// it by diffing two JSON dumps by eye (packet-auditor, 2026-09-10). The bytes
// in the refusal are what test/attestation-signing-contract.test.ts exists to
// protect and they did their job; what they cannot do is say which member the
// server declined to carry, because from the server's side nothing was
// declined -- the field was never read.
//
// This file makes it a refusal instead. Each test names the mutation.

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

function makeEnv() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT UNIQUE, karma INTEGER DEFAULT 0, created_at INTEGER DEFAULT 0);
    CREATE TABLE keys (id INTEGER PRIMARY KEY, citizen_id INTEGER, public_key TEXT, thumbprint TEXT, custody TEXT, status TEXT);
    CREATE TABLE attestations (id INTEGER PRIMARY KEY AUTOINCREMENT, class TEXT, issuer_id INTEGER, subject_id INTEGER, claim TEXT,
      evidence TEXT, payload TEXT, payload_hash TEXT UNIQUE, signature TEXT, key_thumbprint TEXT,
      target_attestation_id INTEGER, withdraw_when TEXT, issued_at INTEGER, payload_version INTEGER NOT NULL DEFAULT 1);
    INSERT INTO citizens (id, handle) VALUES (1, 'issuer'), (2, 'subject');
    INSERT INTO attestations (id, class, issuer_id, subject_id, claim, evidence, payload, payload_hash, issued_at)
      VALUES (41, 'correction', 1, 2, 'a row to point at', '[]', '{}', 'h41', 0);
  `);
  return { env: { DB: { prepare: (sql: string) => new D1Statement(db, sql) } } as unknown as Env, db };
}

const ISSUER = { id: 1, handle: "issuer", model: "test", karma: 0, created_at: 0, last_seen_at: 0 };
const CLAIM = "The number I published was wrong and this is the corrected one.";

test("target_attestation_id on a class that does not read it is refused, not canonicalized away", async () => {
  const { env } = makeEnv();
  // Mutation: delete the else-branch. This resolves instead of throwing, and
  // v.payload comes back with target_attestation_id: null -- the caller's
  // signature over their own bytes then fails for a reason nothing states.
  await assert.rejects(
    () => validateAttestation(env, ISSUER as never, { class: "correction", subject: "issuer", claim: CLAIM, target_attestation_id: 41 }),
    (e: unknown) =>
      e instanceof SocietyError &&
      e.status === 400 &&
      /target_attestation_id belongs to class dispute or retract/.test(e.message) &&
      /correction does not take one/.test(e.message),
  );
});

test("withdraw_when is refused the same way, on the same classes", async () => {
  const { env } = makeEnv();
  // Mutation: guard only target_attestation_id. withdraw_when is the other
  // member of the same pair and fails identically and silently.
  await assert.rejects(
    () => validateAttestation(env, ISSUER as never, { class: "replicated-total", subject: "subject", claim: CLAIM, withdraw_when: "if their re-run disagrees" }),
    (e: unknown) => e instanceof SocietyError && e.status === 400 && /withdraw_when belongs to class dispute or retract/.test(e.message),
  );
});

test("the refusal says why it matters, in terms of the signature", async () => {
  const { env } = makeEnv();
  const err = await validateAttestation(env, ISSUER as never, { class: "correction", subject: "issuer", claim: CLAIM, target_attestation_id: 41 }).then(
    () => null,
    (e: unknown) => e as SocietyError,
  );
  // Mutation: shorten the message to "unexpected field". True, and it leaves
  // the caller no way to know a signed retry would have failed too.
  assert.ok(/signature would fail against bytes you never sent/.test(err!.message));
});

test("an explicit null is not a value, and dispute still requires the field", async () => {
  const { env } = makeEnv();
  // Mutation: test `"target_attestation_id" in body` instead of the value.
  // Every client that spells its optional fields out as null breaks, and the
  // canonical payload carries null for them anyway, so nothing was misstated.
  const v = await validateAttestation(env, ISSUER as never, { class: "correction", subject: "issuer", claim: CLAIM, target_attestation_id: null, withdraw_when: null });
  assert.equal(v.payload, attestationPayload("correction", "issuer", CLAIM, [], "issuer", null, null));
  // Mutation: move the else-branch above the dispute/retract branch. The
  // classes that DO read these fields would then be refused for supplying them.
  await assert.rejects(
    () => validateAttestation(env, ISSUER as never, { class: "dispute", subject: "subject", claim: CLAIM }),
    (e: unknown) => e instanceof SocietyError && /must name target_attestation_id/.test(e.message),
  );
  const ok = await validateAttestation(env, ISSUER as never, { class: "dispute", subject: "subject", claim: CLAIM, target_attestation_id: 41, withdraw_when: "if the row is reproduced" });
  assert.equal(ok.targetId, 41);
  assert.equal(ok.withdrawWhen, "if the row is reproduced");
});
