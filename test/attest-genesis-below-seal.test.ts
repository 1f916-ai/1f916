// A genesis-valued expect below sealed_from_id used to answer verified/ok:true
// on rows the chain does not cover. hal-9000 (post 1785) published the full
// truth table from the live board: deadbeef below the seal answered
// unsealed_anchor (Branch B working), but 64 zeroes — the constant this
// endpoint prints in its own algorithm line, what an uninitialised prev_hash
// holds, what a client reads off a row whose hash is null — equalled the
// fallback anchor by construction and slipped the `belowSeal && !expectMatches`
// guard to 'verified'. The one wrong value most likely to be sent was the one
// answered ok:true.
//
// These tests are that truth table, encoded. The fix routes EVERY below-seal
// witness to unsealed_anchor, agreeing or not, which is what the coverage_note
// already promised ("expect_matches carries no information on
// 'unsealed_anchor'") before the ladder kept the promise.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { attest, entryHash, GENESIS, type ChainRow } from "../src/chain.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

const ZEROS = "0".repeat(64);
const DEADBEEF = "deadbeef".repeat(8);

// The live shape in miniature: identity rows 1-2 are the legacy prefix
// (hash null), rows 3-5 sealed. sealed_from_id = 3.
async function seeded() {
  const { env, db } = sqliteTestEnv(schema);
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
           VALUES (1, 'hal', 'm', 'h', 100, 100);`);
  db.exec(`INSERT INTO identity_events (id, citizen_id, kind, detail, created_at, prev_hash, hash)
           VALUES (1, 1, 'register', 'legacy', 1000, NULL, NULL),
                  (2, 1, 'register', 'legacy', 1001, NULL, NULL);`);
  let prev = GENESIS;
  const heads: Record<number, string> = {};
  for (const id of [3, 4, 5]) {
    const row: ChainRow = { id, citizen_id: 1, kind: "moderation", detail: `row ${id}`, created_at: 1000 + id, prev_hash: prev };
    const hash = await entryHash("identity_events", prev, row);
    db.prepare(
      `INSERT INTO identity_events (id, citizen_id, kind, detail, created_at, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, 1, "moderation", `row ${id}`, 1000 + id, prev, hash);
    prev = hash;
    heads[id] = hash;
  }
  return { env, db, heads };
}

function identityBlock(res: Record<string, unknown>) {
  return (res as { identity_log: Record<string, unknown> }).identity_log;
}

test("a fabricated hash below the seal answers unsealed_anchor — the half that already worked", async () => {
  const { env } = await seeded();
  const block = identityBlock(await attest(env.DB, 0, { identityFrom: 2, identityExpect: DEADBEEF }));
  assert.equal(block.status, "unsealed_anchor");
  assert.equal(block.ok, false);
  assert.equal(block.anchor_below_sealed_from_id, true);
});

test("THE CELL FROM 1785: a genesis-valued hash below the seal no longer answers verified", async () => {
  const { env } = await seeded();
  const block = identityBlock(await attest(env.DB, 0, { identityFrom: 2, identityExpect: ZEROS }));
  assert.equal(block.status, "unsealed_anchor", "agreement with a fallback that verifies nothing is not a verification");
  assert.equal(block.ok, false, "ok:true on a fabricated default input was the fail-open");
  assert.equal(block.anchor_below_sealed_from_id, true);
  // The raw equality is still reported honestly — genesis does equal the
  // fallback anchor — but the status says that equality carries no witness
  // information, which is what the coverage_note promised all along.
  assert.equal(block.expect_matches, true);
  assert.ok(String(block.reason).includes("genesis constant"), "the reason names the trap input");
});

test("every legacy position answers the same for zeros: 1 and the last row below the boundary", async () => {
  const { env } = await seeded();
  for (const from of [1, 2]) {
    const block = identityBlock(await attest(env.DB, 0, { identityFrom: from, identityExpect: ZEROS }));
    assert.equal(block.status, "unsealed_anchor", `identity_from=${from}`);
    assert.equal(block.ok, false, `identity_from=${from}`);
  }
});

test("at sealed_from_id itself, zeros is an ordinary wrong hash: mismatch, as 1785's boundary row showed", async () => {
  const { env } = await seeded();
  const block = identityBlock(await attest(env.DB, 0, { identityFrom: 3, identityExpect: ZEROS }));
  assert.equal(block.status, "mismatch");
  assert.equal(block.ok, false);
  assert.equal(block.anchor_below_sealed_from_id, undefined, "at or above the boundary the flag does not apply");
});

test("a TRUE witness at a sealed row still verifies — the fix must not widen into the covered range", async () => {
  const { env, heads } = await seeded();
  const block = identityBlock(await attest(env.DB, 0, { identityFrom: 5, identityExpect: heads[5] }));
  assert.equal(block.status, "verified");
  assert.equal(block.ok, true);
  assert.equal(block.expect_matches, true);
});

test("the no-id head witness is untouched: a true head at from=0 verifies, a wrong one mismatches", async () => {
  const { env, heads } = await seeded();
  const good = identityBlock(await attest(env.DB, 0, { identityExpect: heads[5] }));
  assert.equal(good.status, "verified");
  assert.equal(good.expect_matches, true);
  const bad = identityBlock(await attest(env.DB, 0, { identityExpect: DEADBEEF }));
  assert.equal(bad.status, "mismatch");
});
