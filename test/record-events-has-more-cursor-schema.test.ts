// GET /api/record/:handle always serves events_has_more / events_returned, and
// next_events_since (event row id) exactly when events_has_more is true
// (`...(hasMore ? { next_events_since } : {})` after RECORD_EVENTS_PAGE).
// schemas/record.json required events_total but omitted events_has_more and
// the cursor, so a clipped dossier without a continuation still validated —
// live false green: GET /api/record/egress → events_has_more:true,
// next_events_since:9956, events_returned:200, events_total:500 against a
// schema that never named the pair.
//
// Killing mutations:
//   1. Remove allOf — events_has_more:true without next_events_since validates.
//   2. Drop events_has_more from required — clipped page without the flag validates.
//   3. Allow next_events_since on events_has_more:false — dangling cursor validates.
//
// Soft-power / cloudymcclouder. Not a twin of #405 (RECORD_*_PAGE naming only)
// or record-events-since past-the-end refuse. Focused on the events stream;
// seals/attestations_* totals are a separate gap.

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
    seals_has_more: false,
    bindings: [],
    attestations_about: [],
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

test("record.json requires events_has_more/events_returned and couples next_events_since", () => {
  assert.ok(schema.required.includes("events_has_more"));
  assert.ok(schema.required.includes("events_returned"));
  assert.ok(!schema.required.includes("next_events_since"));
  assert.ok(schema.properties.next_events_since);
  assert.ok(Array.isArray(schema.allOf) && schema.allOf.length >= 1);
});

test("final page validates without next_events_since; dangling cursor does not", () => {
  assert.deepEqual(validate(schema, base()), []);
  const dangling = base({ next_events_since: 1 });
  assert.ok(
    validate(schema, dangling).some((e) => /next_events_since|forbidden/.test(e)),
    validate(schema, dangling).join("; "),
  );
});

test("events_has_more:true without next_events_since must NOT validate", () => {
  const clipped = base({
    events_has_more: true,
    events_returned: 200,
    events_total: 500,
  });
  assert.ok(
    validate(schema, clipped).some((e) => /next_events_since/.test(e)),
    validate(schema, clipped).join("; "),
  );
});

test("events_has_more:true with next_events_since validates", () => {
  assert.deepEqual(
    validate(
      schema,
      base({
        events_has_more: true,
        next_events_since: 9956,
        events_returned: 200,
        events_total: 500,
      }),
    ),
    [],
  );
});

test("omitting events_has_more must NOT validate", () => {
  const bare = base();
  delete (bare as { events_has_more?: boolean }).events_has_more;
  assert.ok(
    validate(schema, bare).some((e) => /events_has_more/.test(e)),
    validate(schema, bare).join("; "),
  );
});

test("description names events cursor coupling", () => {
  assert.match(schema.description, /next_events_since/);
  assert.match(schema.description, /events_has_more/);
  assert.match(schema.properties.next_events_since.description, /row id|never a timestamp/i);
});
