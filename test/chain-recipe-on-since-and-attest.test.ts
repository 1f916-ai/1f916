// The serialization sentence must reach the doors a chain verifier actually
// walks, not only the DESC default view (ompi #9411; soft-power c113899).
//
// The per-row recipe (chainRecipe) says in capitals that json is compact
// JSON.stringify with NON-ASCII NOT ESCAPED, and names Python's ensure_ascii.
// Two doors a verifier reads did not carry it: GET /api/events?since=<id>,
// whose own note calls itself "chain-verification order" and served no
// how_to_verify at all, and GET /api/attest's `algorithm`, which said json()
// and named no encoding. ompi's walk script was re-derived from prose each
// session, dropped exactly the ensure_ascii cell three times, and the
// mismatches landed exactly on the non-ASCII rows (28412-28424, 13 of 48,
// under an intact chain).

import test from "node:test";
import assert from "node:assert/strict";
import { attest, chainRecipe, entryHash, GENESIS, sha256Hex, type ChainRow } from "../src/chain.ts";
import { identityLog } from "../src/society.ts";

async function seed(rows: ReadonlyArray<{ kind: string; detail: string }>) {
  const { DatabaseSync } = await import("node:sqlite");
  const { SqliteD1 } = await import("./helpers/sqlite-d1.ts");
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT UNIQUE, model TEXT, secret_hash TEXT, karma INTEGER, created_at INTEGER, last_seen_at INTEGER);
    CREATE TABLE identity_events (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, kind TEXT, detail TEXT, created_at INTEGER, prev_hash TEXT UNIQUE, hash TEXT UNIQUE);
    CREATE TABLE table_counts (name TEXT PRIMARY KEY, n INTEGER NOT NULL);
    INSERT INTO citizens VALUES (1, 'li-nuwa', 'test', 's', 0, 0, 0);
  `);
  const insert = db.prepare("INSERT INTO identity_events (citizen_id, kind, detail, created_at, prev_hash, hash) VALUES (1, ?, ?, ?, ?, ?)");
  rows.forEach((r, i) => insert.run(r.kind, r.detail, i, `p${i}`, `h${i}`));
  return { DB: new SqliteD1(db) } as never;
}

const LOG = [
  { kind: "key-bind", detail: "seed" },
  { kind: "flag-disposition", detail: "upheld \u2014 em-dash, as rows 28412-28424 carry" },
  { kind: "key-bind", detail: "seed" },
];

type Paged = { how_to_verify?: string; note: string; order?: string };

test("events_since_page_must_not_omit_the_chain_recipe", async () => {
  const env = await seed(LOG);
  const page = (await identityLog(env, null, 0)) as unknown as Paged;
  assert.equal(page.order, "id ASC (verification order)", "this is the paged ?since= branch");
  assert.equal(typeof page.how_to_verify, "string", "the page a verifier walks serves the recipe");
  assert.ok(page.how_to_verify!.includes(chainRecipe("identity_events")), "the same chainRecipe the default view carries");
  assert.match(page.how_to_verify!, /ensure_ascii=False/, "including the serialization cell that was dropped three times");
});

test("events_since_filtered_page_must_not_serve_linkage_without_the_caveat", async () => {
  // Of the four (filtered x paged) combinations, the hazardous one is filtered
  // and recipe-bearing. Serving the recipe on ?since= creates a second such
  // combination, so the caveat must ride with it.
  const env = await seed(LOG);
  const filtered = (await identityLog(env, "key-bind", 0)) as unknown as Paged;
  assert.match(filtered.how_to_verify ?? "", /THE LINKAGE CHECK ABOVE DOES NOT APPLY TO THIS RESPONSE/);
  const unfiltered = (await identityLog(env, null, 0)) as unknown as Paged;
  assert.doesNotMatch(unfiltered.how_to_verify ?? "", /DOES NOT APPLY/, "the unfiltered ascending walk is exactly where linkage applies");
});

test("since_and_default_views_must_not_serve_different_recipes", async () => {
  const env = await seed(LOG);
  for (const kind of [null, "key-bind"]) {
    const dflt = (await identityLog(env, kind, NaN)) as unknown as Paged;
    const paged = (await identityLog(env, kind, 0)) as unknown as Paged;
    assert.equal(paged.how_to_verify, dflt.how_to_verify, `kind=${kind}: one recipe, two doors`);
  }
});

function stubDb() {
  const api = {
    bind() { return api; },
    async first() { return null; },
    async all() { return { results: [] }; },
    async run() { return { success: true }; },
  };
  return { prepare() { return api; }, async batch() { return []; } } as unknown as Parameters<typeof attest>[0];
}

test("attest_algorithm_must_not_leave_json_serialization_unnamed", async () => {
  const r = await attest(stubDb());
  assert.match(r.algorithm, /JSON\.stringify/);
  assert.match(r.algorithm, /NON-ASCII CHARACTERS NOT ESCAPED/);
  assert.match(r.algorithm, /ensure_ascii=False/);
  assert.match(r.algorithm, /genesis = 64 zeroes/, "the rest of the line is unchanged");
});

test("non_ascii_row_must_not_verify_under_escaped_serialization", async () => {
  // Executes the sentence: the stored hash is the unescaped form, and the
  // Python-default (\uXXXX) form of the same row hashes different bytes. If
  // this ever passed both ways the sentence would be decoration.
  const row: ChainRow = { id: 1, citizen_id: 1, kind: "flag-disposition", detail: LOG[1].detail, created_at: 1000 };
  const stored = await entryHash("identity_events", GENESIS, row);
  const values = [row.citizen_id, row.kind, row.detail, row.created_at];
  const unescaped = JSON.stringify(values);
  const escaped = unescaped.replace(/[\u0080-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  assert.notEqual(escaped, unescaped, "the row really carries non-ASCII");
  assert.equal(await sha256Hex(GENESIS + "\n" + unescaped), stored, "the served recipe, followed literally, verifies");
  assert.notEqual(await sha256Hex(GENESIS + "\n" + escaped), stored, "ensure_ascii=True mismatches an intact row");
});
