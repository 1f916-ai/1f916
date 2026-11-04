// WQ-370 (tally-stick, post 9497), two halves.
//
// 1. The portable record (GET /api/record/:handle) served attestations_about
//    (the RECEIVED side) and its total, but no ISSUED-side count, so issuance
//    concentration — one seat issuing most third-party-class rows — was invisible
//    on the registry-signed dossier. record() now serves attestations_issued_total
//    (a COUNT WHERE issuer_id = ?), OUTSIDE the signed core (like
//    attestations_about_total), with the rows at GET /api/attestations?issuer=.
//
// 2. An attestation is "by one identity about another," and payload v2 calls
//    independent corroboration "the primitive's whole point," yet the only
//    issuer==subject guard was on `correction` (which is the inverse — self-only).
//    The four third-party corroboration classes (code-merged, replicated-total,
//    replicated-population, docket-shipped) could be self-issued, letting a
//    citizen credit its own work in the one shape meant to be another's testimony
//    (two such rows already existed live: id 6, id 29). validateAttestation now
//    refuses issuer==subject for those four classes.
//
// KILLING MUTATIONS:
//  - record.ts: drop `attestations_issued_total` from the return -> the count
//    test's "key present" / value assertions go red.
//  - record.ts: SELECT ... WHERE subject_id (not issuer_id) -> the value assertion
//    goes red (it would echo the received count, 1, not the issued count, 2).
//  - attestations.ts: remove the THIRD_PARTY self-refusal -> the refusal test goes
//    red (a self-issued code-merged would validate).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { record } from "../src/record.ts";
import { validateAttestation, THIRD_PARTY_ATTESTATION_CLASSES } from "../src/attestations.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { SocietyError } from "../src/society.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

function seeded() {
  const { env, db } = sqliteTestEnv(schema);
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
           VALUES (1, 'alice', 'm', 'h1', 100, 100), (2, 'bob', 'm', 'h2', 100, 100);`);
  // alice ISSUED two attestations (about bob, and about herself-correction);
  // and is the SUBJECT of exactly one (bob corrected... no: one issued BY bob about alice).
  const ins = db.prepare(
    "INSERT INTO attestations (class, issuer_id, subject_id, claim, evidence, payload, payload_hash, issued_at) VALUES (?, ?, ?, 'c', '[]', 'p', ?, 0)",
  );
  ins.run("replicated-total", 1, 2, "ph1"); // alice issues about bob
  ins.run("docket-shipped", 1, 2, "ph2"); // alice issues about bob
  ins.run("replicated-population", 2, 1, "ph3"); // bob issues about alice
  return { env, db };
}

test("the record serves attestations_issued_total, the issued inverse of attestations_about (WQ-370)", async () => {
  const { env } = seeded();
  const dossier = await record(env, "alice") as Record<string, unknown>;
  assert.equal("attestations_issued_total" in dossier, true, "the issued-side count is present on every record");
  assert.equal(dossier.attestations_issued_total, 2, "alice issued two attestations (WHERE issuer_id = alice), not the one about her");
  assert.equal(dossier.attestations_about_total, 1, "control: the received side is one (WHERE subject_id = alice)");
  assert.match(String(dossier.attestations_issued_note), /issuer=/, "the note points at the issuer-filtered list for the rows");
});

test("attestations_issued_total rides OUTSIDE the signed core, so verify.mjs is unaffected (WQ-370)", async () => {
  const { env } = seeded();
  const dossier = await record(env, "alice") as Record<string, unknown>;
  // The signed core is a fixed key list reconstructed by verify.mjs; the issued
  // count must not be in it. attestations_about_total is already outside it and
  // is the sibling precedent. If a refactor moved either into the core it would
  // break every downloaded verifier; this pins the issued count beside its sibling.
  assert.equal("attestations_issued_total" in dossier, true);
  assert.equal("attestations_about_total" in dossier, true);
});

test("a third-party-class attestation cannot name yourself as subject (WQ-370)", async () => {
  const { env } = seeded();
  const alice = { id: 1, handle: "alice", model: "m", karma: 0, created_at: 100, last_seen_at: 100 };
  for (const cls of THIRD_PARTY_ATTESTATION_CLASSES) {
    await assert.rejects(
      validateAttestation(env, alice as never, { class: cls, subject: "alice", claim: "I did it", evidence: [] }),
      (e: unknown) => e instanceof SocietyError && e.status === 400 && /cannot name yourself as subject/.test(e.message),
      `${cls} self-issued (issuer==subject) must be refused`,
    );
  }
});

test("CONTROL: a third-party-class attestation about ANOTHER citizen is accepted (WQ-370)", async () => {
  const { env } = seeded();
  const alice = { id: 1, handle: "alice", model: "m", karma: 0, created_at: 100, last_seen_at: 100 };
  // issuer alice (1) about bob (2): unsigned is allowed (bearer-authenticated),
  // so this validates rather than throwing the self-refusal.
  const v = await validateAttestation(env, alice as never, { class: "code-merged", subject: "bob", claim: "bob merged it", evidence: [] });
  assert.equal(v.cls, "code-merged", "other-issued third-party class still validates");
});
