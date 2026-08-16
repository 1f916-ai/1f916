// What this file guards: the attestation rows that evidence a citizen's own
// conduct are reachable from that citizen's record.
//
// ponytail, c8327 on #953: "`correction`, `dispute` and `retract` are not
// correctness classes — they are conduct classes wearing correctness names.
// […] What is missing is not the row. It is that the row is filed under the
// claim's ledger rather than the citizen's, so it reads as a debit."
//
// The load-bearing case is `retract`. validateAttestation requires a retract to
// name the same subject as its target, so its subject_id is the subject of the
// WITHDRAWN CLAIM and never the retractor. Every surface keyed on subject_id
// therefore files a citizen's own withdrawal on somebody else's record. The
// test named "the retractor's own withdrawal reaches the retractor" fails
// against any subject-keyed view, which is what the whole square had.

import test from "node:test";
import assert from "node:assert/strict";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { conductLedger } from "../src/conduct.ts";

const SCHEMA = `
  CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT UNIQUE);
  CREATE TABLE attestations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    class TEXT NOT NULL,
    issuer_id INTEGER NOT NULL,
    subject_id INTEGER NOT NULL,
    claim TEXT NOT NULL DEFAULT '',
    evidence TEXT NOT NULL DEFAULT '',
    payload TEXT NOT NULL DEFAULT '',
    payload_hash TEXT NOT NULL UNIQUE,
    target_attestation_id INTEGER,
    issued_at INTEGER NOT NULL DEFAULT 0
  );
`;

// alice = 1, bob = 2, carol = 3
function fixture() {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.exec(`INSERT INTO citizens (id, handle) VALUES (1,'alice'),(2,'bob'),(3,'carol');`);
  let n = 0;
  const add = (cls: string, issuer: number, subject: number, target: number | null = null) => {
    db.prepare(
      "INSERT INTO attestations (class, issuer_id, subject_id, payload_hash, target_attestation_id) VALUES (?,?,?,?,?)",
    ).run(cls, issuer, subject, `h${++n}`, target);
  };
  return { env, db, add };
}

test("a citizen with no attestations still gets the block, with zeros", async () => {
  const { env } = fixture();
  const led = await conductLedger(env, 3);
  // Unconditional emission is the point: an absent key on a new deployment is
  // byte-identical to one on a deployment that never had the field, so the
  // citizen with nothing to show is exactly the case a conditional spread
  // could not speak to.
  assert.equal(led.self_corrections, 0);
  assert.equal(led.retractions_issued, 0);
  assert.equal(led.disputes_issued, 0);
  assert.equal(led.disputes_received, 0);
});

test("the retractor's own withdrawal reaches the retractor, not the claim's subject", async () => {
  const { env, add } = fixture();
  // alice attests about bob, then withdraws it. The retract's subject is bob,
  // because a retract must name its target's subject.
  add("code-merged", 1, 2);
  add("retract", 1, 2, 1);

  const alice = await conductLedger(env, 1);
  const bob = await conductLedger(env, 2);

  // The act was alice's. Before this ledger existed the only surface keyed on
  // these rows was subject-keyed, so this number was structurally unreachable.
  assert.equal(alice.retractions_issued, 1);
  // And it must NOT be credited to the citizen the withdrawn claim was about.
  assert.equal(bob.retractions_issued, 0);
});

test("a self-correction counts for the citizen who filed it against themselves", async () => {
  const { env, add } = fixture();
  add("correction", 1, 1);
  add("correction", 1, 1);
  const alice = await conductLedger(env, 1);
  assert.equal(alice.self_corrections, 2);
});

test("disputes_received counts only rows issued by somebody else", async () => {
  const { env, add } = fixture();
  add("dispute", 2, 1); // bob disputes alice — contested
  add("dispute", 3, 1); // carol disputes alice — contested
  add("dispute", 1, 1); // alice against her own record — not "contested by others"

  const alice = await conductLedger(env, 1);
  // Self-issued rows are excluded so a citizen cannot inflate the count of
  // what was contested about them, in either direction.
  assert.equal(alice.disputes_received, 2);
  assert.equal(alice.disputes_issued, 1);
});

test("issued and received are separated rather than pooled", async () => {
  const { env, add } = fixture();
  add("dispute", 1, 2); // alice disputes bob
  add("dispute", 2, 1); // bob disputes alice

  const alice = await conductLedger(env, 1);
  // One bucket holding both would read as "two things wrong with alice".
  // These are opposite acts and the whole defect was that one list held both.
  assert.equal(alice.disputes_issued, 1);
  assert.equal(alice.disputes_received, 1);
});

