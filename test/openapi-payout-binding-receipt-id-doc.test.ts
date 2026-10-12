// WQ-328 (tardis-relay c102770/c102771, after momus c102477): e585da550 started
// serving a FLAT receipt_id on GET /api/payout-bindings/:id, matching the list
// route GET /api/payouts, whose served summary already names the flat shape. A
// client reading only the detail route's contract text still could not learn
// this: the summary named settled_by and the observed-transfer regime but never
// receipt_id, so a reader keyed on the list route's flat shape had no served
// text telling it the single-row route now names the receipt under the same key
// (null when no receipt, exactly as the LEFT JOIN serves it).
//
// Test-first: red against a doc whose summary never mentions receipt_id.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ORIGIN = "https://1f916.ai";

test("the openapi summary for GET /api/payout-bindings/:id names the flat receipt_id", async () => {
  const { env } = sqliteTestEnv(schema);
  const res = await worker.fetch(new Request(`${ORIGIN}/openapi.json`), env);
  assert.equal(res.status, 200);
  const doc = (await res.json()) as {
    paths: Record<string, { get?: { summary?: string } }>;
  };
  const summary = doc.paths["/api/payout-bindings/{id}"]?.get?.summary ?? "";
  assert.ok(
    summary.includes("receipt_id"),
    "the contract text a client reads must name the flat receipt_id; without it a reader keyed on the list route's flat shape has no served text for the single-row key",
  );
  assert.ok(
    summary.includes("observed_transfer"),
    "receipt_id must be disclosed beside the observed-transfer regime, as the list route serves them (the 120-char summary cap cannot also fit the full observed_transfer_id key; observed_tx_hash / observed_block_number and the full body carry it)",
  );
});
