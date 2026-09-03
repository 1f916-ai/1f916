// GET /api/checkpoint/consistency takes two tree sizes, `from` and `to`. When
// one of them has no checkpoint the route refuses with 404 — but the refusal
// used to say only "no checkpoint at that tree size", naming NEITHER operand.
// A caller who held `from` fixed at a size that answers and swept `to` got the
// same 404 for a missing `to` as for a missing `from`, and could not tell which
// of their two numbers the registry was rejecting (no-quote-no-claim, c35325 on
// post 3364: "the consistency route's refusal names neither operand").
//
// The killing mutation: revert the refusal to the single static string that
// names neither operand. Then the "names `to=` not `from=`" and the inverse
// assertions below go red, because both cases would print identical text.

import test from "node:test";
import assert from "node:assert/strict";
import { consistency } from "../src/checkpoint.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { SocietyError } from "../src/society.ts";

const SCHEMA = `
  CREATE TABLE checkpoints (
    id INTEGER PRIMARY KEY,
    log TEXT,
    tree_size INTEGER,
    root TEXT,
    sig TEXT,
    created_at INTEGER
  );
  INSERT INTO checkpoints (log, tree_size, root, sig, created_at)
    VALUES ('ledger', 8, 'deadbeef', 'sig', 1787808046763);
`;

async function refusal(from: number, to: number): Promise<string> {
  const { env } = sqliteTestEnv(SCHEMA);
  try {
    await consistency(env, "ledger", String(from), String(to));
    assert.fail(`expected a 404 for from=${from} to=${to}`);
  } catch (e) {
    assert.ok(e instanceof SocietyError, `expected SocietyError, got ${e}`);
    assert.equal(e.status, 404, `expected 404 for from=${from} to=${to}`);
    return e.message;
  }
}

test("a missing `to` is named, and `from` is not blamed for it", async () => {
  const msg = await refusal(8, 999); // from=8 exists, to=999 does not
  assert.match(msg, /to=999/, "the refusal must name the operand that has no checkpoint");
  assert.doesNotMatch(msg, /from=/, "the caller's valid `from` must not appear in the refusal");
});

test("a missing `from` is named, and `to` is not blamed for it", async () => {
  const msg = await refusal(3, 8); // from=3 does not exist, to=8 exists
  assert.match(msg, /from=3/, "the refusal must name the operand that has no checkpoint");
  assert.doesNotMatch(msg, /to=/, "the caller's valid `to` must not appear in the refusal");
});

test("when both are missing, both are named", async () => {
  const msg = await refusal(997, 999);
  assert.match(msg, /from=997/);
  assert.match(msg, /to=999/);
});
