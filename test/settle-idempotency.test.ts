// The money path's two guarantees, tested at the seam where they can break.
//
// 1. A UNIQUE violation on the chain columns is a race worth retrying; a
//    UNIQUE violation on anything else means the row is already recorded and
//    retrying is how a settled payment gets reported as a chain failure
//    (Sirpixelalittle, #33). appendChained must tell them apart.
// 2. The lowercase fold on tx, without which 0xAB… and 0xab… are two rows for
//    one on-chain payment (#32).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appendChained, DuplicateRowError } from "../src/chain.ts";

const ROOT = join(import.meta.dirname, "..");

// A D1-shaped stub whose INSERT throws the SQLite message we choose.
function dbThrowing(message: string, opts: { headHash?: string | null } = {}) {
  let inserts = 0;
  return {
    inserts: () => inserts,
    prepare(sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            async first() {
              return opts.headHash === undefined ? null : { hash: opts.headHash };
            },
            async run() {
              if (/^INSERT/i.test(sql.trim())) {
                inserts++;
                throw new Error(message);
              }
              return { meta: { changes: 1 } };
            },
          };
        },
        async first() {
          return opts.headHash === undefined ? null : { hash: opts.headHash };
        },
      };
    },
  } as unknown as D1Database & { inserts: () => number };
}

const row = {
  entry_date: "2026-08-10",
  description: "patron 0xabc — tx 0xdef — inscription \"hello\"",
  amount_cents: 100,
  created_at: 1786360000000,
  tx: "0x" + "a".repeat(64),
  source: "patron",
};

test("a duplicate tx is reported as already-recorded, not retried", async () => {
  const db = dbThrowing("D1_ERROR: UNIQUE constraint failed: ledger.tx");
  await assert.rejects(
    () => appendChained(db, "ledger", row),
    (e: unknown) => {
      assert.ok(e instanceof DuplicateRowError, `expected DuplicateRowError, got ${e}`);
      return true;
    },
  );
  // The critical property: it gave up immediately instead of burning the
  // retry budget on a write that can never succeed.
  assert.equal(db.inserts(), 1, "a permanent duplicate must not be retried");
});

test("a moved chain head is still retried, four times, then surfaced as a race", async () => {
  const db = dbThrowing("D1_ERROR: UNIQUE constraint failed: ledger.prev_hash");
  await assert.rejects(
    () => appendChained(db, "ledger", row),
    (e: unknown) => {
      assert.ok(!(e instanceof DuplicateRowError), "a head race must not be reported as a duplicate");
      assert.match(String(e), /moved four times/);
      return true;
    },
  );
  assert.equal(db.inserts(), 4, "the head race is the case retrying exists for");
});

test("an unrecognised UNIQUE violation is treated as permanent, not retried", async () => {
  // Retrying a write that may already have succeeded is the dangerous
  // direction, so an unfamiliar constraint fails closed.
  const db = dbThrowing("D1_ERROR: UNIQUE constraint failed: something_new");
  await assert.rejects(() => appendChained(db, "ledger", row), DuplicateRowError);
  assert.equal(db.inserts(), 1);
});

test("a non-UNIQUE error is never swallowed by the retry loop", async () => {
  const db = dbThrowing("D1_ERROR: no such table: ledger");
  await assert.rejects(() => appendChained(db, "ledger", row), /no such table/);
  assert.equal(db.inserts(), 1);
});

test("the ledger's tx uniqueness is enforced case-insensitively", () => {
  const schema = readFileSync(join(ROOT, "schema.sql"), "utf8");
  assert.match(
    schema,
    /CREATE UNIQUE INDEX[^\n]*ON ledger\(lower\(tx\)\)/,
    "a byte-wise unique index lets one on-chain payment be booked twice under two spellings",
  );
  assert.doesNotMatch(schema, /CREATE UNIQUE INDEX[^\n]*ON ledger\(tx\)/);
});

test("settlement writes its claim before taking money, and folds the tx", () => {
  const src = readFileSync(join(ROOT, "src", "x402.ts"), "utf8");
  const claimAt = src.indexOf("INSERT OR IGNORE INTO settle_attempts");
  const settleAt = src.indexOf('facilitator("/settle"');
  assert.ok(claimAt > 0, "the durable claim must exist");
  assert.ok(settleAt > 0);
  assert.ok(
    claimAt < settleAt,
    "the claim must be written BEFORE settlement: after it, a crash loses the money silently",
  );
  assert.match(src, /settlement\.transaction[^\n]*toLowerCase\(\)/, "tx must be folded before it is stored or compared");
  assert.doesNotMatch(
    src,
    /\/verify.*\n?.*Your money was not taken[\s\S]{0,200}\/settle/,
    "the not-taken promise must not be shared with the settle path",
  );
});
