// GET /api/anchors always serves contract / what_this_is / what_an_anchor_proves /
// targets / anchored_text / how_to_verify / latest_checkpoints / anchors /
// has_more / next_since_id / caps (router adds now/now_utc). No published schema
// meant a clipped page missing has_more had nothing to fail. Soft-power adds
// schemas/anchors.json. next_since_id is ALWAYS required (rail-events/mandates
// shape), not omit-on-final.
//
// Killing mutations:
//   1. Drop has_more from required — incomplete fixture validates.
//   2. Drop next_since_id from required — always-cursor lie returns.
//   3. Change caps.per_response const away from 200 — ANCHOR_PAGE pin breaks.
//
// Soft-power / cloudymcclouder. Sibling of #485 (mandates schema), not a twin —
// different door. Complements #483 (SURFACE cites ANCHOR_PAGE). Specimen only.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "./helpers/json-schema.ts";

const schema = JSON.parse(
  readFileSync(fileURLToPath(new URL("../schemas/anchors.json", import.meta.url)), "utf8"),
);

const hex64 = "e402a0f1d036e289cf415f94409a78d9a28a4979505fc99ad29ec58dc335807b";

function base(overrides: Record<string, unknown> = {}) {
  return {
    now: 1,
    now_utc: new Date(1).toISOString(),
    contract: "1f916.anchors.v1",
    what_this_is: "Anchors of checkpoints.",
    what_an_anchor_proves: "A confirmed anchor proves the checkpoint text existed.",
    targets: {
      ots_calendars: ["https://alice.btc.calendar.opentimestamps.org"],
      base: true,
      archive: "authenticated",
    },
    anchored_text: "1f916.checkpoint.v1:...",
    how_to_verify: { ots: "ots verify", base: "read input data", archive: "wayback" },
    latest_checkpoints: [
      {
        checkpoint_id: 1,
        log: "identity_events",
        tree_size: 1,
        root: hex64,
        payload: "1f916.checkpoint.v1:identity_events:1:" + hex64 + ":1",
        anchors: [
          {
            kind: "ots",
            target: "https://alice.btc.calendar.opentimestamps.org",
            status: "pending",
            error: null,
            created_at: 1,
            confirmed_at: null,
          },
        ],
      },
    ],
    anchors: [
      {
        id: 1,
        checkpoint_id: 1,
        log: "identity_events",
        tree_size: 1,
        root: hex64,
        payload: "1f916.checkpoint.v1:identity_events:1:" + hex64 + ":1",
        kind: "base",
        target: "0xabc",
        status: "confirmed",
        error: null,
        created_at: 1,
        confirmed_at: 2,
      },
    ],
    has_more: false,
    next_since_id: 1,
    caps: { per_response: 200, unit: "anchors, oldest-first by id" },
    ...overrides,
  };
}

test("anchors.json requires has_more, next_since_id, and caps", () => {
  for (const key of ["has_more", "next_since_id", "caps", "contract", "anchors", "latest_checkpoints"]) {
    assert.ok(schema.required.includes(key), `required must include ${key}`);
  }
});

test("a final page with always-served next_since_id validates", () => {
  assert.deepEqual(validate(schema, base()), []);
});

test("empty anchors page still requires next_since_id", () => {
  assert.deepEqual(validate(schema, base({ anchors: [], has_more: false, next_since_id: 0 })), []);
  const missing = base({ anchors: [] });
  delete (missing as { next_since_id?: number }).next_since_id;
  assert.ok(validate(schema, missing).some((e) => /next_since_id/.test(e)));
});

test("dropping has_more must NOT validate", () => {
  const incomplete = base();
  delete (incomplete as { has_more?: boolean }).has_more;
  assert.ok(validate(schema, incomplete).some((e) => /has_more/.test(e)));
});

test("caps.per_response is ANCHOR_PAGE (200)", () => {
  assert.equal(schema.properties.caps.properties.per_response.const, 200);
  const bad = base({ caps: { per_response: 100, unit: "x" } });
  assert.ok(validate(schema, bad).some((e) => /per_response|const|200/.test(e)));
});

test("ots row may carry ots_file and payload_file", () => {
  assert.deepEqual(
    validate(
      schema,
      base({
        anchors: [
          {
            id: 2,
            checkpoint_id: 1,
            log: "identity_events",
            tree_size: 1,
            root: hex64,
            payload: "p",
            kind: "ots",
            target: "https://alice.btc.calendar.opentimestamps.org",
            status: "pending",
            error: null,
            created_at: 1,
            confirmed_at: null,
            ots_file: "/api/anchors/2.ots",
            payload_file: "/api/anchors/2.txt",
          },
        ],
      }),
    ),
    [],
  );
});

test("description names always-served next_since_id and has_more", () => {
  assert.match(schema.description, /has_more/);
  assert.match(schema.description, /next_since_id/);
  assert.match(schema.description, /ALWAYS|always served|rail-events|mandates/i);
});
