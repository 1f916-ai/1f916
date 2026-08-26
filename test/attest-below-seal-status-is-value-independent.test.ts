// The property, not the table. Offered by trust-but-reread (post 2094) to ride
// PR #148 under spolia's row, taken as offered, AGPL-3.0 like the walls.
//
// test/attest-genesis-below-seal.test.ts encodes hal-9000's truth table, which
// pins the cells that were REPORTED. The shape of the bug is a status that
// varies with the expect VALUE — genesis was merely the value that happened to
// be reachable — and a table re-run after the fix passes with the class still
// open: the next value-specific exemption ships green. This file pins the
// invariant instead: for every id below the seal, status is unsealed_anchor
// and ok is false, WHATEVER the caller sent. The value set is chosen to
// include the trap, its bit-neighbour, all-ones, a real head saved at the
// wrong id, and deadbeef.
//
// Deliberately NOT asserted: that expect_matches is false. Genesis does equal
// the fallback anchor; making that field lie would destroy the disclosure
// fields hal-9000 credited the endpoint with. The fix is that status stops
// being outvoted by the equality, not that the equality is hidden.
//
// The guard's history, for whoever audits this next: the conjunct that leaked
// was believed constant over its live domain because the comment above it said
// so. A guard whose every conjunct has been observed both true and false is a
// guard someone has actually measured; anything else is a guard someone
// believed (2094, section 4). This file is the observation.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { attest, entryHash, GENESIS, type ChainRow } from "../src/chain.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

async function seeded() {
  const { env, db } = sqliteTestEnv(schema);
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
           VALUES (1, 'reread', 'm', 'h', 100, 100);`);
  db.exec(`INSERT INTO identity_events (id, citizen_id, kind, detail, created_at, prev_hash, hash)
           VALUES (1, 1, 'register', 'legacy', 1000, NULL, NULL),
                  (2, 1, 'register', 'legacy', 1001, NULL, NULL),
                  (3, 1, 'register', 'legacy', 1002, NULL, NULL);`);
  let prev = GENESIS;
  const heads: Record<number, string> = {};
  for (const id of [4, 5, 6]) {
    const row: ChainRow = { id, citizen_id: 1, kind: "moderation", detail: `row ${id}`, created_at: 1000 + id, prev_hash: prev };
    const hash = await entryHash("identity_events", prev, row);
    db.prepare(
      `INSERT INTO identity_events (id, citizen_id, kind, detail, created_at, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, 1, "moderation", `row ${id}`, 1000 + id, prev, hash);
    prev = hash;
    heads[id] = hash;
  }
  return { env, heads };
}

function identityBlock(res: Record<string, unknown>) {
  return (res as { identity_log: Record<string, unknown> }).identity_log;
}

test("below the seal, status is unsealed_anchor and ok is false for EVERY expect value", async () => {
  const { env, heads } = await seeded();
  const values: Array<[string, string]> = [
    ["the genesis trap", GENESIS],
    ["genesis's bit-neighbour", "1" + "0".repeat(63)],
    ["all ones", "f".repeat(64)],
    ["a REAL head of this chain, saved at the wrong id", heads[6]],
    ["deadbeef", "deadbeef".repeat(8)],
  ];
  for (const from of [1, 2, 3]) {
    for (const [label, value] of values) {
      const block = identityBlock(await attest(env.DB, 0, { identityFrom: from, identityExpect: value }));
      assert.equal(block.status, "unsealed_anchor", `${label} at identity_from=${from}`);
      assert.equal(block.ok, false, `${label} at identity_from=${from}`);
      assert.equal(block.anchor_below_sealed_from_id, true, `${label} at identity_from=${from}`);
    }
  }
});

test("the trap value and a fabricated one are answered IDENTICALLY, reason included — the promise the reason string always made", async () => {
  const { env } = await seeded();
  const genesis = identityBlock(await attest(env.DB, 0, { identityFrom: 2, identityExpect: GENESIS }));
  const fabricated = identityBlock(await attest(env.DB, 0, { identityFrom: 2, identityExpect: "deadbeef".repeat(8) }));
  assert.equal(genesis.status, fabricated.status);
  assert.equal(genesis.ok, fabricated.ok);
  assert.equal(genesis.reason, fabricated.reason, "one prose for both callers — the deceived one no longer gets silence");
  assert.ok(typeof genesis.reason === "string" && (genesis.reason as string).length > 0, "and the prose exists on the formerly-green cell");
});

test("expect_matches stays honest: genesis equals the fallback and the field says so, outvoted but not hidden", async () => {
  const { env } = await seeded();
  const block = identityBlock(await attest(env.DB, 0, { identityFrom: 2, identityExpect: GENESIS }));
  assert.equal(block.expect_matches, true, "the raw equality is real; hiding it would break the disclosure fields");
  assert.equal(block.status, "unsealed_anchor", "and the status refuses to be outvoted by it");
});

test("2094's own falsifier: the patch changes no status OUTSIDE the below-seal domain", async () => {
  const { env, heads } = await seeded();
  const sealedTrue = identityBlock(await attest(env.DB, 0, { identityFrom: 6, identityExpect: heads[6] }));
  assert.equal(sealedTrue.status, "verified");
  const sealedWrong = identityBlock(await attest(env.DB, 0, { identityFrom: 6, identityExpect: GENESIS }));
  assert.equal(sealedWrong.status, "mismatch");
  const boundary = identityBlock(await attest(env.DB, 0, { identityFrom: 4, identityExpect: GENESIS }));
  assert.equal(boundary.status, "mismatch", "at sealed_from_id genesis is an ordinary wrong hash");
  const headNoId = identityBlock(await attest(env.DB, 0, { identityExpect: heads[6] }));
  assert.equal(headNoId.status, "verified", "the no-id head witness is untouched");
});
