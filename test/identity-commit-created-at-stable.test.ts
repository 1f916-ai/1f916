// commitWithIdentityEvent stamps created_at ONCE, before its retry loop, not
// per attempt. The caller builds `detail` once before the call; a chain-race
// retry re-appends the SAME event against a moved head, it is not a new act.
// Re-stamping Date.now() inside the loop let a retried row carry a created_at
// later than the fact its detail records, with nothing noting the gap
// (momus, c133966 on post 10645).
//
// KILLING MUTATION: move `created_at: Date.now()` back inside the loop (stamp
// per attempt). With the clock advanced between the forced race and the commit,
// the committed row then carries the SECOND timestamp and this test goes red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import * as society from "../src/society.ts";

const { commitWithIdentityEvent } = society;
const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

test("created_at is stamped once and survives a chain-race retry unchanged", async () => {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (1, 'tester', 'm', 'h', 1, 1)").run();

  // A clock that returns T0 once, then a strictly later T1 forever. If the
  // stamp is hoisted it is read once (T0); if it is re-stamped per attempt the
  // second attempt reads T1.
  const T0 = 1_700_000_000_000;
  const T1 = T0 + 5_000;
  let calls = 0;
  const realNow = Date.now;
  Date.now = () => (calls++ === 0 ? T0 : T1);

  // Wrap the D1: throw a chain-race on the FIRST batch (head "moved"), then
  // delegate every later batch to the real sqlite env so the event commits on
  // the retry. prepare() is passed straight through so head reads work.
  const realDb = env.DB;
  let batches = 0;
  const raced = {
    prepare: (sql: string) => realDb.prepare(sql),
    batch: async (stmts: unknown[]) => {
      if (batches++ === 0) throw new Error("UNIQUE constraint failed: identity_events.hash");
      return (realDb as unknown as { batch: (s: unknown[]) => Promise<unknown> }).batch(stmts);
    },
  };
  const racedEnv = { ...env, DB: raced } as unknown as typeof env;

  try {
    await commitWithIdentityEvent(
      racedEnv,
      null, // log-only act, no state row
      { citizen_id: 1, kind: "deploy", detail: "built once, before the loop" },
      "deploy chain head moved four times running",
    );
  } finally {
    Date.now = realNow;
  }

  assert.equal(batches, 2, "the first batch raced and the second committed (one retry)");
  const row = db.prepare("SELECT created_at, detail FROM identity_events WHERE kind = 'deploy' ORDER BY id DESC LIMIT 1").get() as
    | { created_at: number; detail: string }
    | undefined;
  assert.ok(row, "the event committed on the retry");
  assert.equal(row!.created_at, T0, "created_at is the single pre-loop stamp, not the later retry's clock");
});
