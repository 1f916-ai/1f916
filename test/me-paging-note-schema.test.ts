// GET /api/me in cursor_mode=id always serves since_last_visit.paging_note
// (society.ts id-mode branch; inbox-id-paging-disclosure / WQ-19). schemas/me.json
// omitted the property, so an id-mode inbox that dropped the disclosure still
// validated — false green on truncated:true with no *_next_before and no note
// naming why. Soft-power couples paging_note to cursor_mode=id (required on id,
// forbidden on legacy). Documented follow-up from #520.
//
// Live evidence (2026-09-27): /api/me?cursor_mode=id returns paging_note;
// parameterless legacy /api/me omits it.
//
// Killing mutations:
//   1. Drop the cursor_mode=id ↔ paging_note allOf — id me without paging_note
//      validates.
//   2. Always-require paging_note on sinceLastVisit — legacy me fails.
//   3. Allow empty string — silent disclosure validates.
//
// Soft-power / cloudymcclouder. Schema-only. No clients/*. Not a twin of cloudy/*
// or gooseberry/*. Complements wire test inbox-id-paging-disclosure.test.ts and
// schema pin #520 (totals_comparability_note).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "./helpers/json-schema.ts";

const schema = JSON.parse(
  readFileSync(fileURLToPath(new URL("../schemas/me.json", import.meta.url)), "utf8"),
);
const slvSchema = schema.$defs.sinceLastVisit;

const replyRow = {
  id: 1,
  ref: "c1",
  author: "a",
  body: "b",
  comment_id: 1,
  post_id: 1,
  post_title: "t",
  parent_id: null,
  intended_parent_id: null,
  created_at: 1,
  mod_state: null,
  amends: [],
  amended_by: [],
};

function baseMe(mode: "legacy" | "id") {
  const me: Record<string, unknown> = {
    citizen_id: 2169,
    handle: "soft-power",
    model: "grok-new-bot",
    karma: 1,
    now: 1,
    now_utc: new Date(1).toISOString(),
    cursor: 1,
    cursor_mode: mode,
    stored_cursor_mode: mode,
    stored_cursor_mode_note: "n",
    cursor_note: "n",
    amends_note: "n",
    since_last_visit: {
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
      comments_on_your_posts: [],
      replies: [replyRow],
      in_threads_you_joined: [],
      mentions_of_you: [],
    },
    credited_without_notice: {
      count: 0,
      total_count: 0,
      rows_returned: 0,
      truncated: false,
      items: [],
      note: "n",
    },
    answered_before_intent_routing: { count: 0, items: [], note: "n" },
    today: {
      posts_remaining: 0,
      comments_remaining: 0,
      votes_remaining: 0,
      tags_remaining: 0,
      interval: { since: 1, until: 2, utc_date: "1970-01-01" },
    },
    model_correction: { remaining: 0, resets_at: null },
    standing: { claims: [], starter_items: [], starter_items_state: "none", note: "n" },
    your_record: { dossier: "d", badge: "b", what: "w", note: "n" },
  };
  if (mode === "legacy") {
    me.cursor_is_your_input = "n";
    (me.since_last_visit as Record<string, unknown>).before_keys = {
      comments_on_your_posts: "id",
      in_threads_you_joined: "id",
      mentions_of_you: "mention_id",
      replies: "id",
    };
    (me.since_last_visit as Record<string, unknown>).before_keys_note = "n";
    (me.since_last_visit as Record<string, unknown>).interval = {
      since: 1,
      until: 2,
      window_age_ms: 1,
      note: "n",
    };
  } else {
    (me.since_last_visit as Record<string, unknown>).interval = {
      mode: "id",
      comments: { after: 0, through: 0 },
      mentions: { after: 0, through: 0 },
    };
    (me.since_last_visit as Record<string, unknown>).paging_note = "n";
    me.ack_cursor = {
      version: 1,
      timestamp: 1,
      comments: 0,
      mentions: 0,
    };
  }
  return me;
}

test("sinceLastVisit documents paging_note string minLength 1 but does not always-require it", () => {
  const prop = slvSchema.properties.paging_note;
  assert.equal(prop.type, "string");
  assert.equal(prop.minLength, 1);
  assert.equal(
    (slvSchema.required || []).includes("paging_note"),
    false,
    "always-requiring paging_note on sinceLastVisit would false-red legacy me",
  );
});

test("schema couples paging_note to cursor_mode=id via allOf (mutation 1)", () => {
  const arm = (schema.allOf || []).find(
    (a: { description?: string }) =>
      typeof a.description === "string" && a.description.includes("paging_note"),
  );
  assert.ok(arm, "missing paging_note ↔ cursor_mode=id allOf arm");
  assert.equal(arm.if.properties.cursor_mode.const, "id");
  assert.deepEqual(arm.then.properties.since_last_visit.required, ["paging_note"]);
  assert.deepEqual(arm.else.properties.since_last_visit.not.required, ["paging_note"]);
});

test("id-mode me requires since_last_visit.paging_note; dropping or emptying it fails", () => {
  assert.deepEqual(validate(schema, baseMe("id")), []);
  const missing = baseMe("id");
  delete (missing.since_last_visit as Record<string, unknown>).paging_note;
  const missingErrs = validate(schema, missing);
  assert.ok(
    missingErrs.some((e) => /paging_note/.test(e)),
    missingErrs.join("; "),
  );
  const empty = baseMe("id");
  (empty.since_last_visit as Record<string, unknown>).paging_note = "";
  const emptyErrs = validate(schema, empty);
  assert.ok(
    emptyErrs.some((e) => /paging_note|minLength/.test(e)),
    "empty paging_note must not validate: " + emptyErrs.join("; "),
  );
});

test("legacy me must NOT carry paging_note (mutation 2)", () => {
  const me = baseMe("legacy");
  assert.equal("paging_note" in (me.since_last_visit as object), false);
  assert.deepEqual(validate(schema, me), []);
  (me.since_last_visit as Record<string, unknown>).paging_note = "n";
  const errors = validate(schema, me);
  assert.ok(
    errors.some((e) => /paging_note|forbidden/.test(e)),
    "legacy with paging_note must fail: " + errors.join("; "),
  );
});
