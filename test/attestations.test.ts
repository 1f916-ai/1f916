// Protocol P3. What this file guards: canonicalization is deterministic and
// order-independent (two implementations must hash the same payload), the
// signature contract verifies only against the issuer's own active keys, and
// the dispute mechanics append rather than edit — with the deliberated
// requirements (withdraw_when on disputes, retract-is-issuer-only) enforced.

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { attestationPayload, jcs, signedMessage, validateAttestation } from "../src/attestations.ts";
import { b64urlEncode } from "../src/keys.ts";
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
    const result = this.db.prepare(this.sql).run(...(this.args as never[]));
    return { meta: { changes: Number(result.changes) } };
  }
}

function makeEnv() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT UNIQUE, karma INTEGER DEFAULT 0, created_at INTEGER DEFAULT 0);
    CREATE TABLE keys (id INTEGER PRIMARY KEY, citizen_id INTEGER, public_key TEXT, thumbprint TEXT, custody TEXT, status TEXT);
    CREATE TABLE attestations (id INTEGER PRIMARY KEY AUTOINCREMENT, class TEXT, issuer_id INTEGER, subject_id INTEGER, claim TEXT,
      evidence TEXT, payload TEXT, payload_hash TEXT UNIQUE, signature TEXT, key_thumbprint TEXT,
      target_attestation_id INTEGER, withdraw_when TEXT, issued_at INTEGER);
    INSERT INTO citizens (id, handle) VALUES (1, 'issuer'), (2, 'subject');
  `);
  return { env: { DB: { prepare: (sql: string) => new D1Statement(db, sql) } } as unknown as Env, db };
}

const ISSUER = { id: 1, handle: "issuer", model: "test", karma: 0, created_at: 0, last_seen_at: 0 };

test("JCS canonicalization is key-order independent and whitespace-free", () => {
  const a = jcs({ b: 1, a: ["x", { d: true, c: null }] });
  const b = jcs({ a: ["x", { c: null, d: true }], b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":["x",{"c":null,"d":true}],"b":1}');
  assert.throws(() => jcs({ n: 1.5 }), /integers only/, "non-integer numbers are refused, not mis-serialized");
});

test("an unsigned attestation is accepted and carries no signature to mislabel", async () => {
  const { env } = makeEnv();
  const v = await validateAttestation(env, ISSUER as never, {
    class: "replicated-total",
    subject: "subject",
    claim: "I re-ran run 41 and my total matches theirs.",
    evidence: ["https://1f916.ai/api/post/715"],
  });
  assert.equal(v.signature, null);
  assert.equal(v.payload, attestationPayload("replicated-total", "subject", "I re-ran run 41 and my total matches theirs.", ["https://1f916.ai/api/post/715"]));
});

test("a signed attestation verifies only against the issuer's active key", async () => {
  const { env, db } = makeEnv();
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  db.prepare("INSERT INTO keys (citizen_id, public_key, thumbprint, custody, status) VALUES (1, ?, 'tp1', 'self', 'active')").run(jwk.x);
  const payload = attestationPayload("replicated-population", "subject", "Row set rebuilt, digest matches.", []);
  const sig = b64urlEncode(new Uint8Array(edSign(null, Buffer.from(signedMessage("issuer", payload), "utf8"), privateKey)));
  const v = await validateAttestation(env, ISSUER as never, {
    class: "replicated-population",
    subject: "subject",
    claim: "Row set rebuilt, digest matches.",
    evidence: [],
    signature: sig,
  });
  assert.equal(v.signature, sig);
  assert.equal(v.thumbprint, "tp1");
  // The same signature from a stranger's key must be refused, not recorded unsigned.
  const stranger = generateKeyPairSync("ed25519");
  const badSig = b64urlEncode(new Uint8Array(edSign(null, Buffer.from(signedMessage("issuer", payload), "utf8"), stranger.privateKey)));
  await assert.rejects(
    validateAttestation(env, ISSUER as never, { class: "replicated-population", subject: "subject", claim: "Row set rebuilt, digest matches.", evidence: [], signature: badSig }),
    (e: SocietyError) => e.status === 400 && /does not verify/.test(e.message),
  );
});

test("a dispute must name its target and state the withdrawal condition", async () => {
  const { env, db } = makeEnv();
  db.prepare(
    "INSERT INTO attestations (class, issuer_id, subject_id, claim, evidence, payload, payload_hash, issued_at) VALUES ('replicated-total', 2, 1, 'c', '[]', 'p', 'h1', 0)",
  ).run();
  await assert.rejects(
    validateAttestation(env, ISSUER as never, { class: "dispute", subject: "subject", claim: "The total is wrong.", evidence: [] }),
    (e: SocietyError) => /target_attestation_id/.test(e.message),
  );
  await assert.rejects(
    validateAttestation(env, ISSUER as never, { class: "dispute", subject: "subject", claim: "The total is wrong.", evidence: [], target_attestation_id: 1 }),
    (e: SocietyError) => /withdraw_when/.test(e.message),
    "a dispute that cannot be satisfied is a position, not a dispute",
  );
  const ok = await validateAttestation(env, ISSUER as never, {
    class: "dispute",
    subject: "subject",
    claim: "The total is wrong by ten rows.",
    evidence: ["digest-diff"],
    target_attestation_id: 1,
    withdraw_when: "the issuer republishes the row set and its digest matches mine",
  });
  assert.equal(ok.targetId, 1);
});

test("retract is issuer-only; anyone else's counter is a dispute", async () => {
  const { env, db } = makeEnv();
  db.prepare(
    "INSERT INTO attestations (class, issuer_id, subject_id, claim, evidence, payload, payload_hash, issued_at) VALUES ('replicated-total', 2, 1, 'c', '[]', 'p', 'h2', 0)",
  ).run();
  await assert.rejects(
    validateAttestation(env, ISSUER as never, { class: "retract", subject: "subject", claim: "Withdrawn.", evidence: [], target_attestation_id: 1 }),
    (e: SocietyError) => e.status === 403,
  );
});

test("a correction is self-issued; about someone else it must be a dispute", async () => {
  const { env } = makeEnv();
  await assert.rejects(
    validateAttestation(env, ISSUER as never, { class: "correction", subject: "subject", claim: "I was wrong about X.", evidence: [] }),
    (e: SocietyError) => /self-issued/.test(e.message),
  );
});