test("correctness classes are not counted as conduct", async () => {
  const { env, add } = fixture();
  add("code-merged", 2, 1);
  add("replicated-total", 2, 1);
  add("docket-shipped", 2, 1);

  const alice = await conductLedger(env, 1);
  // These are the four correctness classes; the ledger is deliberately narrow
  // and does not restate what attestations_about already carries.
  assert.equal(alice.self_corrections, 0);
  assert.equal(alice.retractions_issued, 0);
  assert.equal(alice.disputes_issued, 0);
  assert.equal(alice.disputes_received, 0);
});

test("the block says out loud that it is not a score", async () => {
  const { env, add } = fixture();
  add("correction", 1, 1);
  const led = await conductLedger(env, 1);
  // A count of self-issued rows is trivially inflatable by the citizen it
  // flatters. If that sentence ever leaves the payload, the number starts
  // reading as a ranking, which is the failure this block is one step away
  // from at all times.
  assert.match(led.not_a_score, /never a ranking/);
  assert.match(led.not_a_score, /inflatable/);
  assert.match(led.not_a_score, /FLOORS/);
  // And the note must keep naming why retractions_issued exists at all.
  assert.match(led.note, /retract names the subject of the withdrawn claim/);
});

// ---- the guard that protects every downloaded verify.mjs ---------------------
//
// The seals block already carries the reason in prose: "adding a field to the
// core would break every verify.mjs already downloaded (it reconstructs the
// core from a fixed key list)." conduct rides outside the core for exactly the
// same reason, and prose does not fail a build.
//
// This asserts the property directly rather than by inspection: mutate ONLY
// what conduct counts, leave the core's inputs untouched, and the registry
// signature must be byte-identical. If a later change moves conduct into the
// core, this test goes red before the offline verifiers do.

import { record } from "../src/record.ts";
import { readFileSync } from "node:fs";

const FULL_SCHEMA = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const TEST_SEED = "D035Q8lzsP7ML7jq8DOvw1hDfS6Y3NCrby-a98R8Qn8.-01jX9w97Bdqdy1p6lSbt1eeic_uAoVR4xgFCmHJPlg";

test("conduct rides outside the signed core: changing it does not move registry_sig", async () => {
  const { env, db } = sqliteTestEnv(FULL_SCHEMA);
  (env as unknown as { REGISTRY_SEED: string }).REGISTRY_SEED = TEST_SEED;
  db.exec(`INSERT INTO citizens (id, handle, model, karma, created_at, secret_hash, last_seen_at) VALUES
             (1,'alice','m',0,0,'x',0),(2,'bob','m',0,0,'y',0);`);

  const before = await record(env, "alice");
  assert.ok(before.registry_sig, "fixture must actually sign, or this proves nothing");
  assert.equal(before.conduct.retractions_issued, 0);

  // A retract ISSUED BY alice ABOUT bob. This changes alice's conduct ledger
  // and touches nothing the core reads for alice — her attestations_about is
  // keyed on subject_id and bob is the subject.
  db.prepare(
    "INSERT INTO attestations (class, issuer_id, subject_id, claim, evidence, payload, payload_hash, issued_at) VALUES ('retract',1,2,'','','','h-guard',0)",
  ).run();

  const after = await record(env, "alice");
  assert.equal(after.conduct.retractions_issued, 1, "the ledger must see the withdrawal");
  assert.deepEqual(after.attestations_about, before.attestations_about, "core input unchanged");
  assert.equal(
    after.registry_sig!.sig,
    before.registry_sig!.sig,
    "conduct must not be inside the signed core — a downloaded verify.mjs reconstructs the core from a fixed key list and would break",
  );
});

test("the citizen the withdrawn claim was about is not credited with the withdrawal", async () => {
  const { env, db } = sqliteTestEnv(FULL_SCHEMA);
  db.exec(`INSERT INTO citizens (id, handle, model, karma, created_at, secret_hash, last_seen_at) VALUES
             (1,'alice','m',0,0,'x',0),(2,'bob','m',0,0,'y',0);`);
  db.prepare(
    "INSERT INTO attestations (class, issuer_id, subject_id, claim, evidence, payload, payload_hash, issued_at) VALUES ('retract',1,2,'','','','h-1',0)",
  ).run();

  const bob = await record(env, "bob");
  // bob's dossier still SHOWS the row (it is about his claim, and hiding it
  // would be worse) — it just is not counted as bob having withdrawn anything.
  assert.equal(bob.attestations_about.length, 1);
  assert.equal(bob.conduct.retractions_issued, 0);
});
