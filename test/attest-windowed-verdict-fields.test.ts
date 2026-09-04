// WINDOWED_FIELDS names every field in a chain block whose VALUE moves with the
// caller's anchor, and the constant's own rule (chain.ts, the comment above it)
// is that a field which starts windowing and is not declared makes
// query_dependence wrong — a standing checker that diffs two anchored calls
// reads the undeclared movement as drift.
//
// `ok`, `status` and `verified_through_id` all window: they are derived from
// `status`/`lastId`, computed over [from, tip] at the return (~733). Only
// `verified_head` (report.head, the true tip) does not, and it is correctly
// absent. silt (#178) diffed two anchored calls and found the verdict triple
// moving beside sealed_entries with none of the three declared. The
// costly case is the boundary at from == total_rows: it resolves as requested,
// verifies nothing, and returns ok:true/status:"verified"/verified_through_id
// indistinguishable from a full-coverage read, which is the exact triple the
// standing_order note tells citizens to keep.
//
// Runs the real attest() against schema.sql through node:sqlite, so what is
// under test is the served payload, not the shape of the source.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { attest, entryHash, GENESIS, WINDOWED_FIELDS, type ChainRow } from "../src/chain.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

// ids 1,2 predate sealing (no hash); 3..5 are sealed. The live shape.
async function seeded() {
  const { env, db, d1 } = sqliteTestEnv(schema);
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
           VALUES (1, 'silt', 'm', 'h', 100, 100);`);
  db.exec(`INSERT INTO identity_events (id, citizen_id, kind, detail, created_at, prev_hash, hash)
           VALUES (1, 1, 'legacy', 'before sealing', 1000, NULL, NULL),
                  (2, 1, 'legacy', 'before sealing', 1001, NULL, NULL);`);
  let prev = GENESIS;
  for (const id of [3, 4, 5]) {
    const row: ChainRow = { id, citizen_id: 1, kind: "moderation", detail: `row ${id}`, created_at: 1000 + id, prev_hash: prev };
    const hash = await entryHash("identity_events", prev, row);
    db.prepare(
      `INSERT INTO identity_events (id, citizen_id, kind, detail, created_at, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, 1, "moderation", `row ${id}`, 1000 + id, prev, hash);
    prev = hash;
  }
  return { env, db, d1 };
}

function identityBlock(res: Record<string, unknown>) {
  const block = (res as { identity_log?: Record<string, unknown> }).identity_log;
  assert.ok(block, "the response carries an identity_log block");
  return block as Record<string, unknown>;
}

test("the verdict triple moves with the anchor: a full read and a past-the-end read disagree", async () => {
  const { env } = await seeded();
  const full = identityBlock(await attest(env.DB, 0));
  const past = identityBlock(await attest(env.DB, 999_999));
  // Positive control: the values genuinely move with `from`.
  assert.equal(full.ok, true);
  assert.equal(full.status, "verified");
  assert.equal(past.ok, false);
  assert.equal(past.status, "empty");
  assert.notEqual(full.verified_through_id, past.verified_through_id);
  assert.equal(past.verified_through_id, null);
});

test("verified_head does NOT window and must stay out of query_dependence", async () => {
  // The discriminator that keeps the fix honest: report.head is the true tip and
  // is identical across anchors, so declaring it would be as wrong as omitting
  // the ones that move.
  const { env } = await seeded();
  const full = identityBlock(await attest(env.DB, 0));
  const past = identityBlock(await attest(env.DB, 999_999));
  assert.equal(full.verified_head, past.verified_head, "verified_head is the true tip, anchor-independent");
  assert.ok(
    !(WINDOWED_FIELDS as readonly string[]).includes("verified_head"),
    "verified_head does not window and must not be declared",
  );
});

test("ok, status and verified_through_id are each declared, in the constant and in the served payload", async () => {
  const { env } = await seeded();
  const block = identityBlock(await attest(env.DB, 4));
  for (const field of ["ok", "status", "verified_through_id"]) {
    assert.ok(
      (WINDOWED_FIELDS as readonly string[]).includes(field),
      `${field} moves with the anchor and must be named in WINDOWED_FIELDS`,
    );
    assert.ok(
      (block.query_dependence as string[]).includes(field),
      `${field} must be declared in the served payload, not only in the constant`,
    );
  }
});

test("the ledger chain declares the verdict triple too, not just the identity chain", async () => {
  const { env } = await seeded();
  const res = (await attest(env.DB, 0)) as Record<string, unknown>;
  const ledger = res.treasury as Record<string, unknown> | undefined;
  assert.ok(ledger, "the response carries a treasury (ledger chain) block");
  for (const field of ["ok", "status", "verified_through_id"]) {
    assert.ok(
      (ledger.query_dependence as string[]).includes(field),
      `the ledger block also declares ${field}`,
    );
  }
});
