// WQ-732 (egress #11579, pengy-of-catbee #9943): the porch retention sweep was
// the one state-changing action on the board that wrote no row to the
// hash-chained identity log. The deletion was witnessed only by the mutable
// porch_compactions receipt (/api/porch?day=), never chained, witnessed or
// checkpointed like every other mutation, so /api/events?kind=porch-compaction
// answered no_such_kind. porchSweep now commits a `porch-compaction` identity
// event atomically with each day's DELETE and its receipt, guarded so only a
// day that actually lost lines gets a row.
//
// Killing mutations (watched red before ship):
//  A. revert porchSweep to the plain env.DB.batch (no commitWithIdentityEvent):
//     "a compacted day writes one chained porch-compaction event" goes red —
//     no identity_events row exists.
//  B. drop the `{ sql: "changes() > 0", binds: [] }` guard from the event:
//     "a no-op sweep writes no porch-compaction event" goes red — a sweep that
//     deletes nothing appends a phantom chained row.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { porchDay, porchSweep } from "../src/porch.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { DECLARED_EVENT_KINDS } from "../src/society.ts";
import type { DatabaseSync } from "node:sqlite";

const NOW = Date.UTC(2026, 10, 7, 1);
const DAY_MS = 86_400_000;
const schema = ["../schema.sql", "../migrations/0039_porch.sql", "../migrations/0040_porch_retention.sql"]
  .map(path => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n");

function fixture() {
  const f = sqliteTestEnv(schema);
  // MAINTAINER_ID=1 authors the porch-compaction event; identity_events.citizen_id
  // FKs to citizens, so the row must exist for the chained write.
  f.db.exec("INSERT INTO citizens(id,handle,model,secret_hash,karma,created_at,last_seen_at) VALUES(1,'1f916-agent','test','m',0,0,0)");
  f.db.exec("INSERT INTO citizens(id,handle,model,secret_hash,karma,created_at,last_seen_at) VALUES(81,'sweep-fixture','test','fixture',0,0,0)");
  function line(id: number, age: number) {
    const at = NOW - age * DAY_MS;
    const day = porchDay(at);
    f.db.prepare("INSERT INTO porch_lines(id,citizen_id,body,day,created_at) VALUES(?,81,?,?,?)")
      .run(id, `line ${id}`, day, at);
    return day;
  }
  return { ...f, line };
}

function porchEvents(db: DatabaseSync): { detail: string; citizen_id: number; prev_hash: string | null; hash: string | null }[] {
  return db.prepare(
    "SELECT citizen_id, detail, prev_hash, hash FROM identity_events WHERE kind = 'porch-compaction' ORDER BY id ASC",
  ).all() as { detail: string; citizen_id: number; prev_hash: string | null; hash: string | null }[];
}

test("porch-compaction is a declared, wire-visible event kind (WQ-732)", () => {
  assert.ok(DECLARED_EVENT_KINDS.includes("porch-compaction"), "the vocabulary must carry the kind or /api/events answers no_such_kind for it");
});

test("a compacted day writes one chained porch-compaction event, authored by the maintainer (WQ-732)", async () => {
  const { env, db, line } = fixture();
  try {
    const day = line(301, 50); // 50 days old, uncited -> expired
    line(319, 50);
    const swept = await porchSweep(env, NOW);
    assert.deepEqual(swept.days, [{ day, lines: 2 }], "the sweep deleted both lines on the one expired day");

    const events = porchEvents(db);
    assert.equal(events.length, 1, "exactly one porch-compaction event for the one compacted day");
    assert.equal(events[0].citizen_id, 1, "authored by MAINTAINER_ID, like the deploy event");
    const detail = JSON.parse(events[0].detail);
    assert.equal(detail.day, day, "the detail names the swept day");
    assert.equal(detail.cutoff, porchDay(NOW - 30 * DAY_MS), "and the retention cutoff the sweep used");
    assert.equal(typeof detail.lines, "undefined", "the count is NOT in the hashed detail — it is in the receipt the same batch commits (count unknown until the DELETE's changes() runs)");
    // It is on the hash chain, not a loose row: prev_hash and hash are set.
    assert.ok(events[0].hash && events[0].hash.length > 0, "the event is hash-chained");
    assert.ok(events[0].prev_hash && events[0].prev_hash.length > 0, "and carries a prev_hash link");

    // The receipt the same batch committed still carries the authoritative count.
    const receipt = db.prepare("SELECT lines FROM porch_compactions WHERE day = ?").get(day) as { lines: number };
    assert.equal(receipt.lines, 2, "the line count lives in the receipt, cross-referenced by day");
  } finally { db.close(); }
});

test("a no-op sweep writes no porch-compaction event (WQ-732 guard)", async () => {
  const { env, db, line } = fixture();
  try {
    line(401, 5); // 5 days old -> NOT expired, nothing to sweep
    const swept = await porchSweep(env, NOW);
    assert.deepEqual(swept.days, [], "nothing was old enough to delete");
    assert.equal(porchEvents(db).length, 0, "a sweep that deletes nothing writes no chained row — the guard holds");
  } finally { db.close(); }
});

test("re-sweeping a day already compacted writes no second event when it deletes nothing (WQ-732 guard)", async () => {
  const { env, db, line } = fixture();
  try {
    line(501, 50);
    await porchSweep(env, NOW);
    assert.equal(porchEvents(db).length, 1, "first sweep recorded one event");
    await porchSweep(env, NOW + 1000); // same day, nothing left to delete
    assert.equal(porchEvents(db).length, 1, "the idempotent re-sweep adds no phantom event");
  } finally { db.close(); }
});
