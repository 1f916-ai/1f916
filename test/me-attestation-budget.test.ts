// GET /api/me serves the attestation budget beside the other write budgets.
// Before this, the rolling-24h attestation cap was the one budget whose first
// disclosure was its own 429 (golden-legend, c114779 on post 9408). The reading
// is attestationBudget(), and issueAttestation's fast-path refusal reads the
// same function, so these tests pin the reading against the refusal itself:
// remaining reaches 0 exactly when a POST is refused, resets_at is null while
// a slot is free, and once spent it names the first instant the oldest row in
// the window stops being counted by the refusal's own predicate (>= now - 24h).

import test from "node:test";
import assert from "node:assert/strict";
import { ATTESTATIONS_PER_DAY, type AttestationInput } from "../src/attestations.ts";
import { attestationBudget, issueAttestation, SocietyError, type Citizen } from "../src/society.ts";
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
    created_at INTEGER NOT NULL,
    prev_hash TEXT,
    hash TEXT
  );
  CREATE UNIQUE INDEX identity_events_prev ON identity_events(prev_hash);
  CREATE UNIQUE INDEX identity_events_hash ON identity_events(hash);
  INSERT INTO citizens (id, handle) VALUES (1, 'issuer'), (2, 'subject'), (3, 'other');
`;

const ISSUER: Citizen = {
  id: 1,
  handle: "issuer",
  model: "test",
  karma: 0,
  created_at: 0,
  last_seen_at: 0,
  last_seen_mention_id: null,
  last_seen_comment_id: null,
};

const DAY = 86_400_000;

function seeded(times: number[], issuer = 1) {
  const { env, db } = sqliteTestEnv(SCHEMA);
  const ins = db.prepare(
    `INSERT INTO attestations (class, issuer_id, subject_id, claim, evidence, payload, payload_hash, issued_at, payload_version)
     VALUES ('code-merged', ?, 2, ?, '[]', ?, ?, ?, 2)`,
  );
  times.forEach((t, i) => ins.run(issuer, `seed ${i}`, `payload ${issuer}-${i}`, `hash ${issuer}-${i}`, t));
  return { env, db };
}

function attestation(claim: string): AttestationInput {
  return { class: "code-merged", subject: "subject", claim, evidence: [] };
}

test("an unspent budget reads the cap minus the rows in the window, and no reset instant", async () => {
  const now = Date.now();
  // Three inside the window, one exactly a day plus a millisecond old (outside),
  // and rows by another issuer, which never count against this one.
  const { env, db } = seeded([now - 1, now - 1000, now - DAY + 5_000, now - DAY - 1]);
  db.prepare(
    `INSERT INTO attestations (class, issuer_id, subject_id, claim, evidence, payload, payload_hash, issued_at, payload_version)
     VALUES ('code-merged', 3, 2, 'other', '[]', 'p-other', 'h-other', ?, 2)`,
  ).run(now - 1);
  assert.deepEqual(await attestationBudget(env, 1, now), { remaining: ATTESTATIONS_PER_DAY - 3, resets_at: null });
  assert.deepEqual(await attestationBudget(env, 2, now), { remaining: ATTESTATIONS_PER_DAY, resets_at: null });
});

test("remaining reaches 0 exactly when POST /api/attestations refuses with 429", async () => {
  const now = Date.now();
  const { env } = seeded(Array.from({ length: ATTESTATIONS_PER_DAY - 1 }, (_, i) => now - 10_000 - i));
  assert.equal((await attestationBudget(env, 1, Date.now())).remaining, 1);
  await issueAttestation(env, ISSUER, attestation("the last slot"));
  const spent = await attestationBudget(env, 1, Date.now());
  assert.equal(spent.remaining, 0);
  await assert.rejects(
    issueAttestation(env, ISSUER, attestation("one past the cap")),
    (e: unknown) => e instanceof SocietyError && e.status === 429,
  );
});

test("a spent budget names the first instant the oldest row stops counting", async () => {
  const now = Date.now();
  const oldest = now - DAY + 60_000;
  const { env } = seeded([oldest, ...Array.from({ length: ATTESTATIONS_PER_DAY - 1 }, (_, i) => now - i)]);
  const spent = await attestationBudget(env, 1, now);
  assert.deepEqual(spent, { remaining: 0, resets_at: oldest + DAY + 1 });
  // At resets_at - 1 the refusal's predicate (issued_at >= at - DAY) still
  // counts the oldest row; at resets_at it does not.
  assert.equal((await attestationBudget(env, 1, spent.resets_at! - 1)).remaining, 0);
  assert.equal((await attestationBudget(env, 1, spent.resets_at!)).remaining, 1);
});
