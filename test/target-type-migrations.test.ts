import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";

// The guard for a defect class this repository has now shipped twice.
//
// screen_notices and payload_notices pin target_type with a CHECK. Widening
// the TypeScript union without adding a migration produces a change that is
// green in every test and fails at the database on every use in production,
// because schema.sql builds fresh databases and never runs against the live
// one. migrations/0029 wrote that warning in prose on 2026-08-14; #142 hit it
// again on 2026-08-26 with 980 tests passing. Prose did not hold, so this is
// the mechanical version: what the code declares it can write must be a value
// the live schema will actually accept.
//
// KILLING MUTATION: delete migrations/0037_screen_notices_listing.sql, or drop
// 'listing' from its CHECK, and this test goes red while the rest stay green.

const ROOT = new URL("../", import.meta.url);
const CHECKED = [
  { table: "screen_notices", fn: "recordScreenNotices" },
  { table: "payload_notices", fn: "recordPayloadNotices" },
];

// The CHECK set for a table as a live database actually holds it: every
// migration replayed in filename order, following the create-copy-rename
// dance that SQLite forces on a CHECK change.
function checkSetsAfterMigrations(): Map<string, Set<string>> {
  const dir = new URL("migrations/", ROOT);
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const sets = new Map<string, Set<string>>();
  for (const f of files) {
    const sql = readFileSync(new URL(f, dir), "utf8");
    const creates = sql.matchAll(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?\s*\(([\s\S]*?)\n\);/gi,
    );
    for (const c of creates) {
      const [, name, body] = c;
      const check = body.match(/target_type[^,]*?CHECK\s*\(\s*target_type\s+IN\s*\(([^)]*)\)/i);
      if (check) {
        sets.set(name, new Set([...check[1].matchAll(/'([^']*)'/g)].map((m) => m[1])));
      }
    }
    for (const r of sql.matchAll(/ALTER\s+TABLE\s+["`]?(\w+)["`]?\s+RENAME\s+TO\s+["`]?(\w+)["`]?/gi)) {
      const [, from, to] = r;
      if (sets.has(from)) {
        sets.set(to, sets.get(from)!);
        sets.delete(from);
      }
    }
  }
  return sets;
}

function schemaCheckSet(table: string): Set<string> {
  const schema = readFileSync(new URL("schema.sql", ROOT), "utf8");
  const create = schema.match(
    new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${table}\\s*\\(([\\s\\S]*?)\\n\\);`, "i"),
  );
  assert.ok(create, `schema.sql declares ${table}`);
  const check = create[1].match(/target_type[^,]*?CHECK\s*\(\s*target_type\s+IN\s*\(([^)]*)\)/i);
  assert.ok(check, `schema.sql pins ${table}.target_type with a CHECK`);
  return new Set([...check[1].matchAll(/'([^']*)'/g)].map((m) => m[1]));
}

// What the code says it is allowed to write: the union on the recorder's own
// targetType parameter.
function declaredUnion(fn: string): Set<string> {
  const society = readFileSync(new URL("src/society.ts", ROOT), "utf8");
  const sig = society.split(new RegExp(`export async function ${fn}\\s*\\(`))[1];
  assert.ok(sig, `${fn} is exported from src/society.ts`);
  const param = sig.split(")")[0].match(/targetType:\s*([^,\n]+)/);
  assert.ok(param, `${fn} declares a targetType parameter`);
  return new Set([...param[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]));
}

const migrated = checkSetsAfterMigrations();

for (const { table, fn } of CHECKED) {
  test(`${fn} cannot write a target_type the live ${table} would reject`, () => {
    const live = migrated.get(table);
    assert.ok(live, `migrations/ define a target_type CHECK for ${table}`);
    for (const v of declaredUnion(fn)) {
      assert.ok(
        live.has(v),
        `${fn} accepts "${v}" but the live ${table} CHECK is (${[...live].join(", ")}) — ` +
          `widen it in a new migrations/ file, not only in schema.sql`,
      );
    }
  });

  test(`schema.sql and migrations/ agree on ${table}.target_type`, () => {
    // A fresh database and a live one must not disagree about what is legal,
    // or a defect reproduces on exactly one of them.
    assert.deepEqual([...schemaCheckSet(table)].sort(), [...migrated.get(table)!].sort());
  });
}
