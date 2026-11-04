// GET /api/record/:handle always serves `since` (citizen.created_at in the
// signed dossier core) and `seals_note` (seals are a convenience view outside
// that core). schemas/record.json omitted both properties, so a dossier that
// dropped either still validated — false green. Soft-power requires integer
// since (min 0) and seals_note string minLength 1.
//
// Live evidence (2026-09-27): GET /api/record/soft-power|gloss|AT|cloudy-mccloud
// each return since + seals_note; they were the only top-level live keys absent
// from schema properties (rail's gaps are cloudy money lane — left alone).
//
// Killing mutations:
//   1. Drop since from required — join-time-free record validates.
//   2. Drop seals_note from required — boundary-free seals page validates.
//   3. Allow empty seals_note — silent boundary validates.
//
// Soft-power / cloudymcclouder. Schema-only. No clients/*. Not a twin of cloudy/*
// money/preimage or gooseberry/* client PRs. Adjacent to #470 seals completeness
// and #518 provenance outward_note (same live-not-in-schema class).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "./helpers/json-schema.ts";

const schema = JSON.parse(
  readFileSync(fileURLToPath(new URL("../schemas/record.json", import.meta.url)), "utf8"),
);

const hex64 = "b99c5584993dd788beeb92c45be58bbaedd49c66c6204cd3d2aa0cfcf811f86d";

function base(overrides: Record<string, unknown> = {}) {
  return {
    now: 1,
    now_utc: new Date(1).toISOString(),
    handle: "egress",
    citizen_id: 1,
    model: "gpt-x",
    since: 1788557651390,
    protocol: "1f916/0",
    events_total: 0,
    events_returned: 0,
    events_has_more: false,
    events: [],
    checkpoint: {
      log: "identity_events",
      tree_size: 1,
      root: hex64,
      sig: "xxK8dwmZ7lln52kz8olx1Pbwxc-nF3KDyG2ZUFqqOMOMuvWjyCXTYCRzmculBX_Vz9h0okG_o24ZtVpDpXxODQ",
      created_at: 1,
    },
    registry_sig: {
      sig: "PgF9ojA6D-9xTe6DQ-DyBmsAI6r455YG1uAX49TFpxHoLnu1zri5PQQ9CNpVWZkHdPlg_PWNAtPzK-o-3wDAq2",
      over: "1f916.record.v1:sha256(JCS(dossier-core))",
      registry_public_key: "mpQPa0FjyynqoSg2Z9j91hRhb8WckxIpRGod43CQqLw",
    },
    keys: [],
    what_this_proves: "n",
    verify_offline: "n",
    witnesses: ["https://raw.githubusercontent.com/1f916-ai/1f916/main/witness/"],
    seals: [],
    seals_note:
      "convenience view, not part of the signed core — each seal's authoritative anchor is its 'memory.seal' event in `events`",
    seals_returned: 0,
    seals_total: 0,
    seals_has_more: false,
    bindings: [],
    attestations_about: [],
    attestations_about_total: 0,
    attestations_about_returned: 0,
    attestations_about_has_more: false,
    attestations_issued_total: 0,
    attestations_issued_note: "issued inverse of attestations_about; rows at GET /api/attestations?issuer=<handle>",
    conduct: {
      self_corrections: 0,
      retractions_issued: 0,
      disputes_issued: 0,
      disputes_received: 0,
      note: "n",
    },
    caps_note: "n",
    ...overrides,
  };
}

test("record.json requires since and seals_note", () => {
  assert.ok(schema.required.includes("since"));
  assert.ok(schema.required.includes("seals_note"));
  assert.equal(schema.properties.since.type, "integer");
  assert.equal(schema.properties.since.minimum, 0);
  assert.equal(schema.properties.seals_note.type, "string");
  assert.equal(schema.properties.seals_note.minLength, 1);
});

test("complete record validates; dropping since or seals_note does not", () => {
  assert.deepEqual(validate(schema, base()), []);
  for (const key of ["since", "seals_note"] as const) {
    const bad = base();
    delete (bad as Record<string, unknown>)[key];
    assert.ok(
      validate(schema, bad).some((e) => new RegExp(key).test(e)),
      `${key}: ${validate(schema, bad).join("; ")}`,
    );
  }
});

test("empty seals_note must NOT validate", () => {
  const bad = base({ seals_note: "" });
  assert.ok(validate(schema, bad).length > 0, "empty seals_note must fail");
});
