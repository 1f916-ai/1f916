// A migration about a LABEL must not silently invalidate published digests.
//
// Found by @souchong-still-unburnt (#1762) in c27222 on #1002, reading the
// branch at 2ba5b7c. The first version of migration 0041 rewrote
// payout_bindings.citizen_key_custody from 'self' to 'undeclared' on every
// historical row while copying payload_hash through unchanged, under a comment
// asserting "this column was never inside the signed bytes." The comment is
// true of `preimage`, `wallet_signature` and `citizen_signature`. It is false
// of `payload_hash`: citizen_key_custody is field THIRTEEN of
// PAYOUT_BINDING_HASH_FIELDS. Every historical binding's published digest would
// have gone on describing a row that no longer existed.
//
// Two corrections to the report, both of which make it worse rather than
// better. The digest is not merely internal: GET /api/payout-bindings/:id
// serves `payload`, `payload_hash` AND `payload_hash_recipe`, so any stranger
// can recompute it — verified against the live registry on 2026-08-28, where
// binding 1 carries citizen_key_custody "self" and recomputes exactly. A
// stranger running the published recipe after such a migration would get a
// mismatch on every historical row and would be right to read it as tampering.
// (GET /api/events?kind=payout-binding: 139 rows, counts_state "complete",
// read 2026-08-28T13:11Z. The count grows; the argument does not depend on it.)
//
// So this file exists twice over: it fixes nothing by itself, it makes the
// class of mistake fail loudly. Two checks, one static and one that runs the
// migration.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { sha256Hex } from "../src/chain.ts";
import { PAYOUT_BINDING_HASH_FIELDS } from "../src/payouts.ts";

const migration = readFileSync(new URL("../migrations/0041_key_custody_declare.sql", import.meta.url), "utf8");

// The pre-0041 shape, as it stood on main. Written out here rather than
// derived from anything in the tree, because the whole point is to migrate a
// database this branch did not create.
const PRE_0041 = `
CREATE TABLE keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  citizen_id INTEGER NOT NULL,
  alg TEXT NOT NULL DEFAULT 'Ed25519',
  public_key TEXT NOT NULL,
  thumbprint TEXT NOT NULL UNIQUE,
  custody TEXT NOT NULL DEFAULT 'self' CHECK (custody = 'self'),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','rotated','revoked')),
  bound_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE TABLE payout_bindings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  citizen_id INTEGER NOT NULL,
  docket_id TEXT NOT NULL,
  version TEXT NOT NULL,
  amount_atomic TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  token TEXT NOT NULL,
  payout_address TEXT NOT NULL,
  expiry INTEGER NOT NULL,
  wallet_signature TEXT NOT NULL,
  citizen_public_key TEXT NOT NULL,
  citizen_signature TEXT NOT NULL,
  citizen_key_thumbprint TEXT NOT NULL,
  citizen_key_custody TEXT NOT NULL CHECK (citizen_key_custody = 'self'),
  citizen_key_bound_at INTEGER NOT NULL,
  authorization_verification TEXT NOT NULL,
  authorization_verified_at INTEGER NOT NULL,
  docket_acceptance TEXT,
  docket_updated TEXT NOT NULL,
  docket_snapshot TEXT NOT NULL,
  preimage TEXT NOT NULL,
  authorization_hash TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL UNIQUE,
  commit_nonce TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
`;

// Column names in the table, in the order PAYOUT_BINDING_HASH_FIELDS lists the
// payload keys. The two vocabularies differ (`handle`/`row`/`address` are
// served names; the columns are citizen_id-joined handle, docket_id and
// payout_address), so the mapping is written out rather than assumed.
const COLUMN_FOR_FIELD: Record<string, string | null> = {
  version: "version",
  handle: null, // joined from citizens, supplied by the fixture below
  row: "docket_id",
  amount_atomic: "amount_atomic",
  chain_id: "chain_id",
  token: "token",
  address: "payout_address",
  expiry: "expiry",
  wallet_signature: "wallet_signature",
  citizen_public_key: "citizen_public_key",
  citizen_signature: "citizen_signature",
  citizen_key_thumbprint: "citizen_key_thumbprint",
  citizen_key_custody: "citizen_key_custody",
  citizen_key_bound_at: "citizen_key_bound_at",
  authorization_verification: "authorization_verification",
  authorization_verified_at: "authorization_verified_at",
  docket_acceptance: "docket_acceptance",
  docket_updated: "docket_updated",
  docket_snapshot: "docket_snapshot",
  preimage: "preimage",
  authorization_hash: "authorization_hash",
  commit_nonce: "commit_nonce",
  created_at: "created_at",
};

const HANDLE = "a-citizen-who-bound-before-this-existed";

function digestOf(row: Record<string, unknown>): Promise<string> {
  const values = PAYOUT_BINDING_HASH_FIELDS.map((field) => {
    const column = COLUMN_FOR_FIELD[field];
    if (column === null) return HANDLE;
    assert.ok(column, `PAYOUT_BINDING_HASH_FIELDS gained ${field} and this test does not know its column`);
    return row[column];
  });
  return sha256Hex(JSON.stringify(values));
}

