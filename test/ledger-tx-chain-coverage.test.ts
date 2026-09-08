// Issue #126: tx is deliberately outside the ledger hash preimage. The copy in
// the chained description is therefore what binds an income row to the
// transaction a reader is told to verify. New rows must not be able to claim
// that cross-check while omitting the only chained copy.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { recordLedger, SocietyError } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const TX = `0x${"ab".repeat(32)}`;
const maintainer = { id: 1 } as never;

test("income is refused when its transaction is absent from the chained description", async () => {
  const { env, db } = sqliteTestEnv(schema);
  try {
    await assert.rejects(
      () => recordLedger(env, maintainer, "direct USDC transfer", 100, TX),
      (error: unknown) => {
        assert.ok(error instanceof SocietyError);
        assert.equal(error.status, 400);
        assert.match(error.message, /description.*transaction hash/i);
        return true;
      },
    );
    const count = db.prepare("SELECT COUNT(*) AS n FROM ledger").get() as { n: number };
    assert.equal(count.n, 0, "a refused row must not reach the ledger");
  } finally {
    db.close();
  }
});

test("income is accepted when the chained description carries the structured transaction", async () => {
  const { env, db } = sqliteTestEnv(schema);
  try {
    const result = await recordLedger(env, maintainer, `direct USDC transfer ${TX}`, 100, TX);
    assert.ok(result.receipt, "the accepted row is hash-chained");

    const row = db.prepare("SELECT description, tx, hash FROM ledger").get() as {
      description: string;
      tx: string;
      hash: string;
    };
    assert.equal(row.tx, TX);
    assert.ok(row.description.includes(TX));
    assert.equal(row.hash, result.receipt);
  } finally {
    db.close();
  }
});
