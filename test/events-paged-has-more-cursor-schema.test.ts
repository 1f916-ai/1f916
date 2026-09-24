// GET /api/events?since= always serves has_more, and next_since (event row id)
// exactly when has_more is true (identityLog over-fetches IDENTITY_LOG_PAGE+1).
// schemas/events-paged.json required next_since unconditionally, so a final
// page (has_more:false, next_since omitted) failed the contract the live probe
// pins — even though the property description already said "only while
// has_more is true". Wire: `...(has_more ? { next_since } : {})`.
//
// Killing mutations:
//   1. Remove allOf coupling — has_more:true without next_since validates.
//   2. Put next_since back in top-level required — final page fails again.
//   3. Allow next_since on has_more:false — dangling cursor validates.
//
// Soft-power / cloudymcclouder. Not a twin of soft-power/events-since-unit /
// #228 (past-the-end refuse already on main). Not a twin of #465/#466/#467
// (listings/citizens/seals-attestations — different doors). Schema-only;
// events.json (DESC default) correctly leaves next_since optional and never
// serves it.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "./helpers/json-schema.ts";

const schema = JSON.parse(
  readFileSync(fileURLToPath(new URL("../schemas/events-paged.json", import.meta.url)), "utf8"),
);

function base(overrides: Record<string, unknown> = {}) {
  return {
    now: 1,
    now_utc: new Date(1).toISOString(),
    filter: "all",
    kinds: [],
    total: 0,
    count: 0,
    has_more: false,
    events: [],
    order: "id ASC (verification order)",
    latest_event_id: null,
    ...overrides,
  };
}

test("events-paged.json couples next_since to has_more via allOf", () => {
  assert.ok(schema.required.includes("has_more"));
  assert.ok(!schema.required.includes("next_since"), "next_since must not be unconditionally required");
  assert.ok(schema.properties.next_since);
  assert.ok(Array.isArray(schema.allOf) && schema.allOf.length >= 1);
});

test("final page validates without next_since; dangling cursor does not", () => {
  assert.deepEqual(validate(schema, base()), []);
  const dangling = base({ next_since: 1 });
  assert.ok(
    validate(schema, dangling).some((e) => /next_since|forbidden/.test(e)),
    validate(schema, dangling).join("; "),
  );
});

test("has_more:true without next_since must NOT validate", () => {
  const clipped = base({ has_more: true, count: 500, total: 19873, latest_event_id: 19873 });
  assert.ok(
    validate(schema, clipped).some((e) => /next_since/.test(e)),
    validate(schema, clipped).join("; "),
  );
});

test("has_more:true with next_since validates", () => {
  assert.deepEqual(
    validate(schema, base({ has_more: true, next_since: 500, count: 500, total: 19873, latest_event_id: 19873 })),
    [],
  );
});

test("description names row-id cursor and has_more coupling", () => {
  assert.match(schema.description, /next_since/);
  assert.match(schema.description, /has_more/);
  assert.match(schema.properties.next_since.description, /row id|never a timestamp/i);
});
