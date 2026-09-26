// GET /api/attest serves next_from on a chain block exactly when status is
// incomplete (resume cursor = last hashed id). schemas/attest.json required
// status and verified_head but omitted next_from entirely, so an incomplete
// page without a resume cursor still validated (false green). #489 made the
// continuation contract load-bearing (hand verified_head back as expect with
// next_from); pin the schema so a clipped page cannot hide the seam.
//
// Killing mutations:
//   1. Remove allOf on identity_log — incomplete without next_from validates.
//   2. Put next_from in top-level required — verified pages fail.
//   3. Allow next_from on status:verified — dangling resume cursor validates.
//
// Soft-power / cloudymcclouder. Schema-only. Not a twin of tally-stick #489
// (wire/behavior) or cloudy treasury work. Specimen fixtures only.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "./helpers/json-schema.ts";

const schema = JSON.parse(
  readFileSync(fileURLToPath(new URL("../schemas/attest.json", import.meta.url)), "utf8"),
);

const HASH = "0".repeat(64);

function chain(status: string, opts: { next_from?: number; treasury?: boolean } = {}) {
  const block: Record<string, unknown> = {
    ok: true,
    sealed_entries: 1,
    unsealed_entries: 0,
    head: HASH,
    status,
    verified_head: HASH,
    verified_through_id: 1,
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
  };
  if (opts.treasury) {
    block.tx_rows_total = 0;
    block.tx_rows_chain_covered = 0;
    block.tx_coverage_note =
      "no ledger row carries a tx, so the tx cross-check has nothing to reach.";
  }
  if (opts.next_from !== undefined) block.next_from = opts.next_from;
  return block;
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
    identity_log: chain("verified"),
    treasury: chain("verified", { treasury: true }),
    coverage_note: "n",
    what_this_proves: "n",
    what_this_does_not_prove: "n",
    public_witness: "n",
    what_closes_the_gap: "n",
    ...over,
  };
}

test("identity_log and treasury couple next_from to status incomplete", () => {
  for (const name of ["identity_log", "treasury"] as const) {
    const block = schema.properties[name];
    assert.ok(block.properties.next_from, `${name} documents next_from`);
    assert.ok(!block.required.includes("next_from"), `${name} must not always-require next_from`);
    assert.ok(Array.isArray(block.allOf) && block.allOf.length >= 1, `${name} has allOf coupling`);
  }
});

test("verified pages validate without next_from; dangling resume cursor does not", () => {
  assert.deepEqual(validate(schema, body()), []);
  const dangling = body({
    identity_log: chain("verified", { next_from: 20000 }),
  });
  assert.ok(
    validate(schema, dangling).some((e) => /next_from|forbidden/.test(e)),
    validate(schema, dangling).join("; "),
  );
});

test("incomplete without next_from must NOT validate", () => {
  const clipped = body({
    identity_log: chain("incomplete"),
    ok: false,
  });
  assert.ok(
    validate(schema, clipped).some((e) => /next_from/.test(e)),
    validate(schema, clipped).join("; "),
  );
});

test("incomplete with next_from validates on both chains", () => {
  assert.deepEqual(
    validate(
      schema,
      body({
        identity_log: chain("incomplete", { next_from: 20000 }),
        treasury: chain("incomplete", { next_from: 20000, treasury: true }),
        ok: false,
      }),
    ),
    [],
  );
});
