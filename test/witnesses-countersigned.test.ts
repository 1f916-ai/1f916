// The witness directory could not say who is behind: the Worker never fetches a
// witness file, and the GitHub scheduler skips most hourly slots, so a witness
// that countersigned yesterday looked identical to one that never ran. A
// witness now POSTs its row and the registry keeps the newest per log with a
// signed receipt. This pins what GET /api/witnesses derives from that: both
// logs null for a witness that never pushed; lag_s 0 when the pushed row is the
// log's newest checkpoint (a quiet log is not a dead witness); lag_s counted
// from the OLDEST later checkpoint, not the newest; stale_key after a rotation.
//
// Killing mutations: key lag_s off the newest later checkpoint, drop the
// stale_key comparison, or read the receipts once per row instead of once per
// page and the matching test goes red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { listWitnesses } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const NOW = 1_800_000_000_000;
const ROOT = "a".repeat(64);
const SIG = "b".repeat(86);

function fixture() {
  const { env, db } = sqliteTestEnv(schema);
  db.exec("INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (1, 'owner', 'test', 'h1', 0, 0)");
  db.exec(
    "INSERT INTO witnesses (id, citizen_id, name, url, public_key, epoch, key_set_at, added_at) VALUES " +
      "(1, 1, 'w1', 'https://example.test/w1/', NULL, 0, 0, 0), (2, 1, 'w2', 'https://example.test/w2/', NULL, 1, 0, 0)",
  );
  return { env, db };
}

function checkpoint(db: DatabaseSync, id: number, log: string, treeSize: number, createdAt: number) {
  db.prepare("INSERT INTO checkpoints (id, log, tree_size, root, sig, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, log, treeSize, ROOT, SIG, createdAt);
}

// The newest accepted row for (witness, log), as the push route stores it.
function pushed(db: DatabaseSync, witnessId: number, log: string, treeSize: number, checkpointId: number, epoch: number) {
  db.prepare(
    "INSERT INTO witness_countersignatures (witness_id, log, tree_size, root, witness_sig, witness_epoch, checkpoint_id, received_at, receipt_payload, receipt_sig) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(witnessId, log, treeSize, ROOT, SIG, epoch, checkpointId, NOW - 1000, `payload-${witnessId}-${log}`, SIG);
}

test("a witness that never pushed serves null for both logs", async (t) => {
  const { env, db } = fixture();
  t.after(() => db.close());
  checkpoint(db, 1, "identity_events", 5, NOW - 500_000);
  const w: any = await listWitnesses(env, NOW);
  assert.equal(w.witnesses.length, 2);
  for (const row of w.witnesses) assert.deepEqual(row.countersigned, { identity_events: null, ledger: null });
  assert.match(w.countersigned_note, /lag_s/);
  assert.match(w.countersigned_note, /GET \/api\/checkpoint/);
  assert.match(w.countersigned_note, /received_at/);
});

test("a pushed row on a quiet log has lag_s 0 and carries its receipt", async (t) => {
  const { env, db } = fixture();
  t.after(() => db.close());
  checkpoint(db, 1, "identity_events", 5, NOW - 500_000);
  pushed(db, 1, "identity_events", 5, 1, 0);
  const w: any = await listWitnesses(env, NOW);
  const mine = w.witnesses.find((r: any) => r.id === 1).countersigned;
  assert.equal(mine.identity_events.tree_size, 5);
  assert.equal(mine.identity_events.root, ROOT);
  assert.equal(mine.identity_events.lag_s, 0, "no later checkpoint: a quiet log is not a dead witness");
  assert.equal(mine.identity_events.receipt.payload, "payload-1-identity_events");
  assert.equal(mine.identity_events.stale_key, undefined);
  assert.equal(mine.ledger, null, "the other log was never pushed");
  const other = w.witnesses.find((r: any) => r.id === 2).countersigned;
  assert.deepEqual(other, { identity_events: null, ledger: null }, "one witness's push does not label another");
});

test("lag_s counts from the oldest checkpoint after the pushed row, not the newest", async (t) => {
  const { env, db } = fixture();
  t.after(() => db.close());
  checkpoint(db, 1, "identity_events", 5, NOW - 500_000);
  checkpoint(db, 2, "identity_events", 6, NOW - 90_500);
  checkpoint(db, 3, "identity_events", 7, NOW - 10_000);
  checkpoint(db, 4, "ledger", 9, NOW - 400_000);
  pushed(db, 1, "identity_events", 5, 1, 0);
  const w: any = await listWitnesses(env, NOW);
  const mine = w.witnesses.find((r: any) => r.id === 1).countersigned;
  assert.equal(mine.identity_events.lag_s, 90, "floor((NOW - created_at of tree_size 6) / 1000), not the age of tree_size 7");
  assert.equal(mine.ledger, null, "a checkpoint on the ledger log does not label an unpushed log");
});

test("a row pushed under an earlier key epoch is served with stale_key: true", async (t) => {
  const { env, db } = fixture();
  t.after(() => db.close());
  checkpoint(db, 1, "ledger", 9, NOW - 400_000);
  pushed(db, 2, "ledger", 9, 1, 0);
  const w: any = await listWitnesses(env, NOW);
  const row = w.witnesses.find((r: any) => r.id === 2);
  assert.equal(row.epoch, 1);
  assert.equal(row.countersigned.ledger.witness_epoch, 0);
  assert.equal(row.countersigned.ledger.stale_key, true);
});
