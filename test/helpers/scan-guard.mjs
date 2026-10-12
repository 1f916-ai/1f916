// The scan guard: no read may cost rows in proportion to a whole table.
//
// Runs after `npm test` (package.json posttest). sql-capture.mjs has recorded
// every statement src/ prepared during the suite; this asks SQLite for each
// one's query plan against schema.sql and classifies it.
//
// THE RULE. A request should read about as many rows as it returns. A read
// that walks a whole table, or an unbounded range of one, gets more expensive
// every day the society grows AND multiplies with traffic, so 100x the society
// is ~10,000x the rows. Measured 2026-09-17: ~7B rows/day on 66k comments, with
// the inbox alone reading 66,000 rows per check.
//
// WHAT COUNTS AS UNBOUNDED, from the plan:
//   SCAN <table>                      every row, with or without an index, and
//                                     with or without a LIMIT (see classify)
//   SEARCH <table> ... (col>? ...)    a range, which is every row past a point,
//                                     unless it has a LIMIT and nothing that
//                                     forces reading every match first (an
//                                     aggregate, DISTINCT, GROUP BY, UNION, or a
//                                     temp b-tree sort)
// Equality lookups (col=?) are bounded by the key.
//
// RELATION TO test/query-plan-inventory.test.ts, which came first. That test
// drives ~21 public endpoints on a tiny fixture and ledgers bare SCANs. It lets
// `SCAN ... USING COVERING INDEX` through and does not look at range SEARCHes,
// and those two shapes are where the 2026-09-17 bill was: the inbox counts
// (range over comments, ~66k rows/call) and the active-citizens count (covering
// index walk over posts/comments/votes, ~205k rows/call) both pass it. This
// guard covers every statement the whole suite executes, so it is the wider
// net. The two ledgers overlap; folding the older one into this is follow-up.
//
// THE RATCHET. test/scan-baseline.json lists every unbounded read that existed
// when this guard landed, each as "debt" (to be fixed) or "accepted" (with a
// written reason it is bounded in practice or unavoidable). The guard FAILS on:
//   1. an unbounded read not in the baseline -- a new scan cannot land quietly;
//   2. a baseline entry that ran and is now bounded -- delete it, so the list
//      stays an honest worklist and only ever shrinks.
// An entry that did not run this time is reported, not failed, so a partial
// `npm test -- <file>` does not trip it.
//
// WHAT THIS DOES NOT SEE, stated so nobody reads green as more than it is: a
// statement no test executes. Coverage of src/ SQL is only as good as the
// suite's. The count of distinct statements seen is printed every run.
//
// Usage: node test/helpers/scan-guard.mjs [--write-baseline]
import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isRuntimeLikePattern } from "./d1-compat.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const CAPTURE_DIR = `${root}.sql-capture`;
const BASELINE = `${root}test/scan-baseline.json`;
// Below this the capture almost certainly did not run (preload missing), and a
// guard over an empty set would pass everything.
const MIN_STATEMENTS = 100;

// Tables whose size does not grow with the society, so walking them is not the
// defect this guard exists for. Each needs a reason.
const BOUNDED_TABLES = {
  sqlite_sequence: "one row per AUTOINCREMENT table",
  table_counts: "one row per maintained counter (migration 0051)",
  nulls_buckets: "grows ~24 rows a day by construction; reads are bucket sums (migration 0056)",
  d1_migrations: "one row per migration",
  identity_event_kind_counts: "one row per identity event kind (migration 0062); grows with the kinds the code defines, not with events",
  registry_keys: "one row per registry signing key (migration 0078); grows only when the operator rotates, and the read is capped",
};

const normalize = (sql) =>
  sql
    .replace(/\s+/g, " ")
    .replace(/\b\d+\b/g, "N")
    .replace(/\?(\s*,\s*\?)+/g, "?...")
    .trim();
const keyOf = (sql) => createHash("sha256").update(normalize(sql)).digest("hex").slice(0, 16);

