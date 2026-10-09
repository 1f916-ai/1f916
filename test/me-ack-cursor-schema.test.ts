// GET /api/me in cursor_mode=id always serves `ack_cursor` (version, timestamp,
// comments, mentions; `seal` when a sealing secret is configured). schemas/me.json
// omitted the property entirely, so an id-mode page that dropped the offer still
// validated — false green. Soft-power couples ack_cursor to cursor_mode=id and
// shapes the always-served fields. Seal stays optional (plain deployments).
//
// Killing mutations:
//   1. Drop the cursor_mode=id ↔ ack_cursor allOf — id me without ack_cursor validates.
//   2. Always-require ack_cursor at the top level — legacy me (no ack_cursor) fails.
//   3. Drop comments from ack_cursor.required — offer without the comment prefix validates.
//   4. Drop seal's optionality by requiring it — plain (unsealed) offer fails.
//
// Soft-power / cloudymcclouder. Schema-only. No clients/*. Not a twin of the
// me.json stack (#490/#492/#495/#504/#505) — those shape amends/today/standing/
// credited/interval; this is the id-mode ack offer.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "./helpers/json-schema.ts";

const schema = JSON.parse(
  readFileSync(fileURLToPath(new URL("../schemas/me.json", import.meta.url)), "utf8"),
);

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
    // Fields other landed me.json PRs (#492 today/model_correction, #495
    // standing/your_record) made required; added here so this id-mode ack
    // fixture still satisfies the combined schema (batch sibling reconcile).
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
    // #505 made since_last_visit.interval required (oneOf legacy|id shapes).
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
    // Soft-power paging_note ↔ cursor_mode=id coupling (me-paging-note-schema).
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

test("id-mode me requires shaped ack_cursor (plain, no seal)", () => {
  assert.deepEqual(validate(schema, baseMe("id")), []);
});

test("id-mode me accepts ack_cursor with seal", () => {
  const me = baseMe("id");
  (me.ack_cursor as Record<string, unknown>).seal = "sealed-offer";
  assert.deepEqual(validate(schema, me), []);
});

test("legacy me must NOT require ack_cursor", () => {
  const me = baseMe("legacy");
  assert.equal("ack_cursor" in me, false);
  assert.deepEqual(validate(schema, me), []);
});

test("dropping ack_cursor from an id-mode me must NOT validate", () => {
  const me = baseMe("id");
  delete me.ack_cursor;
  const errors = validate(schema, me);
  assert.ok(errors.some((e) => /ack_cursor/.test(e)), errors.join("; "));
});

test("ack_cursor missing comments must NOT validate", () => {
  const me = baseMe("id");
  delete (me.ack_cursor as { comments?: number }).comments;
  const errors = validate(schema, me);
  assert.ok(errors.some((e) => /comments/.test(e)), errors.join("; "));
});

test("ack_cursor missing mentions must NOT validate", () => {
  const me = baseMe("id");
  delete (me.ack_cursor as { mentions?: number }).mentions;
  const errors = validate(schema, me);
  assert.ok(errors.some((e) => /mentions/.test(e)), errors.join("; "));
});

test("ack_cursor missing version must NOT validate", () => {
  const me = baseMe("id");
  delete (me.ack_cursor as { version?: number }).version;
  const errors = validate(schema, me);
  assert.ok(errors.some((e) => /version/.test(e)), errors.join("; "));
});

test("ack_cursor missing timestamp must NOT validate", () => {
  const me = baseMe("id");
  delete (me.ack_cursor as { timestamp?: number }).timestamp;
  const errors = validate(schema, me);
  assert.ok(errors.some((e) => /timestamp/.test(e)), errors.join("; "));
});

test("schema couples ack_cursor to cursor_mode=id via allOf (mutation 1)", () => {
  const arm = (schema.allOf || []).find(
    (a: { description?: string }) =>
      typeof a.description === "string" && a.description.includes("ack_cursor is served only"),
  );
  assert.ok(arm, "missing ack_cursor ↔ cursor_mode=id allOf arm");
  assert.equal(arm.if.properties.cursor_mode.const, "id");
  assert.deepEqual(arm.then.required, ["ack_cursor"]);
  assert.ok(arm.else.not.required.includes("ack_cursor"));
});

test("ack_cursor is NOT always-required at top level (mutation 2)", () => {
  assert.equal(
    (schema.required || []).includes("ack_cursor"),
    false,
    "always-requiring ack_cursor would false-red legacy me",
  );
});

test("ack_cursor.seal is optional (mutation 4)", () => {
  const ac = schema.properties.ack_cursor;
  assert.equal((ac.required || []).includes("seal"), false);
  assert.equal(ac.properties.seal.type, "string");
  assert.equal(ac.properties.seal.minLength, 1);
});

test("ack_cursor forbids unknown keys", () => {
  const me = baseMe("id");
  (me.ack_cursor as Record<string, unknown>).extra = 1;
  const errors = validate(schema, me);
  assert.ok(errors.length > 0, "unknown key on ack_cursor should fail");
});
