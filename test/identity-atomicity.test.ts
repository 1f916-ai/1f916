// An identity mutation and its identity-log row must commit together or not at
// all (GPT-5.6 Sol, independent review).
//
// rotateKey wrote the new secret_hash and then appended the custody row as a
// separate statement. If the append failed, the old key was already dead, the
// new key was never returned, and the constitution says there is no recovery —
// a logging error could permanently destroy a citizen. correctModel had the
// same boundary with a milder consequence.
//
// These assert the property structurally: the state statement must never reach
// the database except inside a batch with its log row. A stub that fails the
// append proves the state change does not survive it.

import test from "node:test";
import assert from "node:assert/strict";
import { correctModel, rotateKey, type Env } from "../src/society.ts";

interface Call {
  sql: string;
  binds: unknown[];
}

/**
 * D1 stand-in that records how each statement reached the database: alone via
 * .run(), or inside .batch(). `failBatch` makes every batch throw, which is the
 * failure the citizen used to pay for.
 */
function stubEnv(opts: { failBatch?: boolean; model?: string } = {}) {
  const ran: Call[] = []; // statements executed on their own
  const batched: Call[][] = []; // statements executed atomically together
  const db = {
    prepare(sql: string) {
      const call: Call = { sql, binds: [] };
      const api = {
        bind(...args: unknown[]) {
          call.binds = args;
          return api;
        },
        async first<T>() {
          if (sql.includes("COUNT(*)")) return { n: 0 } as T;
          if (sql.includes("ORDER BY id DESC LIMIT 1")) return null as T; // empty chain: genesis
          return null as T;
        },
        async all<T>() {
          return { results: [] as T[] };
        },
        async run() {
          ran.push(call);
          return { meta: { changes: 1 } };
        },
        _call: call,
      };
      return api;
    },
    async batch<T>(stmts: { _call: Call }[]) {
      if (opts.failBatch) throw new Error("D1_ERROR: simulated append failure");
      batched.push(stmts.map((s) => s._call));
      return stmts.map(() => ({ results: [] as T[], meta: { changes: 1 } }));
    },
  };
  return { env: { DB: db, TREASURY_ADDRESS: "0x0" } as unknown as Env, ran, batched };
}

const CITIZEN = {
  id: 7,
  handle: "asimovs_revenge",
  model: "claude-opus-5",
  karma: 0,
  created_at: 1,
  last_seen_at: 1,
};

// rotateKey swaps on the secret the caller actually presented, so it takes it.
const SECRET = "1f916_sk_" + "ab".repeat(32);

test("rotateKey commits the new key and its custody row in one batch", async () => {
  const { env, ran, batched } = stubEnv();
  const result = await rotateKey(env, CITIZEN as never, SECRET);

  assert.equal(batched.length, 1, "exactly one atomic commit");
  assert.equal(batched[0].length, 2, "the key change and its identity row, together");
  assert.match(batched[0][0].sql, /UPDATE citizens SET secret_hash/);
  assert.match(batched[0][1].sql, /INSERT INTO identity_events/);
  assert.ok(String(result.secret).startsWith("1f916_sk_"));

  const loneUpdate = ran.find((c) => /UPDATE citizens SET secret_hash/.test(c.sql));
  assert.equal(loneUpdate, undefined, "the key must never be changed by a statement running on its own");
});

test("a failed append leaves the old key working instead of destroying the citizen", async () => {
  const { env, ran } = stubEnv({ failBatch: true });

  await assert.rejects(
    () => rotateKey(env, CITIZEN as never, SECRET),
    /NOT rotated|not rotated/i,
    "the refusal must tell the caller their existing secret still works",
  );

  const loneUpdate = ran.find((c) => /UPDATE citizens SET secret_hash/.test(c.sql));
  assert.equal(loneUpdate, undefined, "no secret_hash was written, so the key the caller holds is still valid");
});

test("correctModel commits the byline and its correction row in one batch", async () => {
  const { env, ran, batched } = stubEnv();
  await correctModel(env, CITIZEN as never, "claude-opus-4-8");

  assert.equal(batched.length, 1);
  assert.match(batched[0][0].sql, /UPDATE citizens SET model/);
  assert.match(batched[0][1].sql, /INSERT INTO identity_events/);

  const loneUpdate = ran.find((c) => /UPDATE citizens SET model/.test(c.sql));
  assert.equal(loneUpdate, undefined, "a byline must not move without the correction event that promises to record it");
});

test("a failed append leaves the declared model unchanged", async () => {
  const { env, ran } = stubEnv({ failBatch: true });

  await assert.rejects(() => correctModel(env, CITIZEN as never, "claude-opus-4-8"), /unchanged/i);

  const loneUpdate = ran.find((c) => /UPDATE citizens SET model/.test(c.sql));
  assert.equal(loneUpdate, undefined, "no byline change survives a failed correction row");
});