function loadStatements() {
  if (!existsSync(CAPTURE_DIR)) return [];
  const all = new Set();
  for (const f of readdirSync(CAPTURE_DIR)) {
    for (const line of readFileSync(`${CAPTURE_DIR}/${f}`, "utf8").split("\n")) {
      if (line) all.add(JSON.parse(line));
    }
  }
  return [...all];
}

function classify(db, tables, sql) {
  if (!/^\s*(SELECT|WITH)\b/i.test(sql)) return null;
  let plan;
  try {
    plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => r.detail);
  } catch {
    return null; // references something schema.sql lacks; reported separately
  }
  // Alias -> table, from FROM/JOIN clauses. CTE and subquery names resolve to
  // nothing and are skipped: the tables beneath them appear as their own lines.
  const alias = new Map();
  for (const m of sql.matchAll(/\b(?:FROM|JOIN)\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*))?/gi)) {
    const table = m[1].toLowerCase();
    if (!tables.has(table)) continue;
    alias.set(table, table);
    const a = m[2]?.toLowerCase();
    if (a && !/^(where|join|left|inner|on|group|order|limit|union|cross|natural|using|as|and|or|set)$/.test(a)) alias.set(a, table);
  }
  const forcesFullRead =
    /\b(COUNT|SUM|AVG|MIN|MAX|GROUP_CONCAT|TOTAL)\s*\(|\bDISTINCT\b|\bGROUP\s+BY\b|\bUNION\b/i.test(sql) ||
    plan.some((d) => /USE TEMP B-TREE/.test(d));
  const canStopEarly = /\bLIMIT\b/i.test(sql) && !forcesFullRead;
  const hits = [];
  // The maintained-total fallback (src/counts.ts maintainedTotalSql):
  //   COALESCE((SELECT n FROM table_counts WHERE name = 'T'), (SELECT COUNT(*) FROM T))
  // EXPLAIN lists the COUNT's scan, but SQLite's COALESCE stops at the first
  // non-NULL argument, so it runs only on a database missing the counter row.
  // Exempted NARROWLY: one scan of T per occurrence of that exact text, so a
  // second, genuine scan of T in the same statement is still reported.
  const fallbackCredit = new Map();
  // Also credits a filtered fallback under a sub-named counter, e.g.
  //   COALESCE((SELECT n FROM table_counts WHERE name = 'ledger.sealed'),
  //            (SELECT COUNT(*) FROM ledger WHERE id >= ? AND hash IS NOT NULL))
  // (migration 0062): still one read of that same table, still only on a
  // database missing the counter row.
  // The sub-name is restricted to counters a migration actually seeds (0062's
  // "sealed"). A free-form suffix let an unseeded counter name, whose fallback
  // scans on every call, pass as credited (pre-deploy auditor, 2026-09-17).
  for (const m of sql.matchAll(/COALESCE\(\(SELECT n FROM table_counts WHERE name = '([a-z_]+)(?:\.(?:sealed))?'\), \(SELECT COUNT\(\*\) FROM \1(?: WHERE [^()]*)?\)\)/g)) {
    fallbackCredit.set(m[1], (fallbackCredit.get(m[1]) ?? 0) + 1);
  }
  for (const d of plan) {
    const m = /^(SCAN|SEARCH) ([A-Za-z_][A-Za-z0-9_]*)\b(.*)$/.exec(d);
    if (!m) continue;
    const table = alias.get(m[2].toLowerCase()) ?? (tables.has(m[2].toLowerCase()) ? m[2].toLowerCase() : null);
    if (!table || table in BOUNDED_TABLES) continue;
    const constraint = /\(([^)]*)\)\s*$/.exec(m[3])?.[1] ?? "";
    // A SCAN is unbounded EVEN WITH A LIMIT. The LIMIT caps rows returned, not
    // rows read: `WHERE created_at > ? ORDER BY id LIMIT 51` walks the primary
    // key from id 1 through every old row before it finds one to return. That
    // exact query was 7.77B rows/day on 2026-09-16 (test/query-plan-inventory
    // .test.ts records it). A covering-index SCAN is still a walk of every index
    // entry, which is why COUNT(*) FROM posts and the active-citizens count read
    // their whole tables while looking "indexed".
    //
    // A range SEARCH with a LIMIT and nothing forcing a full read is let through:
    // it seeks to the start of the range and stops after the page. That is the
    // one exemption, and its gap is stated: a range SEARCH whose extra, unindexed
    // WHERE terms reject most rows can still read far past the page.
    // A range behind an equality prefix, `(reply_to_citizen_id=? AND rowid>?)`,
    // is bounded by the key: it reads one citizen's rows, not the table's. Only
    // a range with NOTHING in front of it is priced by the table. (`\w+=\?` does
    // not match `>=?` or `<=?`: the character before `=` there is not a word
    // character.) The same caveat as every equality: a low-cardinality key, like
    // a status column, narrows little, and this rule cannot tell.
    const isRange = /[<>]/.test(constraint);
    const hasEqualityPrefix = /\b\w+=\?/.test(constraint);
    const unbounded = m[1] === "SCAN" || (isRange && !hasEqualityPrefix && !canStopEarly);
    if (unbounded && (fallbackCredit.get(table) ?? 0) > 0) {
      fallbackCredit.set(table, fallbackCredit.get(table) - 1);
      continue;
    }
    if (unbounded) hits.push(`${table}: ${d}`);
  }
  return hits.length ? hits : null;
}

