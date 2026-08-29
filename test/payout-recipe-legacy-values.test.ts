// The served note and the migration's CHECK must be ONE source of truth.
//
// migration 0041 keeps 'self' in payout_bindings.citizen_key_custody's CHECK
// because that column is field thirteen of PAYOUT_BINDING_HASH_FIELDS and its
// historical bytes are inside published digests. GET /api/payout-bindings/:id
// now says so in `payload_hash_recipe.legacy_values`, for the reader who is
// following the recipe and has no reason to open a migration file.
//
// Two sentences about one constraint is how prose beside a digest goes stale —
// the exact defect #2852 was about, one level up. So these tests parse the SQL
// and assert the sets are equal, in both directions.
import { strict as assert } from "node:assert";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  CUSTODY_PAYOUT_LEGACY_VALUES,
  CUSTODY_PAYOUT_LEGACY_NOTE,
  CUSTODY_VALUES,
} from "../src/keys.ts";
import { PAYOUT_BINDING_HASH_FIELDS } from "../src/payouts.ts";

function checkValuesFor(sql: string, table: string, column: string): string[] {
  // Find the column definition inside the named CREATE TABLE, then the IN list
  // of its CHECK. Deliberately does not accept a match from anywhere else in
  // the file: a CHECK on a differently-named table is not this constraint.
  const at = sql.search(new RegExp(`CREATE TABLE (IF NOT EXISTS )?${table} \\(`));
  assert.ok(at >= 0, `no CREATE TABLE ${table} found`);
  const create = sql.slice(at);
  const col = create.slice(create.indexOf(`  ${column} `));
  const m = /CHECK\s*\(\s*\w+\s+IN\s*\(([^)]*)\)\s*\)/.exec(col);
  assert.ok(m, `no CHECK ... IN (...) on ${table}.${column}`);
  return m![1].split(",").map((s) => s.trim().replace(/^'|'$/g, ""));
}

test("0041's payout_bindings CHECK is exactly the declarable values plus the declared legacy ones", () => {
  const sql = readFileSync(new URL("../migrations/0041_key_custody_declare.sql", import.meta.url), "utf8");
  const actual = checkValuesFor(sql, "payout_bindings_new", "citizen_key_custody");
  const expected = [...CUSTODY_PAYOUT_LEGACY_VALUES, ...CUSTODY_VALUES];
  assert.deepEqual(
    [...actual].sort(),
    [...expected].sort(),
    "the CHECK and the served legacy_values block have drifted apart — fix whichever is wrong, but they may not disagree",
  );
});

test("every legacy value is genuinely undeclarable — otherwise it is not legacy", () => {
  for (const v of CUSTODY_PAYOUT_LEGACY_VALUES) {
    assert.ok(
      !(CUSTODY_VALUES as readonly string[]).includes(v),
      `${v} is a current custody value; a value that can still be written is not a legacy value and must not be documented as one`,
    );
  }
});

test("a fresh install cannot write the legacy value", () => {
  const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
  const actual = checkValuesFor(schema, "payout_bindings", "citizen_key_custody");
  for (const v of CUSTODY_PAYOUT_LEGACY_VALUES) {
    assert.ok(
      !actual.includes(v),
      `schema.sql admits '${v}'. A fresh database has no historical rows to protect, so admitting a value nothing can write is dead vocabulary (#2700).`,
    );
  }
});

test("the legacy note is only warranted while the column is inside a published digest", () => {
  // If citizen_key_custody ever leaves PAYOUT_BINDING_HASH_FIELDS, the reason
  // for keeping the historical bytes verbatim is gone and this whole apparatus
  // — CHECK member, served block, these tests — should be reconsidered rather
  // than inherited. Fail loudly at that moment instead of quietly protecting
  // nothing.
  assert.ok(
    (PAYOUT_BINDING_HASH_FIELDS as readonly string[]).includes("citizen_key_custody"),
    "citizen_key_custody is no longer a hashed field: the legacy CHECK member and its served note now protect nothing and should be revisited on purpose",
  );
  assert.match(CUSTODY_PAYOUT_LEGACY_NOTE, /payload_hash/);
});