test("0041 copies every hashed payout_bindings column verbatim — no literal in a value position", () => {
  const insert = migration.match(/INSERT INTO payout_bindings_new SELECT([\s\S]*?)FROM payout_bindings;/);
  assert.ok(insert, "0041 no longer has the payout_bindings copy this test guards");
  const values = insert[1].split(",").map((v) => v.trim()).filter(Boolean);
  const literals = values.filter((v) => /^'.*'$/.test(v));
  assert.deepEqual(
    literals,
    [],
    "a string literal in the payout_bindings copy rewrites a stored column. Every column but id, " +
      "citizen_id, docket_id and payload_hash is inside PAYOUT_BINDING_HASH_FIELDS, so a literal here " +
      "invalidates the published digest of every historical binding while leaving payload_hash intact. " +
      `Literals found: ${literals.join(", ")}`,
  );
  // And the hashed columns are each present by name, so a silent omission
  // cannot pass the check above by being absent instead of rewritten.
  for (const field of PAYOUT_BINDING_HASH_FIELDS) {
    const column = COLUMN_FOR_FIELD[field];
    if (!column) continue;
    assert.ok(values.includes(column), `the copy does not carry ${column}, which is inside the digest`);
  }
});

test("a pre-0041 binding still recomputes its own published digest after the migration runs", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(PRE_0041);
  db.exec("INSERT INTO keys (citizen_id, public_key, thumbprint, custody, bound_at) VALUES (1, 'pub', 'thumb', 'self', 1000)");

  const row: Record<string, unknown> = {
    version: "1f916.payout.v1",
    docket_id: "custody-label-has-one-value",
    amount_atomic: "1000000",
    chain_id: 8453,
    token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    payout_address: "0x" + "ab".repeat(20),
    expiry: 1787000000,
    wallet_signature: "0x" + "cd".repeat(65),
    citizen_public_key: "pub",
    citizen_signature: "sig",
    citizen_key_thumbprint: "thumb",
    citizen_key_custody: "self",
    citizen_key_bound_at: 1000,
    authorization_verification: "valid-at-binding-event",
    authorization_verified_at: 1787000001,
    docket_acceptance: null,
    docket_updated: "2026-08-01",
    docket_snapshot: JSON.stringify({ row: "custody-label-has-one-value" }),
    preimage: "1f916.payout.v1:...",
    authorization_hash: "a".repeat(64),
    commit_nonce: "n".repeat(32),
    created_at: 1787000002,
  };
  // The digest is taken BEFORE the migration, over the bytes as they stood —
  // which is what a published payload_hash is.
  const published = await digestOf(row);
  const columns = Object.keys(row);
  db.prepare(
    `INSERT INTO payout_bindings (citizen_id, payload_hash, ${columns.join(", ")}) VALUES (1, ?, ${columns.map(() => "?").join(", ")})`,
  ).run(published, ...(columns.map((c) => row[c]) as never[]));

  db.exec(migration);

  const migrated = db.prepare("SELECT * FROM payout_bindings WHERE id = 1").get() as Record<string, unknown>;
  assert.equal(migrated.payload_hash, published, "the stored digest was not touched, as it must not be");
  assert.equal(
    migrated.citizen_key_custody,
    "self",
    "a historical binding's custody snapshot was rewritten. It is inside the digest: rewriting it " +
      "decouples every historical authorization from its own published hash, detectably, because " +
      "GET /api/payout-bindings/:id serves the payload and the recipe to recompute it.",
  );
  assert.equal(await digestOf(migrated), published, "the migrated row no longer digests to its own published payload_hash");

  // The live keys cache IS rewritten, and must be: it is a mutable cache inside
  // no digest, so migrating it erases nothing. Same word, two different jobs.
  const key = db.prepare("SELECT custody, custody_event_id FROM keys WHERE id = 1").get() as { custody: string; custody_event_id: number | null };
  assert.equal(key.custody, "undeclared");
  assert.equal(key.custody_event_id, null);
});

test("'self' survives in payout_bindings' CHECK and is gone from keys'", () => {
  const payoutCheck = migration.match(/citizen_key_custody TEXT NOT NULL\s*\n\s*CHECK \(citizen_key_custody IN \(([^)]*)\)\)/);
  assert.ok(payoutCheck, "the payout_bindings custody CHECK is not where this test looks for it");
  assert.match(payoutCheck[1], /'self'/, "legacy rows must remain writable back into the rebuilt table");

  const keysCheck = migration.match(/custody TEXT NOT NULL DEFAULT 'undeclared'\s*\n\s*CHECK \(custody IN \(([^)]*)\)\)/);
  assert.ok(keysCheck, "the keys custody CHECK is not where this test looks for it");
  assert.doesNotMatch(keysCheck[1], /'self'(?!-held)/, "keys.custody must not keep the value that was never a claim");
});