const statements = loadStatements();
if (statements.length < MIN_STATEMENTS) {
  console.error(
    `SCAN-GUARD: only ${statements.length} src/ statements were captured (expected at least ${MIN_STATEMENTS}). ` +
      `The capture preload did not run, so there is nothing to vouch for. Run it through \`npm test\`.`,
  );
  process.exit(1);
}

const db = new DatabaseSync(":memory:");
db.exec(readFileSync(`${root}schema.sql`, "utf8"));
const tables = new Set(
  db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name.toLowerCase()),
);

// COVERAGE. The plan check above can only judge a statement a test executed, so
// a new read with no test would pass it unseen: the largest gap in this guard,
// measured 2026-09-17 at 33 of 335 SELECT literals in src/ that the suite never
// runs. So every SELECT literal in src/ must match some statement the suite
// actually prepared. Literals are read from the source with comment lines
// removed; `${...}` interpolations become wildcards, so a query assembled from a
// fixed skeleton and interpolated fragments still matches its executed form.
// The ones uncovered when this landed are listed under `uncovered_reads` in the
// baseline, with the same ratchet: a NEW uncovered read fails, and a listed one
// that is now executed must be deleted.
//
// What it cannot see, stated plainly: a read assembled entirely at runtime with
// no SELECT literal in the source, and a literal whose wildcards happen to match
// an unrelated statement (a false "covered", never a false failure).
const walkTs = (d) =>
  readdirSync(d).flatMap((f) => {
    const p = `${d}/${f}`;
    return statSync(p).isDirectory() ? walkTs(p) : p.endsWith(".ts") ? [p] : [];
  });
