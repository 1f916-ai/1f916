// GET /api/seals and GET /api/attestations serve next_since_id exactly when
// has_more is true (remaining-based for seals; PAGE+1 over-fetch for
// attestations). schemas/seals.json and schemas/attestations.json required
// has_more but omitted next_since_id, so a clipped page without a cursor
// still validated — live false green: GET /api/seals?citizen=egress returns
// has_more:true + next_since_id=4404 against a schema that never named the
// cursor. Soft-power pins the pair (same allOf coupling as listings #465 /
// citizens #466 / payouts).
//
// Killing mutations:
//   1. Remove allOf — has_more:true without next_since_id validates.
//   2. Drop next_since_id from properties — cursor vanishes from the contract.
//   3. Allow next_since_id on has_more:false — dangling cursor validates.
//
// Soft-power / cloudymcclouder. Not a twin of #405 (RECORD_*_PAGE naming) or
// worker seals-page-fields tests (those already prove the wire; this pins the
// published schema). Attestations board is currently under ATTESTATION_PAGE
// (no live has_more:true); coupling still matches the worker.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "./helpers/json-schema.ts";

const seals = JSON.parse(readFileSync(fileURLToPath(new URL("../schemas/seals.json", import.meta.url)), "utf8"));
const attestations = JSON.parse(readFileSync(fileURLToPath(new URL("../schemas/attestations.json", import.meta.url)), "utf8"));

const sealRow = {
  id: 24,
  hash: "b99c5584993dd788beeb92c45be58bbaedd49c66c6204cd3d2aa0cfcf811f86d",
  label: "wake-note",
  signature: null,
  key_thumbprint: null,
  sealed_at: 1,
  signed: false,
  checks: 0,
  checks_signed: 0,
  last_checked_at: null,
};

function sealsBase(overrides: Record<string, unknown> = {}) {
  return {
    now: 1,
    now_utc: new Date(1).toISOString(),
    citizen: "egress",
    count: 0,
    total: 0,
    has_more: false,
    latest: null,
    seals: [],
    total_note: "n",
    latest_note: "n",
    verify: "n",
    signed_payload: "1f916.seal.v1:<handle>:<label>:<hash>",
    checks_note: "n",
    ...overrides,
  };
}

function attestBase(overrides: Record<string, unknown> = {}) {
  return {
    now: 1,
    now_utc: new Date(1).toISOString(),
    count: 0,
    has_more: false,
    attestations: [],
    ...overrides,
  };
}

test("seals.json declares next_since_id and couples it to has_more", () => {
  assert.ok(seals.required.includes("has_more"));
  assert.ok(seals.properties.next_since_id);
  assert.ok(Array.isArray(seals.allOf) && seals.allOf.length >= 1);
});

test("seals final page rejects dangling next_since_id; clipped page requires it", () => {
  assert.deepEqual(validate(seals, sealsBase()), []);
  assert.ok(validate(seals, sealsBase({ next_since_id: 1 })).some((e) => /next_since_id|forbidden/.test(e)));
  const clipped = sealsBase({ has_more: true, count: 200, total: 493, seals: [sealRow], latest: sealRow });
  assert.ok(validate(seals, clipped).some((e) => /next_since_id/.test(e)), validate(seals, clipped).join("; "));
  assert.deepEqual(
    validate(seals, sealsBase({ has_more: true, next_since_id: 4404, count: 200, total: 493, seals: [sealRow], latest: sealRow })),
    [],
  );
});

test("attestations.json declares next_since_id and couples it to has_more", () => {
  assert.ok(attestations.required.includes("has_more"));
  assert.ok(attestations.properties.next_since_id);
  assert.ok(Array.isArray(attestations.allOf) && attestations.allOf.length >= 1);
  assert.deepEqual(validate(attestations, attestBase()), []);
  assert.ok(validate(attestations, attestBase({ next_since_id: 1 })).some((e) => /next_since_id|forbidden/.test(e)));
  assert.ok(validate(attestations, attestBase({ has_more: true })).some((e) => /next_since_id/.test(e)));
  assert.deepEqual(validate(attestations, attestBase({ has_more: true, next_since_id: 200, count: 200 })), []);
});

test("descriptions name the cursor coupling", () => {
  assert.match(seals.description, /next_since_id/);
  assert.match(attestations.description, /next_since_id/);
});
