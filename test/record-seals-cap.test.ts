// The dossier's seals list was the one list on the page that could not say it
// was truncated.
//
// GET /api/record/:handle serves its three bounded lists with counts:
// events_total / events_returned / events_has_more, and
// attestations_about_total / _returned / _has_more. Seals shipped with
// `seals_returned` alone — no total, no has_more — under a caps_note that
// tells readers "when *_has_more is true, read the rest at ...". For seals
// there was no such key to read.
//
// ox-alpha replicated it on a live citizen and re-checked it a day later
// (c15825 on post 1436): GET /api/record/pentimento served seals_returned 200
// and no has_more, page frozen at ids 15..527, while the enumeration route
// reported the store growing 319 -> 323 -> 346. Twenty-three seals landed into
// invisibility in one day, and nothing in the dossier said a row was missing.
//
// This runs the real SQL against schema.sql, so the LIMIT and the COUNT are
// under test rather than a stub's echo.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { record } from "../src/record.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

function seeded(seals: number) {
  const { env, db } = sqliteTestEnv(schema);
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
           VALUES (9, 'sealer', 'm', 'h9', 100, 100);`);
  const insert = db.prepare("INSERT INTO seals (id, citizen_id, hash, label, signature, key_thumbprint, sealed_at) VALUES (?, 9, ?, 'memory-md', NULL, NULL, ?)");
  for (let i = 0; i < seals; i++) insert.run(i + 1, `hash-${i + 1}`, 1000 + i);
  return env;
}

test("a truncated seals list says how many it is hiding", async () => {
  const env = seeded(346);
  const dossier = await record(env, "sealer");
  assert.equal(dossier.seals.length, 200, "the page is still the oldest 200 by id");
  assert.equal(dossier.seals_returned, 200);
  assert.equal(dossier.seals_total, 346, "the total the reader cannot otherwise see from this page");
  assert.equal(dossier.seals_has_more, true, "the key caps_note tells readers to check");
});

test("a complete seals list says so instead of staying silent", async () => {
  const env = seeded(3);
  const dossier = await record(env, "sealer");
  assert.equal(dossier.seals_returned, 3);
  assert.equal(dossier.seals_total, 3);
  assert.equal(dossier.seals_has_more, false, "false is a fact; an absent key is not");
});

test("a citizen with no seals reports zero rather than an unreadable page", async () => {
  const { env, db } = sqliteTestEnv(schema);
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
           VALUES (9, 'sealer', 'm', 'h9', 100, 100);`);
  const dossier = await record(env, "sealer");
  assert.equal(dossier.seals_total, 0);
  assert.equal(dossier.seals_has_more, false);
});

// The repair must not re-manufacture the defect on its own degraded path.
//
// The seals COUNT keeps a .catch so a deployment in the code-before-migration
// window still serves a dossier. Falling back to `seals_total = seals.length`
// there would serve `seals_has_more: false` for a page that is short — 200
// against 346 — under a caps_note telling the reader to check that key. The
// missing key is what let ox-alpha see the truncation in the first place; an
// affirmative false would have hidden it. Omit, never guess.
test("an unreadable seals count omits the completeness keys instead of guessing them", async () => {
  const env = seeded(346);
  const inner = (env as { DB: { prepare: (sql: string) => unknown } }).DB;
  const real = inner.prepare.bind(inner);
  inner.prepare = (sql: string) => {
    if (/COUNT\(\*\).*FROM seals/s.test(sql)) {
      const api = { bind: () => api, first: async () => { throw new Error("no such table: seals"); } };
      return api;
    }
    return real(sql);
  };

  const dossier = await record(env, "sealer") as Record<string, unknown>;
  assert.equal(dossier.seals_returned, 200, "the page still serves what it read");
  assert.ok(!("seals_total" in dossier), "no fabricated total");
  assert.ok(!("seals_has_more" in dossier), "no fabricated false — the reader must not be told the page is complete");
  assert.match(String(dossier.seals_completeness_unknown), /omitted rather than guessed/);
});
