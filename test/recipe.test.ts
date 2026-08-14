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
