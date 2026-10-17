// GET /api/citizens serves page_size: CITIZEN_PAGE (1000) beside has_more, and
// ?page_size is refused with 400 (it is a response key, not a knob). The schema
// declared page_size as a bare integer, so the cap's value was not in the
// contract: a reader holding only the schema could not tell a clipped page
// (returned == page_size) from the end of the census. This pins the value and
// holds it to the served constant.
//
// Killing mutations (each went red):
//   1. Drop "const" from schemas/citizens.json page_size -> all three tests.
//   2. Change CITIZEN_PAGE in src/society.ts to 500 -> schema_const_must_not_drift_from_served_cap.
//   3. Change the schema const to 999 -> schema_const_must_not_drift_from_served_cap
//      and "a page served with any other page_size must not validate".
//
// Soft-power / schrodingers-bugs. Not a twin of #579 (query-parameter defaults;
// page_size is not a query parameter here) or of the has_more/next_since pin
// (citizens-has-more-cursor-schema). attest.json page_size (VERIFY_PAGE 20000)
// is left to the chain lane.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "./helpers/json-schema.ts";
import { CITIZEN_PAGE } from "../src/society.ts";

const schema = JSON.parse(readFileSync(fileURLToPath(new URL("../schemas/citizens.json", import.meta.url)), "utf8"));

function body(page_size: unknown) {
  return {
    now: 1,
    now_utc: new Date(1).toISOString(),
    count: 0,
    total: 0,
    returned: 0,
    page_size,
    has_more: false,
    citizens: [],
    model_provenance: "MODEL_PROVENANCE_NOTE",
  };
}

test("page_size_must_not_be_valueless: schema pins the cap's value", () => {
  assert.equal(typeof schema.properties.page_size.const, "number");
  assert.match(schema.properties.page_size.description, /not a knob/);
});

test("schema_const_must_not_drift_from_served_cap", () => {
  assert.equal(schema.properties.page_size.const, CITIZEN_PAGE);
  assert.deepEqual(validate(schema, body(CITIZEN_PAGE)), []);
});

test("a page served with any other page_size must not validate", () => {
  for (const wrong of [CITIZEN_PAGE - 1, CITIZEN_PAGE + 1, 20000]) {
    assert.ok(validate(schema, body(wrong)).some((e) => /page_size/.test(e)), `page_size ${wrong} validated`);
  }
});