const capturedFlat = statements.map((sql) => sql.replace(/\s+/g, " ").trim());
// String literals, scanned rather than regex-matched, because SQL here is often a
// template whose `${...}` holds a ternary with its own quotes or a nested
// template, which a regex cuts in half. Returns each literal as its static
// parts, with every interpolation reduced to a single "\u0000" marker.
function sqlLiterals(code) {
  const out = [];
  let i = 0;
  const skipInterpolation = () => {
    // i is just past "${"; walk to the matching "}", skipping nested strings.
    let depth = 1;
    while (i < code.length && depth > 0) {
      const ch = code[i];
      if (ch === "`") readTemplate();
      else if (ch === '"' || ch === "'") readQuoted(ch);
      else {
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
        i++;
      }
    }
  };
  const readQuoted = (q) => {
    let text = "";
    i++;
    while (i < code.length && code[i] !== q && code[i] !== "\n") {
      if (code[i] === "\\") { text += code[i + 1] ?? ""; i += 2; continue; }
      text += code[i++];
    }
    i++;
    return text;
  };
  function readTemplate() {
    let text = "";
    i++;
    while (i < code.length && code[i] !== "`") {
      if (code[i] === "\\") { text += code[i + 1] ?? ""; i += 2; continue; }
      if (code[i] === "$" && code[i + 1] === "{") { i += 2; skipInterpolation(); text += "\u0000"; continue; }
      text += code[i++];
    }
    i++;
    return text;
  }
  while (i < code.length) {
    const ch = code[i];
    if (ch === "/" && code[i + 1] === "/") { while (i < code.length && code[i] !== "\n") i++; continue; }
    if (ch === "/" && code[i + 1] === "*") { const end = code.indexOf("*/", i + 2); i = end < 0 ? code.length : end + 2; continue; }
    if (ch === "`") { out.push(readTemplate()); continue; }
    if (ch === '"' || ch === "'") { out.push(readQuoted(ch)); continue; }
    i++;
  }
  return out;
}
const readLiterals = [];
for (const file of walkTs(`${root}src`)) {
  for (const raw of sqlLiterals(readFileSync(file, "utf8"))) {
    if (!/^\s*(SELECT|WITH)\b/i.test(raw) || !/\bFROM\b/i.test(raw)) continue;
    readLiterals.push({ file: file.slice(root.length), sql: raw.replace(/\s+/g, " ").trim() });
  }
}

const d1Hits = readLiterals.filter((l) => isRuntimeLikePattern(l.sql));
// ANCHORED, so a literal is covered only by a statement that IS it, not by one
// that merely contains its text (the pre-deploy auditor showed `SELECT id FROM
// comments`, a full scan no test ran, passing as covered inside a longer
// executed statement). It must start where a statement or a parenthesised
// subquery starts, or after a closing parenthesis (INSERT ... (cols) SELECT ...). When it ends on a word character (a table or column name,
// where a longer statement would simply keep going) it must also end where the
// statement or subquery ends; when it ends on a placeholder, quote or bracket, it
// is a fragment the source continues by concatenation, and what follows is free.
const literalPattern = (sql) => {
  const body = sql
    .split("\u0000")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s*"))
    .join("[\\s\\S]*?");
  const endsOnWord = /\w$/.test(sql.replace(/\u0000$/, ""));
  return new RegExp(`(?:^|\\(|\\)\\s)\\s*${body}${endsOnWord ? "\\s*(?:$|\\)|;)" : ""}`);
};
const uncovered = new Map();
for (const lit of readLiterals) {
  const re = literalPattern(lit.sql);
  if (!capturedFlat.some((c) => re.test(c))) {
    uncovered.set(createHash("sha256").update(`${lit.file}\n${normalize(lit.sql.replaceAll("\u0000", "${}"))}`).digest("hex").slice(0, 16), lit);
  }
}

const found = new Map();
let reads = 0;
for (const sql of statements) {
  if (/^\s*(SELECT|WITH)\b/i.test(sql)) reads++;
  const hits = classify(db, tables, sql);
  if (hits) found.set(keyOf(sql), { sql: normalize(sql), plan: hits });
}

if (process.argv.includes("--write-baseline")) {
  const previous = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : { entries: {} };
  const entries = {};
  for (const [k, v] of [...found].sort((a, b) => a[1].sql.localeCompare(b[1].sql))) {
    entries[k] = previous.entries[k] ?? { status: "debt", sql: v.sql.slice(0, 300), plan: v.plan };
  }
  const uncovered_reads = {};
  for (const [k, v] of [...uncovered].sort((a, b) => (a[1].file + a[1].sql).localeCompare(b[1].file + b[1].sql))) {
    uncovered_reads[k] = { file: v.file, sql: v.sql.replaceAll("\u0000", "${…}").slice(0, 300) };
  }
  writeFileSync(BASELINE, JSON.stringify({ note: previous.note ?? "", entries, uncovered_reads }, null, 2) + "\n");
  console.log(
    `SCAN-GUARD: wrote ${Object.keys(entries).length} unbounded and ${Object.keys(uncovered_reads).length} uncovered entries to test/scan-baseline.json`,
  );
  process.exit(0);
}

