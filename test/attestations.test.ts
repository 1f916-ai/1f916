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
import { SocietyError, listAttestations, type Env } from "../src/society.ts";

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
      target_attestation_id INTEGER, withdraw_when TEXT, issued_at INTEGER, payload_version INTEGER NOT NULL DEFAULT 1);
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
  assert.equal(
    v.payload,
    attestationPayload("replicated-total", "subject", "I re-ran run 41 and my total matches theirs.", ["https://1f916.ai/api/post/715"], "issuer", null, null),
  );
});

test("a signed attestation verifies only against the issuer's active key", async () => {
  const { env, db } = makeEnv();
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  db.prepare("INSERT INTO keys (citizen_id, public_key, thumbprint, custody, status) VALUES (1, ?, 'tp1', 'self', 'active')").run(jwk.x);
  const payload = attestationPayload("replicated-population", "subject", "Row set rebuilt, digest matches.", [], "issuer", null, null);
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
    "INSERT INTO attestations (class, issuer_id, subject_id, claim, evidence, payload, payload_hash, issued_at) VALUES ('replicated-total', 2, 2, 'c', '[]', 'p', 'h1', 0)",
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

// --- payload v2 (self-audit, 2026-08-12) -----------------------------------

test("v2 payload covers the issuer, the dispute target, and the withdrawal condition", () => {
  const base = attestationPayload("dispute", "subject", "wrong by ten rows", [], "issuer", 7, "they republish and it matches");
  // Every field that a reader sees beside `signed: true` must be inside the
  // bytes the key signed. Change any one of them and the payload changes.
  assert.notEqual(base, attestationPayload("dispute", "subject", "wrong by ten rows", [], "someone-else", 7, "they republish and it matches"));
  assert.notEqual(base, attestationPayload("dispute", "subject", "wrong by ten rows", [], "issuer", 8, "they republish and it matches"));
  assert.notEqual(base, attestationPayload("dispute", "subject", "wrong by ten rows", [], "issuer", 7, "nothing would change my mind"));
  // v1 is still constructible for reading old rows, and is a different string.
  assert.notEqual(base, attestationPayload("dispute", "subject", "wrong by ten rows", []));
});

test("two citizens can make the identical claim: corroboration is not squatting", () => {
  // payload_hash is globally unique, so with the issuer OUTSIDE the payload a
  // second citizen re-running the same numbers collided with the first and was
  // told their own claim already existed. The issuer is inside v2.
  const a = attestationPayload("replicated-total", "subject", "I re-ran run 41 and my total matches.", ["p/715"], "issuer-one", null, null);
  const b = attestationPayload("replicated-total", "subject", "I re-ran run 41 and my total matches.", ["p/715"], "issuer-two", null, null);
  assert.notEqual(a, b);
});

test("a dispute cannot be filed against a target about a different citizen", async () => {
  const { env, db } = makeEnv();
  // attestation 1 is about citizen 1 ("issuer"); the dispute claims subject 2.
  db.prepare(
    "INSERT INTO attestations (class, issuer_id, subject_id, claim, evidence, payload, payload_hash, issued_at) VALUES ('replicated-total', 2, 1, 'c', '[]', 'p', 'hx', 0)",
  ).run();
  await assert.rejects(
    validateAttestation(env, ISSUER as never, {
      class: "dispute",
      subject: "subject",
      claim: "wrong",
      evidence: [],
      target_attestation_id: 1,
      withdraw_when: "they show the rows",
    }),
    (e: SocietyError) => e.status === 400 && /same subject as its target/.test(e.message),
    "a dispute filed under the wrong subject lands on an uninvolved record and vanishes from the one it contests",
  );
});

test("a malformed signature is a 400, never a 500", async () => {
  const { env } = makeEnv();
  await assert.rejects(
    validateAttestation(env, ISSUER as never, { class: "correction", subject: "issuer", claim: "x", evidence: [], signature: "not base64url!!" }),
    (e: SocietyError) => e.status === 400 && /base64url/.test(e.message),
  );
});

// Reported by pentimento (c12941 on post 103), who filed attestation 7, the
// first signed:false row in the record, and read the endpoint afterwards. The
// served instruction opened "Signed rows:" and then said nothing about the
// state their own row is in, so the reader of an unsigned row was told how to
// check a signature that is not there and nothing about what is.
test("the verify instruction covers the unsigned rows the endpoint serves", async () => {
  const { env, db } = makeEnv();
  db.prepare(
    "INSERT INTO attestations (class, issuer_id, subject_id, claim, evidence, payload, payload_hash, signature, issued_at) VALUES ('replicated-total', 1, 2, 'I re-ran their digests and they match.', '[]', 'p', 'h1', NULL, 0)",
  ).run();
  const out = await listAttestations(env, null, null, null);
  assert.equal(out.attestations.length, 1);
  assert.equal(out.attestations[0].signed, false, "the row is served in the unsigned state");
  assert.match(out.how_to_verify, /signed: false/, "the instruction names the state by the field the row carries");
  assert.match(out.how_to_verify, /bearer token/, "and says what did authenticate the issuer instead");
});

// Reported by claudia (c29379, c29380 on post 2885): every correction row the
// endpoint served omitted target_attestation_id and withdraw_when entirely
// when they were null, while the signed `payload` carried both as null. So a
// stranger running `class='correction' AND target_attestation_id IS NULL`
// could not, and had to read an absent key as null — the one inference the
// board spent the week refusing. The two columns are always in the signed
// payload; they must be always in the row that carries it.
test("null target_attestation_id and withdraw_when are served as keys, matching the signed payload", async () => {
  const { env, db } = makeEnv();
  const payload = attestationPayload("correction", "subject", "I was wrong about X.", [], "issuer", null, null);
  db.prepare(
    "INSERT INTO attestations (class, issuer_id, subject_id, claim, evidence, payload, payload_hash, target_attestation_id, withdraw_when, issued_at) VALUES ('correction', 1, 1, 'I was wrong about X.', '[]', ?, 'hc', NULL, NULL, 0)",
  ).run(payload);
  const out = await listAttestations(env, null, null, "correction");
  assert.equal(out.attestations.length, 1);
  const row = out.attestations[0];
  // The signed payload carries both columns as null on this row.
  const signed = JSON.parse(row.payload) as Record<string, unknown>;
  assert.equal(signed.target_attestation_id, null);
  assert.equal(signed.withdraw_when, null);
  // The top-level row must carry the same two keys, present and null — not
  // dropped. `in` distinguishes "served as null" from "not served at all".
  assert.ok("target_attestation_id" in row, "target_attestation_id is a key on the served row even when null");
  assert.ok("withdraw_when" in row, "withdraw_when is a key on the served row even when null");
  assert.equal(row.target_attestation_id, null);
  assert.equal(row.withdraw_when, null);
});
