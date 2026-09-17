// GET /api/official publishes a served witness for the numbered migrations
// that add triggers (doorbell 0028, nulls 0051, intended-parent 0055),
// so "is this migration actually applied to the running D1?" is a GET anyone
// can run. GitHub #224.
//
// WHY THIS FILE EXISTS. This repo has no automated migration runner — the
// deploy is `wrangler deploy` and nothing applies migrations/ against the live
// D1; schema.sql builds a fresh database and is not re-run against the
// existing one. So a trigger that is MERGED (in schema.sql and in a numbered
// migration) can still be ABSENT in production, and there was no read-only way
// to tell. silt filed that as unverifiable from outside and asked for exactly
// this witness. The expected-set is an embedded constant (no build step to
// compute it at bundle time), so the thing that makes a hardcoded list
// acceptable is that it is re-derived here from migrations/ and the two are
// asserted to agree.
//
// Run: npm test
//
// KILLING MUTATIONS this file catches:
//   - a trigger dropped from SCHEMA_TRIGGER_WITNESS_EXPECTED while migrations/
//     still declares it (the drift the guard exists for);
//   - a trigger added to migrations/ (or mirrored in schema.sql) that the
//     constant forgets;
//   - the witness computing `triggers_missing` in the wrong direction
//     (flagging live-but-undeclared triggers, or hiding genuinely missing ones).

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA_TRIGGER_WITNESS_EXPECTED, servedTriggerWitness } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const here = dirname(fileURLToPath(import.meta.url));

// Re-derive the declared trigger set from migrations/ — the source of truth
// for "which numbered migrations add triggers" — and assert the embedded
// constant matches it exactly. A new migration that adds a trigger (or a
// removal) with the constant left stale makes this test red: the reason a
// hardcoded list was permitted at all was that this guard stands behind it.
function declaredTriggersFromMigrations(): string[] {
  const dir = join(here, "..", "migrations");
  const names = new Set<string>();
  for (const file of readdirSync(dir).sort().filter((f) => f.endsWith(".sql"))) {
    for (const m of readFileSync(join(dir, file), "utf8").matchAll(/CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi)) {
      names.add(m[1]);
    }
  }
  return [...names].sort();
}

function triggerNames(db: DatabaseSync): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all() as { name: string }[])
    .map((r) => r.name)
    .sort();
}

test("the embedded expected set is the set migrations/ actually declares (no drift)", () => {
  // A hardcoded list is only as good as this: if a migration adds a trigger the
  // constant forgets, or drops one it still lists, the constant and the source
  // of truth disagree and the served witness would be wrong.
  assert.deepEqual(SCHEMA_TRIGGER_WITNESS_EXPECTED.slice().sort(), declaredTriggersFromMigrations());
});

test("the expected set is schema-mirror-consistent (schema.sql declares the same triggers)", () => {
  // schema.sql builds the fresh database; if it stopped naming a trigger still
  // in migrations/ (or vice versa), the two sources of the schema disagree.
  const declared = new Set(declaredTriggersFromMigrations());
  const schemaTriggers = new Set(
    [...readFileSync(join(here, "..", "schema.sql"), "utf8").matchAll(/CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi)].map(
      (m) => m[1],
    ),
  );
  for (const t of declared) assert.ok(schemaTriggers.has(t), `migrations declare trigger ${t} but schema.sql does not`);
  for (const t of schemaTriggers) assert.ok(declared.has(t), `schema.sql declares trigger ${t} but migrations do not`);
});

test("a database built from schema.sql reports no missing triggers", async () => {
  // The happy path: every trigger the migration set declares is present, so
  // triggers_missing is empty and a reader can tell 0055 is installed.
  const schema = readFileSync(join(here, "..", "schema.sql"), "utf8");
  const { env, db } = sqliteTestEnv(schema);
  const witness = await servedTriggerWitness(env);

  assert.deepEqual([...witness.triggers_expected].sort(), SCHEMA_TRIGGER_WITNESS_EXPECTED.slice().sort());
  // The 0055 pair specifically — the migration whose prod state was the open
  // question in #224 — must be present in a fresh-from-schema database.
  for (const t of ["comments_intended_parent_needs_parent_insert", "comments_intended_parent_needs_parent_update"]) {
    assert.ok(db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='trigger' AND name=?").get(t), `fresh schema is missing ${t}`);
    assert.ok(witness.triggers.includes(t), `witness.triggers omits ${t}`);
  }
  assert.deepEqual(witness.triggers_missing, [], "a schema-consistent database must report no missing triggers");
});

test("a database that never got migration 0055 reports exactly that pair as missing", async () => {
  // The production case #224 was about: the migration is merged in code but not
  // applied to this D1. Delete the 0055 pair out of an otherwise-consistent
  // database and the witness must name exactly those two — and no more.
  const schema = readFileSync(join(here, "..", "schema.sql"), "utf8");
  const { env, db } = sqliteTestEnv(schema);
  db.exec("DROP TRIGGER comments_intended_parent_needs_parent_insert");
  db.exec("DROP TRIGGER comments_intended_parent_needs_parent_update");

  const witness = await servedTriggerWitness(env);
  assert.deepEqual(
    witness.triggers_missing,
    ["comments_intended_parent_needs_parent_insert", "comments_intended_parent_needs_parent_update"],
    "the missing set must be exactly the unapplied 0055 pair",
  );
  // The rest of the expected set is still present, so those must NOT leak in.
  assert.equal(witness.triggers.includes("doorbell_require_endpoint_proof"), true);
  assert.equal(witness.triggers.includes("nulls_count_insert"), true);
});

test("a live trigger the code does not declare is not reported as missing (one-directional)", async () => {
  // The witness answers "is what I built installed?" — it must not flag a
  // legitimate extra trigger that happens to live in the same database
  // (another app's trigger, a test fixture) as a finding. Over-constraining it
  // would turn a healthy database into a red witness.
  const schema = readFileSync(join(here, "..", "schema.sql"), "utf8");
  const { env, db } = sqliteTestEnv(schema);
  db.exec("CREATE TRIGGER something_else BEFORE INSERT ON posts BEGIN SELECT 1; END;");

  const witness = await servedTriggerWitness(env);
  assert.ok(witness.triggers.includes("something_else"), "the live set is reported as-is");
  assert.deepEqual(witness.triggers_missing, [], "an undeclared live trigger is not a 'missing' finding");
});

test("servedTriggerWitness does not mutate the caller-visible expected constant", async () => {
  // The function sorts a copy for comparison. Guard against a regression to
  // sorting the exported array in place — consumers that expect the declaration
  // order would silently see a mutated module-level constant.
  const before = [...SCHEMA_TRIGGER_WITNESS_EXPECTED];
  const schema = readFileSync(join(here, "..", "schema.sql"), "utf8");
  const { env } = sqliteTestEnv(schema);
  await servedTriggerWitness(env);
  assert.deepEqual(SCHEMA_TRIGGER_WITNESS_EXPECTED, before, "the exported constant must not be reordered in place");
});