const baselineFile = JSON.parse(readFileSync(BASELINE, "utf8"));
const baseline = baselineFile.entries;
const uncoveredBaseline = baselineFile.uncovered_reads ?? {};
const newScans = [...found].filter(([k]) => !(k in baseline));
const seenKeys = new Set(statements.map(keyOf));
const nowBounded = Object.entries(baseline).filter(([k]) => seenKeys.has(k) && !found.has(k));
const notRun = Object.keys(baseline).filter((k) => !seenKeys.has(k));
const debt = Object.values(baseline).filter((e) => e.status === "debt").length;

console.log(
  `SCAN-GUARD: ${reads} distinct read statements from src/; ${found.size} unbounded ` +
    `(${debt} debt, ${Object.keys(baseline).length - debt} accepted in the baseline); ${notRun.length} baseline entries did not run.`,
);
let failed = false;
if (d1Hits.length) {
  failed = true;
  console.error(`\nD1-COMPAT: ${d1Hits.length} LIKE/GLOB pattern(s) built from a value — they outgrow D1's SQLITE_MAX_LIKE_PATTERN_LENGTH at execution time in production while passing every offline test (node:sqlite has no such limit and none can be set):\n`);
  for (const h of d1Hits) console.error(`  ${h.file}: ${h.sql.replaceAll("\u0000", "${…}").slice(0, 200)}\n`);
  console.error("  Use a `?` bound by the client, or instr(col, ?) > 0 (no pattern at all). A bound `?` and a fully static '...' literal are fine.\n");
}
if (newScans.length) {
  failed = true;
  console.error(`\nSCAN-GUARD: ${newScans.length} NEW read(s) cost rows in proportion to a whole table:\n`);
  for (const [k, v] of newScans) console.error(`  [${k}] ${v.sql.slice(0, 240)}\n    ${v.plan.join("\n    ")}\n`);
  console.error(
    "  Bound it: an index on the exact lookup, a counter maintained at write time, or a LIMIT.\n" +
      "  If it is genuinely bounded in practice, add it to test/scan-baseline.json as status \"accepted\" with a reason.",
  );
}
if (nowBounded.length) {
  failed = true;
  console.error(`\nSCAN-GUARD: ${nowBounded.length} baseline entr(ies) are now bounded. Delete them so the worklist stays true:`);
  for (const [k, v] of nowBounded) console.error(`  [${k}] ${v.sql.slice(0, 160)}`);
}
const newUncovered = [...uncovered].filter(([k]) => !(k in uncoveredBaseline));
const nowCovered = Object.entries(uncoveredBaseline).filter(([k]) => !uncovered.has(k));
console.log(
  `SCAN-GUARD: ${readLiterals.length} SELECT literals in src/; ${readLiterals.length - uncovered.size} executed by the suite, ` +
    `${uncovered.size} never executed (${Object.keys(uncoveredBaseline).length} listed in the baseline).`,
);
if (newUncovered.length) {
  failed = true;
  console.error(`\nSCAN-GUARD: ${newUncovered.length} NEW read(s) in src/ that no test executes, so their cost cannot be checked:\n`);
  for (const [k, v] of newUncovered) console.error(`  [${k}] ${v.file}: ${v.sql.replaceAll("\u0000", "${…}").slice(0, 200)}`);
  console.error("\n  Add a test that exercises the code path, so this guard can EXPLAIN the statement.");
}
if (nowCovered.length) {
  failed = true;
  console.error(`\nSCAN-GUARD: ${nowCovered.length} listed uncovered read(s) are now executed. Delete them from uncovered_reads:`);
  for (const [k, v] of nowCovered) console.error(`  [${k}] ${v.file}: ${v.sql.slice(0, 160)}`);
}
process.exit(failed ? 1 : 0);
