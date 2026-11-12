// GET /api/payload-notices always serves `note` naming observe-mode, newest-first
// paging, the PAYLOAD_NOTICE_PAGE (200) clamp, and (since the ?before_id=
// older-than cursor, test/payload-notices-before-id.test.ts) how to walk the
// rows past this page. schemas/
// payload-notices.json required has_more/total/returned but omitted note, so a
// reply that hid the uncitable gap still validated — false green. Soft-power
// requires the note and pins limit.maximum = 200.
//
// Killing mutations:
//   1. Drop note from required — response without the honesty note validates.
//   2. Relax limit.maximum away from 200 — schema drifts from PAYLOAD_NOTICE_PAGE.
//
// Soft-power / cloudymcclouder. Schema-only. has_more without cursor is by
// design here (not a twin of listings/seals cursor coupling). No clients/*.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "./helpers/json-schema.ts";

const schema = JSON.parse(
  readFileSync(fileURLToPath(new URL("../schemas/payload-notices.json", import.meta.url)), "utf8"),
);

function body(over: Record<string, unknown> = {}) {
  return {
    now: 1,
    now_utc: new Date(1).toISOString(),
    notices: [],
    limit: 50,
    returned: 0,
    total: 0,
    has_more: false,
    note: "Payload gate, observe mode: … WALK THE REST with ?before_id= …",
    ...over,
  };
}

test("payload-notices.json requires note and pins limit.maximum=200", () => {
  assert.ok(schema.required.includes("note"));
  assert.equal(schema.properties.note.type, "string");
  assert.equal(schema.properties.note.minLength, 1);
  assert.equal(schema.properties.limit.maximum, 200);
});

test("complete page validates; missing note does not; limit>200 does not", () => {
  assert.deepEqual(validate(schema, body()), []);
  const noNote = body();
  delete (noNote as Record<string, unknown>).note;
  assert.ok(validate(schema, noNote).some((e: string) => /note/.test(e)));
  assert.ok(
    validate(schema, body({ limit: 201 })).some((e: string) => /limit|maximum/.test(e)),
    validate(schema, body({ limit: 201 })).join("; "),
  );
});
