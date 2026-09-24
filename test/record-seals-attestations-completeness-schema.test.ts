// GET /api/record/:handle always serves seals_returned and
// attestations_about_total / attestations_about_returned (zeros included).
// Healthy path also serves seals_total beside seals_has_more; degraded path
// omits both and serves seals_completeness_unknown instead. schemas/record.json
// required seals_has_more / attestations_about_has_more but omitted the
// totals/returned pair, so a dossier that dropped the counts still validated —
// live false green: GET /api/record/egress → seals_returned:200, seals_total:493,
// attestations_about_total:8, attestations_about_returned:8 against a schema
// that never named them.
//
// No record-side seals/attestations cursor (caps_note points at GET /api/seals
// and GET /api/attestations). Not a twin of #469 (events_*) or #405 (page-cap
// names) or #467 (list-door next_since_id).
//
// Killing mutations:
//   1. Drop seals_returned from required — page without returned count validates.
//   2. Drop attestations_about_total from required — has_more without total validates.
//   3. Remove seals_total from the seals_has_more then-branch — healthy path
//      without seals_total validates.

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
    seals_returned: 0,
    seals_total: 0,
    seals_has_more: false,
    bindings: [],
    attestations_about: [],
    attestations_about_total: 0,
    attestations_about_returned: 0,
    attestations_about_has_more: false,
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

test("record.json requires seals_returned and attestations_about total/returned", () => {
  assert.ok(schema.required.includes("seals_returned"));
  assert.ok(schema.required.includes("attestations_about_total"));
  assert.ok(schema.required.includes("attestations_about_returned"));
  assert.ok(schema.properties.seals_total);
  assert.ok(schema.properties.seals_completeness_unknown);
});

test("healthy final page validates; omitting seals_total does not", () => {
  assert.deepEqual(validate(schema, base()), []);
  const missing = base();
  delete (missing as { seals_total?: number }).seals_total;
  assert.ok(
    validate(schema, missing).some((e) => /seals_total/.test(e)),
    validate(schema, missing).join("; "),
  );
});

test("clipped seals page with totals validates", () => {
  assert.deepEqual(
    validate(
      schema,
      base({
        seals_has_more: true,
        seals_returned: 200,
        seals_total: 493,
      }),
    ),
    [],
  );
});

test("omitting attestations_about_total must NOT validate", () => {
  const bare = base();
  delete (bare as { attestations_about_total?: number }).attestations_about_total;
  assert.ok(
    validate(schema, bare).some((e) => /attestations_about_total/.test(e)),
    validate(schema, bare).join("; "),
  );
});

test("omitting seals_returned must NOT validate", () => {
  const bare = base();
  delete (bare as { seals_returned?: number }).seals_returned;
  assert.ok(
    validate(schema, bare).some((e) => /seals_returned/.test(e)),
    validate(schema, bare).join("; "),
  );
});

test("description names seals/attestations completeness (no record-side cursor)", () => {
  assert.match(schema.description, /seals_returned/);
  assert.match(schema.description, /attestations_about_total|attestations_about/);
  assert.match(schema.description, /No record-side|no record-side/i);
});
