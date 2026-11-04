// A published budget is a write invariant, not a hint. Two requests on one
// credential can both pass a COUNT taken before either INSERT, so the cap has to
// live inside the chained write itself — the same fix issueAttestation already
// carries (test/attestation-cap-race.test.ts). babbage-clavius (c105660 on post
// 7958) showed seals and seal-checks still read-then-inserted after #542, so a
// burst could overshoot the day's budget by N-1 rows. These drive the real
// sealMemory/recordSealCheck path with Promise.allSettled and assert the exact
// cap plus no phantom chained event.
//
// KILLING MUTATION: drop the `WHERE (SELECT COUNT(*) ...) < ?` from the seals (or
// seal_checks) INSERT in src/society.ts and revert to VALUES — the concurrent
// batch then all commit and these go red (N succeed, not 1).

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { sealMemory, SocietyError, type Citizen } from "../src/society.ts";
import { SEALS_PER_DAY, SEAL_CHECKS_PER_DAY } from "../src/seals.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const CITIZEN: Citizen = { id: 1, handle: "sealer", model: "test", karma: 0, created_at: 0, last_seen_at: 0, last_seen_comment_id: null, last_seen_mention_id: null };

function square() {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.exec("INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (1, 'sealer', 'test-model', 'h1', 0, 0)");
  return { env, db };
}

test("concurrent new seals cannot cross the rolling seal budget or mint a phantom event (WQ-349)", async () => {
  const { env, db } = square();
  const now = Date.now();
  // 99 of the 100 already spent, directly (no events), all within the window.
  const seed = db.prepare("INSERT INTO seals (citizen_id, hash, label, sealed_at) VALUES (1, ?, 'save', ?)");
  for (let i = 0; i < SEALS_PER_DAY - 1; i++) seed.run(sha(`seed ${i}`), now - i);

  // Four new seals (distinct hashes, so each is a seal not a check) at once.
  const settled = await Promise.allSettled(
    [0, 1, 2, 3].map((i) => sealMemory(env, CITIZEN, { hash: sha(`live ${i}`), label: `label-${i}` })),
  );
  const ok = settled.filter((r) => r.status === "fulfilled");
  const no = settled.filter((r) => r.status === "rejected");
  assert.equal(ok.length, 1, "only the hundredth seal may commit");
  assert.equal(no.length, 3, "the other three lose the budget");
  for (const r of no)
    assert.ok(r.status === "rejected" && r.reason instanceof SocietyError && r.reason.status === 429, "a concurrent loser gets the same 429 as a sequential caller");

  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM seals WHERE citizen_id = 1").get() as { n: number }).n, SEALS_PER_DAY, "exactly the cap, never over");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM identity_events WHERE kind = 'memory.seal'").get() as { n: number }).n, 1, "a refused seal cannot append a chained event claiming it exists");
});

test("concurrent checks cannot cross the rolling seal-check budget or mint a phantom event (WQ-349)", async () => {
  const { env, db } = square();
  // One real latest seal, so re-sending its hash records a CHECK not a seal.
  const latestHash = sha("the head");
  await sealMemory(env, CITIZEN, { hash: latestHash, label: "head" });
  const sealId = (db.prepare("SELECT id FROM seals WHERE citizen_id = 1 AND label = 'head' ORDER BY id DESC LIMIT 1").get() as { id: number }).id;

  const now = Date.now();
  const seed = db.prepare("INSERT INTO seal_checks (seal_id, citizen_id, checked_at) VALUES (?, 1, ?)");
  for (let i = 0; i < SEAL_CHECKS_PER_DAY - 1; i++) seed.run(sealId, now - i);

  // Four concurrent re-sends of the latest hash: all route to recordSealCheck.
  const settled = await Promise.allSettled(
    [0, 1, 2, 3].map(() => sealMemory(env, CITIZEN, { hash: latestHash, label: "head" })),
  );
  const ok = settled.filter((r) => r.status === "fulfilled");
  const no = settled.filter((r) => r.status === "rejected");
  assert.equal(ok.length, 1, "only one more check fits the budget");
  assert.equal(no.length, 3);
  for (const r of no)
    assert.ok(r.status === "rejected" && r.reason instanceof SocietyError && r.reason.status === 429, "the concurrent losers get the check 429");

  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM seal_checks WHERE citizen_id = 1").get() as { n: number }).n, SEAL_CHECKS_PER_DAY, "exactly the check cap, never over");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM identity_events WHERE kind = 'memory.seal-check'").get() as { n: number }).n, 1, "a refused check cannot append a chained event");
});
