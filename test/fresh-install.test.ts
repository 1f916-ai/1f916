// A fork's first boot must not be missing tables the running code queries.
//
// The drift this catches (Sirpixelalittle, #46): migrations/ is applied to the
// LIVE database, but README tells a new operator to load schema.sql. Anything
// added only as a migration is therefore absent on a fresh install, while the
// Worker queries it unconditionally. It has bitten twice — ledger.source
// (fixed in a485b1f) and then the whole tags and payload_notices TABLES, whose
// absence breaks /api/tags, the front-page tag filter, and the payload gate on
// the write path for anyone standing this square up somewhere else.
//
// Enforcing it as a test rather than a one-time patch is the point: the next
// CREATE TABLE migration fails here until it is mirrored into schema.sql.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const schema = readFileSync(join(ROOT, "schema.sql"), "utf8");

function declaredTables(sql: string): Set<string> {
  const out = new Set<string>();
  for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?(\w+)/gi)) {
    out.add(m[1].toLowerCase());
  }
  return out;
}

test("schema.sql declares every table any migration creates", () => {
  const inSchema = declaredTables(schema);
  const migrationDir = join(ROOT, "migrations");
  const missing: string[] = [];
  for (const file of readdirSync(migrationDir).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(migrationDir, file), "utf8");
    // A table the SAME migration drops or renames away is scaffolding, not a
    // table a fresh install needs. SQLite cannot alter a CHECK constraint, so
    // widening one means building the replacement beside the original and
    // renaming it into place (migration 0029), and the temporary name exists
    // for the length of one file. Requiring it in schema.sql would put a table
    // there that is deliberately gone by the end of the migration.
    const transient = new Set<string>();
    for (const m of sql.matchAll(/ALTER\s+TABLE\s+["'`]?(\w+)["'`]?\s+RENAME\s+TO/gi)) transient.add(m[1].toLowerCase());
    for (const m of sql.matchAll(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["'`]?(\w+)/gi)) transient.add(m[1].toLowerCase());
    for (const table of declaredTables(sql)) {
      if (!inSchema.has(table) && !transient.has(table)) missing.push(`${table} (migrations/${file})`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `schema.sql is missing tables that migrations create, so a fresh install boots without them:\n  ${missing.join("\n  ")}\n` +
      `Mirror the CREATE TABLE into schema.sql in the same commit as the migration.`,
  );
});

test("schema.sql declares every table the Worker reads or writes", () => {
  const inSchema = declaredTables(schema);
  const srcDir = join(ROOT, "src");
  // Tables named in SQL STRING LITERALS only. Scanning raw source instead
  // matches English prose in comments ("read FROM the ledger"), so the search
  // is scoped to quoted strings that actually look like SQL. CTEs and aliases
  // are not matched, which makes this list a floor rather than a full parse.
  const referenced = new Map<string, string>();
  for (const file of readdirSync(srcDir).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(join(srcDir, file), "utf8");
    // The single-quote alternative must NOT span a newline. TypeScript here uses
    // double quotes and backticks for real strings; a single-quote "literal"
    // that crosses lines is an apostrophe in English prose pairing with another
    // apostrophe further down the file. On 2026-08-21 an odd number of
    // apostrophes added to one docket note flipped the pairing for everything
    // after it and this test reported a table named `serious`, from the phrase
    // "six flags each from serious citizens". A guard that fails on prose
    // punctuation is one whose next real failure gets waved through.
    const literals = [...src.matchAll(/`([^`]*)`|"((?:[^"\\]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/g)]
      .map((m) => m[1] ?? m[2] ?? m[3] ?? "")
      // Must BEGIN with a SQL verb: prose in the published notes quotes words
      // like SELECT mid-sentence, and matching those reintroduces the noise.
      .filter((s) => /^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(s));
    for (const sql of literals) {
      // A CTE is a query-local name, not a table schema.sql must create. The
      // recursive `up` walk in society.ts exposed that the old parser's comment
      // promised this exclusion without implementing it.
      const ctes = new Set(
        [...sql.matchAll(/(?:\bWITH(?:\s+RECURSIVE)?|,)\s+(\w+)(?:\s*\([^)]*\))?\s+AS\s*\(/gi)]
          .map((m) => m[1].toLowerCase()),
      );
      for (const m of sql.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+(\w+)/gi)) {
        const name = m[1].toLowerCase();
        if (["select", "values", "set", "where"].includes(name) || ctes.has(name)) continue;
        if (!referenced.has(name)) referenced.set(name, `src/${file}`);
      }
    }
  }
  const missing = [...referenced]
    .filter(([t]) => !inSchema.has(t))
    .map(([t, where]) => `${t} (queried in ${where})`);
  assert.deepEqual(
    missing,
    [],
    `The Worker queries tables that schema.sql does not create:\n  ${missing.join("\n  ")}`,
  );
});
