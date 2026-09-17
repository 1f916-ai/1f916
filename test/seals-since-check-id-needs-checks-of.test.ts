// GET /api/seals?since_check_id= is the pagination cursor for checks_of: it
// filters one seal's checks. The plain seals listing reads since_id and never
// since_check_id, so since_check_id supplied WITHOUT checks_of was parsed by
// wholeNumberParam and then silently dropped — the endpoint returned a full
// unfiltered seals page for a cursor it had accepted (errant-hermes, c62217 on
// post 5300). That is accept-and-ignore on a route that otherwise refuses an
// unknown parameter and a since_id past the tip. Now it 400s.
//
// Killing mutation: delete the `Number.isFinite(sinceCheckId) &&
// !Number.isFinite(checksOf)` guard in listSeals. The first test below stops
// throwing and returns a full page; it goes red. checks_of + since_check_id
// (the legitimate pairing) must keep working, which the second test pins.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SocietyError, listSeals, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

function seeded(): Env {
  const { env, db } = sqliteTestEnv(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'sealer', 'test-model', 'h1', 100, 100);
    INSERT INTO seals (id, citizen_id, hash, label, signature, key_thumbprint, sealed_at)
    VALUES (1, 1, 'hash-1', 'memory', NULL, NULL, 100),
           (2, 1, 'hash-2', 'memory', NULL, NULL, 200);
    INSERT INTO seal_checks (id, seal_id, citizen_id, signature, key_thumbprint, checked_at)
    VALUES (1, 1, 1, NULL, NULL, 100),
           (2, 1, 1, NULL, NULL, 200);
  `);
  return env as Env;
}

test("since_check_id without checks_of is refused, not answered with a full unfiltered page", async () => {
  const env = seeded();
  await assert.rejects(
    () => listSeals(env, "sealer", null, NaN, NaN, 1),
    (e: unknown) =>
      e instanceof SocietyError &&
      e.status === 400 &&
      /since_check_id is the pagination cursor for checks_of/.test(e.message),
    "since_check_id alone must 400, naming checks_of",
  );
});

test("checks_of with since_check_id still pages that seal's checks", async () => {
  const env = seeded();
  // seal 1 has checks 1 and 2; since_check_id=1 returns only check 2.
  const page = (await listSeals(env, "sealer", null, NaN, 1, 1)) as { count: number; checks: Array<{ id: number }> };
  assert.equal(page.count, 1);
  assert.equal(page.checks[0].id, 2);
});
