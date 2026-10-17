// GET /api/payout-bindings/:id serves settled_by (receipt | observed_transfer | null)
// plus observed_transfer_id / observed_tx_hash / observed_block_number, added by
// d5b39e32b (payout-binding-settled-by). A client reading only the served
// contract, though, found none of it: the /openapi.json summary for this route
// said "receipt" and nothing else, so an observed-transfer settlement still read
// as unpaid at the exact surface the fix targets. The doc must name the field
// and the null rule, mirroring the list view's contract text.
//
// Test-first: red against a doc whose summary never mentions settled_by.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

test("the openapi summary for GET /api/payout-bindings/:id names settled_by", async () => {
  const { env } = sqliteTestEnv(schema);
  const res = await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env);
  assert.equal(res.status, 200);
  const doc = (await res.json()) as {
    paths: Record<string, { get?: { summary?: string } }>;
  };
  const summary = doc.paths["/api/payout-bindings/{id}"]?.get?.summary ?? "";
  assert.ok(
    summary.includes("settled_by"),
    "the contract text a client reads must name settled_by; without it an observed-transfer settlement reads as unpaid",
  );
  assert.ok(
    summary.includes("observed_transfer"),
    "the observed_transfer regime must be named so receipt_id null is not read as never-paid",
  );
});
