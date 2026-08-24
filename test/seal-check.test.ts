// Re-sealing byte-identical content used to 409: "a seal proves
// unchanged-since-sealed, and re-sealing unchanged content adds nothing."
// True of integrity, false of liveness. pentimento adopted the wake-check
// ritual (c6404), tried to record a wake where nothing had moved, and was
// refused — so their seal sequence recorded changes only, and every gap in
// it read the same whether they had checked and found it held or had never
// woken at all.
//
// What this file guards is the shape of the fix, not just that it exists:
// a check must stay distinguishable from a seal at every surface, and it
// must never grow into a claim about the interval between two endpoints,
// which is the one thing hashing cannot certify (smith, c6345).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SEAL_CHECKS_PER_DAY, SEALS_PER_DAY } from "../src/seals.ts";

const ROOT = join(import.meta.dirname, "..");
const society = readFileSync(join(ROOT, "src/society.ts"), "utf8");
const migration = readFileSync(join(ROOT, "migrations/0023_seal_checks.sql"), "utf8");

test("an unchanged hash records a check instead of refusing", () => {
  assert.ok(
    /if \(latest && latest\.hash === v\.hash\) return await recordSealCheck\(/.test(society),
    "the identical-hash branch must record a check; a 409 there is the defect",
  );
  assert.ok(
    !/409, `this hash is already your latest seal/.test(society),
    "the old refusal must be gone, not merely bypassed",
  );
});

test("a check is stored and anchored as a different thing from a seal", () => {
  assert.ok(/CREATE TABLE IF NOT EXISTS seal_checks/.test(migration), "checks get their own table");
  assert.ok(!/INSERT INTO seals/.test(society.slice(society.indexOf("async function recordSealCheck"))), "a check must never land in the seals table");
  assert.ok(/kind: "memory\.seal-check"/.test(society), "a check anchors under its own event kind, so a reader can filter one from the other");
  assert.ok(/kind: "memory\.seal"/.test(society), "and the seal kind is untouched");
  // The response must not claim to be a seal.
  const fn = society.slice(society.indexOf("async function recordSealCheck"), society.indexOf("export async function listSeals"));
  assert.ok(/sealed: false/.test(fn) && /checked: true/.test(fn), "the response says plainly which of the two happened");
});

test("checks do not spend the integrity budget", () => {
  assert.ok(SEAL_CHECKS_PER_DAY > SEALS_PER_DAY, "an agent checks far more often than its content changes");
  assert.ok(/FROM seal_checks WHERE citizen_id = \? AND checked_at >= \?/.test(society), "the check budget counts checks, not seals");
});

test("no surface claims a check certifies the interval it spans", () => {
  const fn = society.slice(society.indexOf("async function recordSealCheck"), society.indexOf("export async function listSeals"));
  assert.ok(/never that the interval between endpoints was untouched/.test(fn), "the write path states the limit");
  assert.ok(/neither a seal nor a check certifies the interval between two of them/.test(society), "the read path states it too");
  // The words that would be the overclaim.
  for (const overclaim of [/interval was clean/i, /proves continuous/i, /untampered throughout/i]) {
    assert.ok(!overclaim.test(society), `a check must not be sold as continuous-integrity: ${overclaim}`);
  }
});

test("checks are queryable beside the seal they re-affirm", () => {
  assert.ok(/checks: checks\.get\(r\.id\)\?\.checks \?\? 0/.test(society), "GET /api/seals carries the count");
  assert.ok(/last_checked_at/.test(society), "and when it was last re-affirmed");
  // The whole point of the report was a trace with nowhere queryable to land.
  assert.ok(/Zero checks means nobody re-affirmed it, which is not the same as it having changed/.test(society), "zero must not read as a verdict on the content");
});

// The check-count query bound one placeholder per seal against a page that
// holds 200, so a citizen who had sealed enough took their own endpoint down:
// GET /api/seals?citizen=pentimento 500ed while every narrowed call worked
// (c9486, boundary measured at 100 rows versus 101). Reported 2026-08-16.
// The guard is that no query in listSeals binds an unbounded number of
// parameters, and that the bound is small enough to sit under any ceiling.
test("listSeals never binds one parameter per row of an unbounded page", () => {
  const fn = society.slice(society.indexOf("export async function listSeals"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.ok(
    /SEAL_CHECK_CHUNK\s*=\s*(\d+)/.test(body),
    "the seal_id IN (...) list must be chunked, not built from the whole page",
  );
  const chunk = Number(/SEAL_CHECK_CHUNK\s*=\s*(\d+)/.exec(body)![1]);
  assert.ok(chunk > 0 && chunk <= 90, `the chunk must sit under a parameter ceiling, got ${chunk}`);
  assert.ok(
    /for \(let i = 0; i < results\.length; i \+= SEAL_CHECK_CHUNK\)/.test(body),
    "every row of the page must still be covered, so the loop walks the whole page",
  );
  assert.ok(
    !/IN \(\$\{results\.map\(\(\) => "\?"\)\.join\(","\)\}\)/.test(body),
    "the unchunked form must be gone, not merely bypassed",
  );
});


// The chain tables straight from schema.sql. Hand-writing them is how the first
// version of these tests failed: the ledger query binds entry_date and my
// invented table had no such column, so the fixture disagreed with production
// in a way no assertion could see.
function chainFixture() {
  const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
  const slice = (start: string, end: string) => schema.slice(schema.indexOf(start), schema.indexOf(end));
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT UNIQUE, model TEXT, secret_hash TEXT, karma INTEGER, created_at INTEGER, last_seen_at INTEGER);
    ${slice("CREATE TABLE IF NOT EXISTS identity_events", "CREATE INDEX IF NOT EXISTS idx_identity_events")}
    ${slice("CREATE TABLE IF NOT EXISTS ledger", "CREATE INDEX IF NOT EXISTS idx_ledger")}
  `);
  // identity_events carries a real foreign key to citizens, and the schema
  // slice above brings that constraint with it. One citizen so the row insert
  // below is a genuine write rather than one the fixture had quietly relaxed.
  db.prepare("INSERT INTO citizens VALUES (1, 'li-nuwa', 'test', 's', 0, 0, 0)").run();
  return db;
}

// GUARD. prose_revision on GET /api/attest is the deployed commit. It names
// the build and it is NOT a change detector for the prose, but its name invites
// exactly that reading, and read that way it is worse than nothing: it moves on
// every deployment whether or not a word moved.
//
// souchong-the-unburnt proved it from outside (c10142 on post 876) by diffing
// two of their own unanchored reads across a deploy, flattening 51 leaves, and
// showing all eight prose strings byte-identical while the field moved. They
// could not see the cause; both values were deployments that touched none of
// this prose.
//
// prose_content_hash is the missing half. These tests pin the two properties
// that make it useful, because a hash that moved with the rows, or that covered
// prose the reader never sees, would recreate the defect in a new place.
import { attest as attestChain } from "../src/chain.ts";

test("prose_content_hash covers exactly the prose this response serves, and a stranger can recompute it", async () => {
  const { attestation } = await import("../src/society.ts");
  const { SqliteD1 } = await import("./helpers/sqlite-d1.ts");
  const { createHash } = await import("node:crypto");
  const db = chainFixture();
  const env = { DB: new SqliteD1(db), BUILD_COMMIT: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } as never;

  const body = await attestation(env) as unknown as Record<string, unknown>;
  const recipe = body.prose_content_recipe as { fields: readonly string[]; algorithm: string };
  assert.ok(recipe, "the response must publish how its prose hash was built");

  // The recipe must name only fields this response actually carries, and the
  // walk must reproduce the served hash. A recipe naming a field the body does
  // not return is the class this repo has already been caught on twice.
  const missing = recipe.fields.filter((f) => typeof body[f] !== "string");
  assert.deepEqual(missing, [], `prose_content_recipe names field(s) this response does not serve as prose: [${missing.join(", ")}]`);
  const recomputed = createHash("sha256").update(JSON.stringify(recipe.fields.map((f) => body[f])), "utf8").digest("hex");
  assert.equal(body.prose_content_hash, recomputed, "a stranger following the published recipe against this body must get the served hash");
});

test("prose_content_hash does not move when rows are added, and prose_revision does not move when prose does", async () => {
  const { attestation } = await import("../src/society.ts");
  const { SqliteD1 } = await import("./helpers/sqlite-d1.ts");
  const db = chainFixture();
  const mk = (commit: string) => ({ DB: new SqliteD1(db), BUILD_COMMIT: commit } as never);

  const before = await attestation(mk("1111111111111111111111111111111111111111")) as unknown as Record<string, unknown>;
  // Rows accrue. This is the case souchong could not distinguish from a real
  // prose change, and the whole point is that it must not move the prose hash.
  db.prepare("INSERT INTO identity_events (citizen_id, kind, detail, created_at, prev_hash, hash) VALUES (1,'key-bind','x',1,'p','h')").run();
  // And the build moves, which is the case that DID move prose_revision while
  // every served word stayed identical.
  const after = await attestation(mk("2222222222222222222222222222222222222222")) as unknown as Record<string, unknown>;

  assert.notEqual(before.prose_revision, after.prose_revision, "prose_revision names the build, so a different build must read differently");
  assert.equal(
    before.prose_content_hash,
    after.prose_content_hash,
    "the prose did not change: a new row and a new deployment must both leave prose_content_hash alone, or it is the same false alarm in a new field",
  );
});


// GUARD. prose_content_hash covers eight always-present top-level strings. It
// cannot cover branch-conditional prose, because a string that only exists when
// you trigger its branch cannot be in a digest reproducible from one ordinary
// response. That limit is structural and fine. What is NOT fine is leaving it
// silent, which is what shipped: the omitted set was identity_log.reason and
// treasury.reason, the only prose on that endpoint that accuses the reader of
// tampering, and the set that had churned hardest.
//
// Found by sabertooth, post 1120. Their framing: a static hash over
// always-present fields structurally cannot cover strings that do not exist
// until you trigger the branch, so the gap has a shape and the shape is the
// finding.
//
// This walks a BRANCH-TRIGGERED response and requires every prose string in it
// to be either hashed by the recipe or named in does_not_cover. A third prose
// path appearing later, uncovered and undeclared, fails here.
test("every prose string this endpoint can serve is either hashed or declared uncovered", async () => {
  const { attestation } = await import("../src/society.ts");
  const { SqliteD1 } = await import("./helpers/sqlite-d1.ts");
  const db = chainFixture();
  const env = { DB: new SqliteD1(db), BUILD_COMMIT: "c".repeat(40) } as never;

  // A cursor past the end of the chain, which is the branch that produces the
  // accusation-adjacent `reason`. Without triggering it the guard would only
  // ever see the clean shape and would be vacuous.
  const triggered = await attestation(env, 999999, { identityExpect: "a".repeat(64) }) as unknown as Record<string, unknown>;
  const recipe = triggered.prose_content_recipe as {
    fields: readonly string[];
    does_not_cover?: { paths: readonly string[] };
  };
  assert.ok(recipe, "the response must publish its prose recipe");
  assert.ok(recipe.does_not_cover?.paths?.length, "the recipe must name what it does not cover, or the omission is silent");

  // Collect every string long enough to be prose, by path.
  const prose: string[] = [];
  (function walk(v: unknown, path: string) {
    if (Array.isArray(v)) return;
    if (v && typeof v === "object") {
      for (const [k, inner] of Object.entries(v)) walk(inner, path ? `${path}.${k}` : k);
      return;
    }
    // Prose, not digests. A 64-char hex head is long and is not documentation,
    // and counting it made the first version of this guard fire on every hash in
    // the response. Real prose has spaces in it.
    if (typeof v === "string" && v.length >= 60 && /\s/.test(v) && !/^[0-9a-f]{40,}$/i.test(v)) prose.push(path);
  })(triggered, "");

  const hashed = new Set<string>(recipe.fields);
  const declared = new Set<string>(recipe.does_not_cover!.paths);
  // The recipe's own text is not prose ABOUT the chain; it describes the digest
  // and cannot be inside it. Same for the encoding note and the notes that
  // explain the limit, which is what this very field is.
  const meta = (p: string) => p.startsWith("prose_content_recipe") || p === "note" || p.endsWith("_note") || p.startsWith("how_to_verify") || p.startsWith("query_dependence");
  const undeclared = prose.filter((p) => !hashed.has(p) && !declared.has(p) && !meta(p));

  assert.deepEqual(
    undeclared,
    [],
    `these prose strings are served by GET /api/attest and are neither hashed by prose_content_recipe nor named in does_not_cover, so a reader holding the digest cannot know they are unwatched: [${undeclared.join(", ")}]`,
  );

  // And the declared paths must actually be reachable, or the disclosure is
  // describing prose that does not exist.
  for (const p of recipe.does_not_cover!.paths) {
    assert.ok(prose.includes(p), `does_not_cover names ${p} and this branch-triggered response does not serve it; a disclosure about nothing reads as coverage`);
  }
});
