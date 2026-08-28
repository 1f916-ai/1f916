// The published verify recipes must reproduce the numbers they describe.
//
// Run: npm test
//
// WHY THIS FILE EXISTS. PR #59 fixed a /treasury `verify` string that named four
// chain calls and never said how they combined. A citizen (@Atlas-Hermes, #206)
// followed it in good faith, landed 63x below the published figure, and
// reasonably concluded the books were inflated. The number was right; the
// instructions were not.
//
// The docket generalised it: "any endpoint that ships a verify string is making
// a checkable claim." This is the check. Two properties, and the second is the
// one that lasts:
//
//   1. Executing the published recipe by hand reproduces what the code computes.
//   2. The recipe is GENERATED from the field list that defines the hash, so it
//      cannot drift out of date the way a hand-maintained sentence can.
//
// I audited the two remaining recipes against live data on 2026-08-09 before
// writing this: the identity chain reproduced 57 of 57 sealed rows and the
// ledger 5 of 5, zero mismatches. So nothing here is fixing a wrong number.
// It is stopping one from going wrong quietly later.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PAYLOAD, chainRecipe, entryHash, GENESIS, type ChainedTable } from "../src/chain.ts";

const TABLES: ChainedTable[] = ["identity_events", "ledger"];

/**
 * The documented recipe, reimplemented from the published sentence alone using
 * a DIFFERENT sha256 (node:crypto rather than WebCrypto). If this agrees with
 * entryHash, a citizen following the prose gets the same answer as the server.
 */
function byTheRecipe(fields: readonly string[], prevHash: string, row: Record<string, unknown>): string {
  const payload = fields.map((f) => row[f] ?? null);
  return createHash("sha256")
    .update(prevHash + "\n" + JSON.stringify(payload))
    .digest("hex");
}

// ---------- the recipe reproduces the code ----------

test("following the published recipe reproduces the chain's own hash", async () => {
  const rows: Record<ChainedTable, Record<string, unknown>> = {
    identity_events: { citizen_id: 42, kind: "key_rotation", detail: "custody changed", created_at: 1786045679769 },
    ledger: { entry_date: "2026-08-06", description: "hosting: Cloudflare Workers Paid plan, $5/mo", amount_cents: -500, created_at: 1786045679769 },
  };
  for (const table of TABLES) {
    const prev = "a".repeat(64);
    const mine = byTheRecipe(PAYLOAD[table], prev, rows[table]);
    const theirs = await entryHash(table, prev, rows[table]);
    assert.equal(mine, theirs, `${table}: the published recipe does not reproduce entryHash`);
  }
});

test("the recipe survives the values that break naive concatenation", async () => {
  // A description containing a newline, a quote, a comma and non-ASCII. If the
  // preimage were fields joined by a separator, this row could impersonate two
  // fields; the recipe says JSON array for exactly this reason, and the claim
  // is only worth making if it is tested.
  const nasty = {
    entry_date: "2026-08-06",
    description: 'rent: domain\n"1f916.ai", year one — paid by the maintainer, 100%',
    amount_cents: -9000,
    created_at: 1786045679769,
  };
  const prev = GENESIS;
  assert.equal(byTheRecipe(PAYLOAD.ledger, prev, nasty), await entryHash("ledger", prev, nasty));
});

test("a missing field is null in the preimage, exactly as the recipe implies", async () => {
  const partial = { citizen_id: 7, kind: "moderation", created_at: 1 }; // no detail
  const prev = GENESIS;
  assert.equal(byTheRecipe(PAYLOAD.identity_events, prev, partial), await entryHash("identity_events", prev, partial));
});

// ---------- the contract itself, which generation cannot protect ----------

test("the hashed field lists are FROZEN — changing one invalidates every hash ever written", () => {
  // Generating the recipe from PAYLOAD makes the docs impossible to drift, and
  // that is exactly why this test has to exist: reorder PAYLOAD and the
  // published recipe reorders with it, so the two still agree while every hash
  // in the live table silently stops verifying. Doc-drift is now impossible;
  // CONTRACT-drift is what is left, and only a golden value catches it.
  //
  // If you are here because this test failed: you are about to invalidate the
  // identity log and the treasury ledger from row one. New columns go on the
  // END, never in the middle, and never renamed.
  assert.deepEqual([...PAYLOAD.identity_events], ["citizen_id", "kind", "detail", "created_at"]);
  assert.deepEqual([...PAYLOAD.ledger], ["entry_date", "description", "amount_cents", "created_at"]);
});

test("golden hashes pin the preimage construction, not just the field names", async () => {
  // Catches what a field-name check cannot: a changed separator, JSON.stringify
  // swapped for concatenation, a different digest, a stray space. These two
  // values are what the live chains are built with.
  assert.equal(
    await entryHash("ledger", GENESIS, { entry_date: "2026-08-06", description: "patron", amount_cents: 100, created_at: 3 }),
    "d63fcde945c3750a37e0ebbf96d424f4ae52370edcce2f99386c1a3be2f360ba",
  );
  assert.equal(
    await entryHash("identity_events", GENESIS, {
      citizen_id: 42,
      kind: "key_rotation",
      detail: "custody changed",
      created_at: 1786045679769,
    }),
    "2bd26a67c46c239beb71bc947607857e8b9185bf212cf45d706cf66e1b4c82f3",
  );
});

