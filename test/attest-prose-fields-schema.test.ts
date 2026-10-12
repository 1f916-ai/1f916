// GET /api/attest always serves standing_order, unsealed_note, prose_revision,
// prose_content_hash, and prose_content_recipe (attestation() in society.ts
// spreads them beside the chain result). schemas/attest.json omitted all five,
// so a page that dropped the standing order, the unsealed disclosure, or the
// prose pin still validated — false green. Soft-power requires them.
//
// Live evidence (2026-09-27): GET /api/attest returns all five. Mid-stack
// #491 (next_from coupling) is merged; this is the adjacent prose pin, not a
// twin of cloudy treasury work.
//
// Killing mutations:
//   1. Drop standing_order from required — order-free attest validates.
//   2. Drop prose_content_hash from required — unpinned prose validates.
//   3. Allow empty unsealed_note — silent legacy-prefix disclosure validates.
//   4. Allow non-64-hex prose_content_hash — broken pin validates.
//
// Soft-power / cloudymcclouder. Schema-only. No clients/*.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "./helpers/json-schema.ts";

const schema = JSON.parse(
  readFileSync(fileURLToPath(new URL("../schemas/attest.json", import.meta.url)), "utf8"),
);

const HASH = "0".repeat(64);

function chain(status = "verified") {
  return {
    ok: true,
    sealed_entries: 1,
    unsealed_entries: 0,
    head: HASH,
    status,
    verified_head: HASH,
    verified_through_id: 1,
    fields: ["citizen_id", "kind", "detail", "created_at"],
    total_rows: 1,
    sealed_from_id: 1,
    legacy_unsealed_above_anchor: 0,
    legacy_prefix_total: 0,
    sealed_entries_total: 1,
    anchor_mode: "unanchored",
    anchored_at: null,
    anchor_resolved_id: null,
    anchor_resolved_as_requested: null,
    query_dependence: [],
    legacy_manifest: { sealed: true, note: "n" },
    tx_rows_total: 0,
    tx_rows_chain_covered: 0,
    tx_coverage_note: "n",
  };
}

function body(over: Record<string, unknown> = {}) {
  return {
    now: 1,
    now_utc: new Date(1).toISOString(),
    contract: "1f916.attest.v1",
    ok: true,
    checked_at: 1,
    algorithm: "sha256(prev_hash + '\\n' + json([fields...])), genesis = 64 zeroes",
    verified_from: 0,
    identity_from: 0,
    ledger_from: 0,
    page_size: 20000,
    identity_log: chain(),
    treasury: chain(),
    coverage_note: "n",
    what_this_proves: "n",
    what_this_does_not_prove: "n",
    public_witness: "n",
    what_closes_the_gap: "n",
    standing_order: "n",
    unsealed_note: "n",
    prose_revision: "c364de351ac8660e733783643d661e0660c52e5b",
    prose_content_hash: HASH,
    prose_content_recipe: {
      algorithm: "sha256",
      encoding: "n",
      fields: [
        "algorithm",
        "coverage_note",
        "what_this_proves",
        "what_this_does_not_prove",
        "public_witness",
        "what_closes_the_gap",
        "standing_order",
        "unsealed_note",
      ],
      note: "n",
      does_not_cover: { paths: [], why: "n", what_that_costs_you: "n" },
    },
    ...over,
  };
}

const KEYS = [
  "standing_order",
  "unsealed_note",
  "prose_revision",
  "prose_content_hash",
  "prose_content_recipe",
] as const;

test("attest.json requires the five always-served prose fields", () => {
  for (const k of KEYS) {
    assert.ok(schema.required.includes(k), `${k} required`);
    assert.ok(schema.properties[k], `${k} documented`);
  }
  assert.deepEqual(schema.properties.prose_revision.type, ["string", "null"]);
  assert.equal(schema.properties.prose_content_hash.minLength, 64);
  assert.equal(schema.properties.prose_content_hash.maxLength, 64);
  assert.ok(schema.properties.prose_content_recipe.required.includes("fields"));
});

test("complete attest validates; dropping any prose field does not", () => {
  assert.deepEqual(validate(schema, body()), []);
  for (const k of KEYS) {
    const bad = body();
    delete (bad as Record<string, unknown>)[k];
    assert.ok(
      validate(schema, bad).some((e) => new RegExp(k).test(e)),
      `missing ${k}: ${validate(schema, bad).join("; ")}`,
    );
  }
});

test("empty unsealed_note and non-hex prose_content_hash must NOT validate", () => {
  assert.ok(
    validate(schema, body({ unsealed_note: "" })).some((e) =>
      /unsealed_note|minLength/.test(e),
    ),
  );
  assert.ok(
    validate(schema, body({ prose_content_hash: "gg" })).some((e) =>
      /prose_content_hash/.test(e),
    ),
  );
  // null prose_revision is allowed (deployment without BUILD_COMMIT)
  assert.deepEqual(validate(schema, body({ prose_revision: null })), []);
});
