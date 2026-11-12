// /api/proof's checkpoint.tree_size is the size of the EARLIEST checkpoint
// covering the one event asked about, so for an interior event it is far
// smaller than the chain is now — a reader who takes it for the chain's current
// length is wrong, and the number cannot signal that for itself. egress (#9868,
// building on holdfast #8671) measured event=20000 -> tree_size 19986 while the
// newest identity_events checkpoint was 29609. inclusion() now carries a served
// tree_size_note saying what the number is and pointing at sealed_entries_total
// for the true length.
//
// Killing mutation: delete the tree_size_note line in inclusion() and the
// "present and non-empty" assertion goes red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inclusion } from "../src/checkpoint.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const hex = (n: number) => n.toString(16).padStart(64, "0");

function fixture() {
  const { env, db } = sqliteTestEnv(schema);
  db.exec("INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (1, 'c', 'm', 'h', 0, 0)");
  // Ten sealed rows, distinct hashes, so leaf_index == id-1.
  for (let id = 1; id <= 10; id++) {
    db.prepare("INSERT INTO identity_events (id, citizen_id, kind, detail, created_at, prev_hash, hash) VALUES (?, 1, 'k', 'd', ?, ?, ?)")
      .run(id, id, id === 1 ? null : hex(id - 1), hex(id));
  }
  // Three signed checkpoints at growing sizes; roots/sigs are arbitrary here
  // (inclusion() folds the leaf set, it does not re-verify the stored root).
  for (const size of [3, 7, 10]) {
    db.prepare("INSERT INTO checkpoints (log, tree_size, root, sig, created_at) VALUES ('identity_events', ?, ?, 's', 1)").run(size, hex(1000 + size));
  }
  return { env, db };
}

test("checkpoint.tree_size is the earliest covering checkpoint, and a served note says it is not the chain length", async (t) => {
  const { env, db } = fixture();
  t.after(() => db.close());

  // Interior event (id 2, leaf_index 1): earliest checkpoint with tree_size >= 2 is 3.
  const interior = await inclusion(env, "identity_events", 2) as { checkpoint: { tree_size: number }; event: { leaf_index: number }; tree_size_note?: unknown };
  assert.equal(interior.event.leaf_index, 1);
  assert.equal(interior.checkpoint.tree_size, 3, "earliest checkpoint covering leaf 1");

  // A later event (id 9, leaf_index 8): earliest checkpoint with tree_size >= 9 is 10.
  const recent = await inclusion(env, "identity_events", 9) as { checkpoint: { tree_size: number } };
  assert.equal(recent.checkpoint.tree_size, 10, "earliest checkpoint covering leaf 8");

  // Leaf-local: the SAME route hands a different tree_size per event, so it is
  // not the chain's current length (10 here); the interior event reads 3.
  assert.notEqual(interior.checkpoint.tree_size, recent.checkpoint.tree_size);
  assert.ok(interior.checkpoint.tree_size < recent.checkpoint.tree_size);

  // The note is served and non-empty, and names the true-length field.
  assert.equal(typeof interior.tree_size_note, "string");
  assert.ok((interior.tree_size_note as string).length > 0, "tree_size_note present and non-empty");
  assert.match(interior.tree_size_note as string, /sealed_entries_total/, "points at the true-length field");
});
