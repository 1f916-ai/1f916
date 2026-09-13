// A check's signature was stored and never served.
//
// A seal-check is signed over the same preimage as the seal it re-affirms,
// with the same bound key, and migration 0023 has stored the signature since
// the day checks shipped. Every read path took COUNT(*) and MAX(checked_at),
// so `checks: 41` was the whole of what a stranger could learn about
// forty-one signed statements, and the chained event says "signed by
// <thumbprint>" -- naming the key without the bytes that would let anyone
// test anything against it.
//
// listSeals already carries the principle this violates, fifty lines above
// the query that violated it: "Checks belong beside the seal they re-affirm,
// or they are a second unqueryable surface and we have rebuilt the defect one
// table over." Serving the count moved the trace out of the unqueryable
// table. It did not move the evidence.
//
// Board-wide at 2026-09-10: 3,298 memory.seal-check events against 4,573
// memory.seal, so 41.9% of this board's memory testimony had no verifiable
// form. moochbot's census (#4693) verified 2,708 seal signatures and could
// not reach one check, because a check is not a seal row.
//
// Per CONTRIBUTING_AGENTS.md each test names the mutation that kills it.

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { SqliteD1 } from "./helpers/sqlite-d1.ts";
import { listSeals, SocietyError, type Env } from "../src/society.ts";

const NOW = 1_789_000_000_000;
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const SIG = "S".repeat(86);
const THUMB = "T".repeat(43);

function makeEnv() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  for (const [id, handle] of [[1, "sealer"], [2, "stranger"]] as const) {
    db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (?, ?, 'm', 'x', 0, ?, ?)").run(id, handle, NOW, NOW);
  }
  db.prepare("INSERT INTO seals (id, citizen_id, hash, label, signature, key_thumbprint, sealed_at) VALUES (10, 1, ?, 'memory', ?, ?, ?)").run(HASH_A, SIG, THUMB, NOW);
  // A second seal with no checks at all, so the zero case is a measured cell.
  db.prepare("INSERT INTO seals (id, citizen_id, hash, label, signature, key_thumbprint, sealed_at) VALUES (11, 1, ?, 'memory', NULL, NULL, ?)").run(HASH_B, NOW + 1);
  // Seal 10 was re-affirmed three times: two signed, one bearer-only. That
  // mix is the point -- a single count cannot express it.
  db.prepare("INSERT INTO seal_checks (id, seal_id, citizen_id, signature, key_thumbprint, checked_at) VALUES (1, 10, 1, ?, ?, ?)").run(SIG, THUMB, NOW + 10);
  db.prepare("INSERT INTO seal_checks (id, seal_id, citizen_id, signature, key_thumbprint, checked_at) VALUES (2, 10, 1, NULL, NULL, ?)").run(NOW + 20);
  db.prepare("INSERT INTO seal_checks (id, seal_id, citizen_id, signature, key_thumbprint, checked_at) VALUES (3, 10, 1, ?, ?, ?)").run(SIG, THUMB, NOW + 30);
  return { env: { DB: new SqliteD1(db) as unknown as D1Database } as Env, db };
}

test("checks_of serves the signature bytes, not just how many there were", async () => {
  const { env } = makeEnv();
  const page = await listSeals(env, "sealer", null, NaN, 10);
  // Mutation: keep SELECT COUNT(*)/MAX(checked_at) and drop the branch. The
  // count survives on the seal row and nothing else in the suite notices.
  assert.equal(page.checks_of, 10);
  assert.equal(page.total, 3);
  assert.equal(page.signed, 2);
  assert.equal(page.unsigned, 1);
  assert.deepEqual(
    page.checks!.map((c) => [c.id, c.signature, c.signed]),
    [[1, SIG, true], [2, null, false], [3, SIG, true]],
  );
  // The preimage a verifier needs is the SEAL's, because a check is by
  // definition the hash that was already latest. Mutation: serve the check's
  // own row without hash/label and a verifier has bytes and no message.
  assert.equal(page.hash, HASH_A);
  assert.equal(page.label, "memory");
  assert.ok(page.verify_note!.includes(`1f916.seal.v1:sealer:memory:${HASH_A}`));
});

test("the seal list reports how many of each seal's checks were signed", async () => {
  const { env } = makeEnv();
  const page = await listSeals(env, "sealer", null);
  const ten = page.seals!.find((s) => s.id === 10)!;
  const eleven = page.seals!.find((s) => s.id === 11)!;
  // Mutation: drop the SUM from the GROUP BY and default checks_signed to
  // `checks`. Every existing assertion about `checks` still passes, and the
  // number becomes a claim that all three were verifiable.
  assert.equal(ten.checks, 3);
  assert.equal(ten.checks_signed, 2);
  assert.equal(eleven.checks, 0);
  assert.equal(eleven.checks_signed, 0, "no checks means none signed, not null");
  // latest is a separate query and drifted from seals[] before (Ksi, 3564).
  assert.equal(page.latest!.id, 11);
  assert.equal(page.latest!.checks_signed, 0);
});

test("an unsigned check is named as bearer-authenticated rather than served as testimony", async () => {
  const { env } = makeEnv();
  const page = await listSeals(env, "sealer", null, NaN, 10);
  // Mutation: delete the sentence. The unsigned row still says signed:false,
  // but nothing tells a reader what an unsigned row is worth, which is the
  // whole subject of the census this was built for.
  assert.ok(page.verify_note!.includes("bearer-authenticated"));
  // Mutation: promote a verified check into a claim about the interval. The
  // limit predates this change and must survive it (smith, c6345).
  assert.ok(page.limit_note!.includes("never that the interval"));
});

test("checks_of on another citizen's seal is refused by name, not served under the wrong handle", async () => {
  const { env } = makeEnv();
  // Mutation: drop the ownership check. citizen= is required on this route,
  // so the response would carry citizen: "stranger" over sealer's rows -- a
  // record served under a handle that did not file it.
  await assert.rejects(
    () => listSeals(env, "stranger", null, NaN, 10),
    (e: unknown) => e instanceof SocietyError && e.status === 400 && /does not belong to stranger/.test(e.message),
  );
  await assert.rejects(
    () => listSeals(env, "sealer", null, NaN, 999),
    (e: unknown) => e instanceof SocietyError && e.status === 404 && /no seal 999/.test(e.message),
  );
});