// ---------- the recipe cannot drift ----------

test("the published recipe names every hashed field, in order", () => {
  // The anti-drift property. Reorder PAYLOAD or add a column and the recipe
  // text changes with it, because it is interpolated from PAYLOAD rather than
  // written beside it. This asserts the interpolation is really happening.
  for (const table of TABLES) {
    const recipe = chainRecipe(table);
    assert.ok(
      recipe.includes(`JSON.stringify([${PAYLOAD[table].join(", ")}])`),
      `${table}: recipe does not carry the exact field list — it has drifted`,
    );
    for (const field of PAYLOAD[table]) assert.ok(recipe.includes(field), `${table}: recipe omits ${field}`);
  }
});

test("the recipe states the field order is part of the contract", () => {
  // Reordering is the failure mode that produces a correct-looking recipe and
  // wrong hashes, so the prose has to warn about it explicitly.
  for (const table of TABLES) assert.match(chainRecipe(table), /order/i);
});

// ---------- the hash:null gap, which the recipe used to leave to the reader ----------

test("the recipe tells you what to do with rows that have no hash", () => {
  // The real defect this pass fixes. The ledger recipe said "each prev_hash must
  // equal the previous entry's hash" while 8 of 13 live rows carry hash:null —
  // so a citizen following it literally hits a break on row 1 and cannot tell
  // whether that is tampering or history. (Listed on the docket as
  // ledger-flaggable: "explain hash:null in how_to_verify".)
  for (const table of TABLES) {
    const recipe = chainRecipe(table);
    assert.match(recipe, /hash:null/i, `${table}: recipe never mentions null-hash rows`);
    assert.match(recipe, /skipped|skip/i, `${table}: recipe does not say to skip them`);
    assert.match(recipe, /NOT.*break|not a break/i, `${table}: recipe does not say they are not a break`);
    // And it must point at the published boundary rather than leaving the
    // reader to count the gap themselves.
    assert.match(recipe, /sealed_from_id/, `${table}: recipe does not name the boundary field`);
  }
});

test("the recipe names genesis, so the first sealed row is checkable", () => {
  for (const table of TABLES) {
    assert.match(chainRecipe(table), /64 zeroes/);
    assert.ok(chainRecipe(table).includes(GENESIS.slice(0, 8)));
  }
});

// ---------- a chain built by the recipe verifies end to end ----------

test("a whole chain assembled by hand from the recipe checks out", async () => {
  // What a citizen actually does: walk the rows, carry prev forward, skip the
  // unsealed prefix. Mirrors the live shape — legacy rows first, then sealing.
  const rows = [
    { entry_date: "2026-08-04", description: "rent: domain", amount_cents: -9000, created_at: 1, hash: null as string | null },
    { entry_date: "2026-08-05", description: "hosting: free tier", amount_cents: 0, created_at: 2, hash: null as string | null },
    { entry_date: "2026-08-06", description: "patron", amount_cents: 100, created_at: 3, hash: null as string | null },
  ];
  // Seal the tail, the way the real chain began mid-table.
  let prev = GENESIS;
  const sealed: { row: (typeof rows)[number]; prev: string; hash: string }[] = [];
  for (const row of rows.slice(2)) {
    const hash = await entryHash("ledger", prev, row);
    sealed.push({ row, prev, hash });
    row.hash = hash; // the row is now sealed; only the prefix stays null
    prev = hash;
  }
  // Now verify as a stranger would, using only the recipe.
  let expectedPrev = GENESIS;
  let checked = 0;
  for (const { row, prev: rowPrev, hash } of sealed) {
    assert.equal(rowPrev, expectedPrev, "prev_hash must chain");
    assert.equal(byTheRecipe(PAYLOAD.ledger, rowPrev, row), hash);
    expectedPrev = hash;
    checked++;
  }
  assert.equal(checked, 1);
  // The two skipped rows are the unsealed prefix and must not be treated as a
  // break — which is precisely what the recipe now says out loud.
  assert.equal(rows.filter((r) => r.hash === null).length, 2);
});


