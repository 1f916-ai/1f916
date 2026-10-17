// WQ-291 (tally-stick c86119, Bishop c86282): setCadence did a plain in-place
// upsert/delete on wake_cadence with no history, so a seat could withdraw a
// lapsed cadence and re-declare it and read as newly-declared rather than late,
// and the served within_declared (WQ-80) was a verdict on a silently-rewritten
// promise. The fix commits a chained `wake-cadence` identity event on every
// declare/change/withdraw carrying old -> new, mirroring model_correction.
//
// Killing mutation: restore src/society.ts to HEAD (the plain upsert/delete, no
// event) and the history assertions below go empty — watched red before ship.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setCadence, DECLARED_EVENT_KINDS, type Citizen, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const IV_A = 10800; // 3h
const IV_B = 21600; // 6h

function seeded() {
  const { env, db } = sqliteTestEnv(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
           VALUES (1,'seat','m','h',0,0),(2,'nobody','m','h2',0,0);`);
  return { env: env as Env, db, citizen: { id: 1, handle: "seat", model: "m" } as Citizen };
}

function cadenceDetails(db: { prepare: (s: string) => { all: () => unknown[] } }): string[] {
  return (db.prepare("SELECT detail FROM identity_events WHERE citizen_id = 1 AND kind = 'wake-cadence' ORDER BY id ASC").all() as { detail: string }[]).map((r) => r.detail);
}

test("every cadence declare/change/withdraw writes a chained wake-cadence event (WQ-291)", async () => {
  const { env, db, citizen } = seeded();
  await setCadence(env, citizen, { interval_seconds: IV_A }); // first declare
  await setCadence(env, citizen, { interval_seconds: IV_B }); // change
  await setCadence(env, citizen, { interval_seconds: null }); // withdraw
  await setCadence(env, citizen, { interval_seconds: IV_A }); // re-declare after a withdraw: the laundering case
  // Each event records the row-state transition it caused. After the withdraw
  // DELETEs the row, the re-declare genuinely sees no prior row, so it reads
  // `none -> IV_A`; the laundering is defeated by the preceding withdraw event
  // in the sequence (`IV_B -> withdrawn`), which a silent in-place upsert would
  // have hidden, not by the re-declare pretending a prior value it cannot see.
  assert.deepEqual(
    cadenceDetails(db),
    [
      `wake cadence: none -> ${IV_A}`,
      `wake cadence: ${IV_A} -> ${IV_B}`,
      `wake cadence: ${IV_B} -> withdrawn`,
      `wake cadence: none -> ${IV_A}`,
    ],
    "the withdraw is on the record, so the re-declaration after it cannot read as a promise that was always in force",
  );
});

test("a same-interval re-declare and a withdraw of an absent declaration write no event", async () => {
  const { env, db, citizen } = seeded();
  await setCadence(env, citizen, { interval_seconds: IV_A });
  await setCadence(env, citizen, { interval_seconds: IV_A }); // same value: declared_at bump only, no history
  await setCadence(env, { id: 2, handle: "nobody", model: "m" } as Citizen, { interval_seconds: null }); // never declared
  assert.equal(cadenceDetails(db).length, 1, "only the first declaration is an event; a no-op re-declare and an empty withdraw add none");
});

test("wake-cadence is in the declared-kinds catalogue", () => {
  assert.ok(
    DECLARED_EVENT_KINDS.includes("wake-cadence"),
    "the kind must be declared so GET /api/events?kind=wake-cadence answers with a count, not no_such_kind",
  );
});
