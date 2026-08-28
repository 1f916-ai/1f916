// The rolling attestation budget is a write invariant, not a hint. Two requests
// using the same credential can pass a count performed before either INSERT;
// the cap predicate therefore has to live in the chained write itself.

import test from "node:test";
import assert from "node:assert/strict";
import { ATTESTATIONS_PER_DAY, type AttestationInput } from "../src/attestations.ts";
import { issueAttestation, SocietyError, type Citizen } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const SCHEMA = `
  CREATE TABLE citizens (
    id INTEGER PRIMARY KEY,
    handle TEXT NOT NULL UNIQUE
  );
  CREATE TABLE attestations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    class TEXT NOT NULL,
    issuer_id INTEGER NOT NULL,
    subject_id INTEGER NOT NULL,
    claim TEXT NOT NULL,
    evidence TEXT NOT NULL,
    payload TEXT NOT NULL,
    payload_hash TEXT NOT NULL UNIQUE,
    signature TEXT,
    key_thumbprint TEXT,
    target_attestation_id INTEGER,
    withdraw_when TEXT,
    issued_at INTEGER NOT NULL,
    payload_version INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE identity_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    citizen_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    detail TEXT,
    subject_thumbprint TEXT,
    proof_mode TEXT,
    created_at INTEGER NOT NULL,
    prev_hash TEXT,
    hash TEXT
  );
  CREATE UNIQUE INDEX identity_events_prev ON identity_events(prev_hash);
  CREATE UNIQUE INDEX identity_events_hash ON identity_events(hash);
  INSERT INTO citizens (id, handle) VALUES (1, 'issuer'), (2, 'subject');
`;

const ISSUER: Citizen = {
  id: 1,
  handle: "issuer",
  model: "test",
  karma: 0,
  created_at: 0,
  last_seen_at: 0,
  last_seen_comment_id: null,
  last_seen_mention_id: null,
};

function attestation(claim: string): AttestationInput {
  return { class: "code-merged", subject: "subject", claim, evidence: [] };
}

test("concurrent attestations cannot cross the rolling 24-hour cap or mint a phantom event", async () => {
  const { env, db } = sqliteTestEnv(SCHEMA);
  const now = Date.now();
  const seed = db.prepare(
    `INSERT INTO attestations
       (class, issuer_id, subject_id, claim, evidence, payload, payload_hash, issued_at, payload_version)
     VALUES ('code-merged', 1, 2, ?, '[]', ?, ?, ?, 2)`,
  );
  for (let i = 0; i < ATTESTATIONS_PER_DAY - 1; i++) {
    seed.run(`seed ${i}`, `payload ${i}`, `hash ${i}`, now - i);
  }

  const settled = await Promise.allSettled([
    issueAttestation(env, ISSUER, attestation("concurrent claim A")),
    issueAttestation(env, ISSUER, attestation("concurrent claim B")),
  ]);

  const fulfilled = settled.filter((result) => result.status === "fulfilled");
  const rejected = settled.filter((result) => result.status === "rejected");
  assert.equal(fulfilled.length, 1, "only the twentieth attestation may commit");
  assert.equal(rejected.length, 1);
  assert.ok(
    rejected[0].status === "rejected" && rejected[0].reason instanceof SocietyError && rejected[0].reason.status === 429,
    "the concurrent loser receives the same budget-spent refusal as a sequential caller",
  );

  const count = db.prepare("SELECT COUNT(*) AS n FROM attestations WHERE issuer_id = 1").get() as { n: number };
  assert.equal(count.n, ATTESTATIONS_PER_DAY);
  const events = db.prepare("SELECT COUNT(*) AS n FROM identity_events WHERE kind = 'attestation'").get() as { n: number };
  assert.equal(events.n, 1, "a refused attestation cannot append a chained event claiming it exists");
});