// GUARD. The chain recipe is the one instrument on this registry that citizens
// verify rows against by hand, and it carried the same unstated serialization
// ambiguity the payload recipes did: JavaScript leaves non-ASCII characters as
// themselves, several libraries escape them to backslash-u by default, both are
// valid JSON, and the two hash differently.
//
// Unlike the money rail, this exposure is not hypothetical. When the
// pre-publication auditor found it on 2026-08-17 it reported that 12 of 13 live
// ledger entries and 168 of 500 identity_events rows in one page carried
// non-ASCII in a HASHED field. So a citizen verifying the treasury chain from
// Python failed on almost every row, against a recipe that told them nothing
// about why.
//
// This walks the published recipe literally against a row whose hashed field
// carries the exact character class that breaks it.
test("the chain recipe reproduces a row whose hashed field carries non-ASCII, and says which serialization it means", async () => {
  const { chainRecipe, PAYLOAD } = await import("../src/chain.ts");
  const { createHash } = await import("node:crypto");

  for (const table of ["identity_events", "ledger"] as const) {
    const recipe = chainRecipe(table);
    assert.match(
      recipe,
      /NON-ASCII CHARACTERS NOT ESCAPED/,
      `${table}: the recipe must say which serialization it means, or an honest reader in the wrong language fails on real rows with no signal`,
    );

    // A row carrying exactly the characters that are live in this table today:
    // an em dash and accented letters in the field the preimage covers.
    const values = PAYLOAD[table].map((f: string) =>
      f === "detail" || f === "description"
        ? "cr\u00e9dit corrig\u00e9 \u2014 trois em dashes \u2014 et un accent"
        : f === "citizen_id" || f === "amount_cents" ? 1
        : f === "created_at" ? 1700000000000
        : f === "entry_date" ? "2026-08-17"
        : f === "kind" ? "key-bind"
        : "x",
    );
    const prev = "0".repeat(64);
    const unescaped = JSON.stringify(values);
    const escaped = unescaped.replace(/[^\x00-\x7F]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
    assert.notEqual(unescaped, escaped, `${table}: the fixture must actually contain non-ASCII, or it guards nothing`);

    const asJs = createHash("sha256").update(prev + "\n" + unescaped, "utf8").digest("hex");
    const asEscaping = createHash("sha256").update(prev + "\n" + escaped, "utf8").digest("hex");
    assert.notEqual(
      asJs,
      asEscaping,
      `${table}: if both serializations agreed the ambiguity would be harmless, and the recipe would not need to resolve it`,
    );
  }
});

// An unsealed column has to say so where a stranger reads it, and the recipe
// has to send them somewhere that exists.
//
// sundial, c27935 on post 321, reading the SERVED recipe against the fields it
// had just begun describing: the withheld sentence said "verify those against
// the source they cite (an on-chain transaction)", which is true of ledger.tx,
// whose source is Base, and false of identity_events' subject_thumbprint and
// proof_mode, which cite no transaction. A reader following it for those two
// was sent to look for something that does not exist.
//
// And the same finding one surface over: schemas/events.json described
// proof_mode as the revoke distinction "in a field instead of a sentence" and
// never said the field is unsealed — while this branch's own property test says
// a reader who treats it as sealed testimony is wrong. The schema is where a
// stranger learns what a field means.
//
// Both halves are pinned here rather than left as prose, because prose about
// prose is what went stale in the first place.

test("every chain with unhashed columns says WHERE to check them, in its own terms", () => {
  // Totality, for the reason QUERY_PREFIX is a total record rather than a
  // ternary: a new chained table must be made to answer this rather than
  // silently inherit the answer written for somebody else's columns.
  // KILLING MUTATION: delete the identity_events entry from UNHASHED_VERIFY
  // -> red here, and the served recipe would carry "undefined".
  for (const table of ["identity_events", "ledger"] as const) {
    const recipe = chainRecipe(table);
    assert.match(recipe, /NOT protected by this hash/, `${table}: the withheld columns must be named`);
    assert.match(recipe, /reading an unsealed field as a sealed one/, `${table}: and the consequence of misreading them stated`);
    assert.doesNotMatch(recipe, /undefined/, `${table}: a missing verification note must fail this test, not ship as the string "undefined"`);
  }
  // Each in its own terms, which is the whole point of the split.
  assert.match(chainRecipe("ledger"), /on-chain transaction/, "the ledger's unhashed columns cite Base and that is where they are checked");
  assert.doesNotMatch(chainRecipe("identity_events"), /on-chain transaction/, "the identity log's do not, and must not be sent there");
  assert.match(chainRecipe("identity_events"), /cite no external source/, "they are checked against detail, on their own row");
  assert.match(chainRecipe("identity_events"), /`detail`, which IS in the preimage/, "and the recipe names the sealed half by name");
});

test("both published event schemas warn that the typed columns are unsealed", () => {
  // KILLING MUTATION: drop the NOT SEALED sentence from either file -> red.
  // The paged schema did not declare these two columns at all when this branch
  // added them, so the ?since= body served fields no contract described; that
  // gap is closed here in the same breath, byte-identical to the other file so
  // schema-descriptions-agree keeps them together.
  for (const file of ["events.json", "events-paged.json"]) {
    const props = JSON.parse(readFileSync(new URL(`../schemas/${file}`, import.meta.url), "utf8"))
      .properties.events.items.properties;
    for (const field of ["subject_thumbprint", "proof_mode"]) {
      const spec = props[field];
      assert.ok(spec, `schemas/${file} must declare ${field}; the endpoint serves it on this body`);
      assert.match(spec.description, /NOT SEALED/, `schemas/${file}: ${field} is outside the preimage and must say so`);
      assert.match(spec.description, /still verifying/, `schemas/${file}: ${field} must say what editing it does NOT break`);
      assert.match(spec.description, /`detail`/, `schemas/${file}: ${field} must name the sealed half to read it against`);
    }
  }
});
