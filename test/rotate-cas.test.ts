// Compare-and-swap on identity mutation (GPT-5.6 Sol, independent review).
//
// Two /api/rotate calls can authenticate on the same old key. Unguarded, both
// ran an unconditional UPDATE and both returned a secret; only the last write
// survived, so one caller walked away holding a value the response had just
// called its entire identity, already dead.
//
// The fix has to guard BOTH statements. A D1 batch is atomic, but a statement
// matching zero rows is not an error — so a guarded UPDATE paired with an
// unguarded chained INSERT commits, changes nothing, and writes into the sealed
// log that a rotation happened. A false row in a tamper-evident chain is worse
// than the race. These assert that the guard reaches the insert.

import test from "node:test";
import assert from "node:assert/strict";
import { appendChainedStmt, entryHash, GENESIS } from "../src/chain.ts";
import { correctModel, rotateKey, type Env } from "../src/society.ts";

interface Call {
  sql: string;
  binds: unknown[];
}

function stubEnv(opts: { changes?: number } = {}) {
  const batched: Call[][] = [];
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
          return null as T; // empty chain: genesis
        },
        async all<T>() {
          return { results: [] as T[] };
        },
        async run() {
          return { meta: { changes: 1 } };
        },
        _call: call,
      };
      return api;
    },
    async batch<T>(stmts: { _call: Call }[]) {
      batched.push(stmts.map((s) => s._call));
      return stmts.map(() => ({ results: [] as T[], meta: { changes: opts.changes ?? 1 } }));
    },
  };
  return { env: { DB: db, TREASURY_ADDRESS: "0x0" } as unknown as Env, batched };
}

const CITIZEN = { id: 7, handle: "asimovs_revenge", model: "claude-opus-5", karma: 0, created_at: 1, last_seen_at: 1 };
const SECRET = "1f916_sk_" + "ab".repeat(32);

test("the guard reaches the chained insert, not just the state statement", async () => {
  const { env, batched } = stubEnv();
  await rotateKey(env, CITIZEN as never, SECRET);

  const [update, insert] = batched[0];
  assert.match(update.sql, /AND secret_hash = \?/, "the swap is conditional on the key being replaced");
  assert.match(insert.sql, /WHERE .*secret_hash/, "and so is the row that records it");
  assert.doesNotMatch(insert.sql, /VALUES/, "a guarded insert cannot use the unconditional VALUES form");
});

test("losing the race changes nothing and records nothing", async () => {
  // changes: 0 is what a CAS looks like when another rotation got there first.
  const { env, batched } = stubEnv({ changes: 0 });

  await assert.rejects(
    () => rotateKey(env, CITIZEN as never, SECRET),
    /no key was changed and no custody row was written/,
    "the caller must be told which of the two secrets is live",
  );
  assert.equal(batched.length, 1, "one batch was attempted");
});

test("correctModel puts its daily cap inside the write, on both statements", async () => {
  const { env, batched } = stubEnv();
  await correctModel(env, CITIZEN as never, "claude-opus-4-8");

  const [update, insert] = batched[0];
  assert.match(update.sql, /COUNT\(\*\).*model_correction/s, "counting before the update is a check two requests pass together");
  assert.match(insert.sql, /WHERE .*COUNT\(\*\)/s, "the correction row is written under the same condition");
});

test("a model correction that loses the race is refused, not silently dropped", async () => {
  const { env } = stubEnv({ changes: 0 });
  await assert.rejects(() => correctModel(env, CITIZEN as never, "claude-opus-4-8"), /changed nothing and logged nothing/);
});

// The property that makes the guard safe to put in the hash path at all.
test("a guard changes whether the row is written, never what is hashed", async () => {
  const { env } = stubEnv();
  const row = { citizen_id: 7, kind: "key_rotation", detail: "custody changed", created_at: 1234 };

  const plain = await appendChainedStmt(env.DB as never, "identity_events", row);
  const guarded = await appendChainedStmt(env.DB as never, "identity_events", row, {
    sql: "(SELECT secret_hash FROM citizens WHERE id = ?) = ?",
    binds: [7, "deadbeef"],
  });

  assert.equal(plain.hash, guarded.hash, "the preimage is computed before the branch and must not depend on it");
  assert.equal(plain.hash, await entryHash("identity_events", GENESIS, row));
  assert.equal(plain.prev_hash, guarded.prev_hash);
});
