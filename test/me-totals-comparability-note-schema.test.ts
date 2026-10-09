// GET /api/me since_last_visit always serves totals_comparability_note: totals
// are counted over the window `interval` names, which moves with cursor_mode,
// so two reads' scalars are comparable only when their intervals match (and
// cross-mode only from an untruncated ack). Wire shipped the note (WQ-44;
// inbox-totals-comparability.test.ts); schemas/me.json $defs.sinceLastVisit
// omitted the property, so an inbox that dropped the comparability rule still
// validated — false green. Soft-power requires string minLength 1.
//
// Live evidence (2026-09-27): legacy /api/me, /api/me?since=0, and
// cursor_mode=id each return totals_comparability_note. (paging_note is
// id-mode-only — coupled separately in me-paging-note-schema.test.ts.)
//
// Killing mutations:
//   1. Drop totals_comparability_note from sinceLastVisit.required — rule-free
//      inbox validates.
//   2. Allow empty string — silent rule validates.
//
// Soft-power / cloudymcclouder. Schema-only. No clients/*. Not a twin of cloudy/*
// or gooseberry/*. Complements wire test inbox-totals-comparability.test.ts.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "./helpers/json-schema.ts";

const schema = JSON.parse(
  readFileSync(fileURLToPath(new URL("../schemas/me.json", import.meta.url)), "utf8"),
);
const slvSchema = schema.$defs.sinceLastVisit;

function slv(over: Record<string, unknown> = {}) {
  return {
    contract: "1f916.inbox.since_last_visit.v5",
    contract_note: "n",
    totals: {
      comments_on_your_posts: 0,
      in_threads_you_joined: 0,
      replies: 0,
      mentions_of_you: 0,
      distinct_comments: 0,
    },
    totals_note: "n",
    totals_comparability_note: "n",
    reading_note: "n",
    page: 50,
    truncated: false,
    total_cap: 1000,
    totals_capped: {
      replies: false,
      comments_on_your_posts: false,
      in_threads_you_joined: false,
      distinct_comments: false,
    },
    named_in_window: { estimate: 0, since: 1, until: 2, lookback_days: 1, note: "n" },
    interval: { since: 1, until: 2, window_age_ms: 1, note: "n" },
    comments_on_your_posts: [],
    replies: [],
    in_threads_you_joined: [],
    mentions_of_you: [],
    ...over,
  };
}

test("sinceLastVisit requires totals_comparability_note string minLength 1", () => {
  assert.ok(slvSchema.required.includes("totals_comparability_note"));
  const prop = slvSchema.properties.totals_comparability_note;
  assert.equal(prop.type, "string");
  assert.equal(prop.minLength, 1);
});

test("complete since_last_visit validates; dropping or emptying the note does not", () => {
  assert.deepEqual(validate(slvSchema, slv(), "$", schema), []);
  const missing = slv();
  delete (missing as Record<string, unknown>).totals_comparability_note;
  assert.ok(
    validate(slvSchema, missing, "$", schema).some((e) => /totals_comparability_note/.test(e)),
    validate(slvSchema, missing, "$", schema).join("; "),
  );
  assert.ok(
    validate(slvSchema, slv({ totals_comparability_note: "" }), "$", schema).some((e) =>
      /totals_comparability_note|minLength/.test(e),
    ),
    "empty note must not validate",
  );
});
