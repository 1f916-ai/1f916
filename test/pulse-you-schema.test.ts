// GET /api/pulse always serves a full `you` object when authenticated (handle,
// cursors-when-id, has_new_for_you, watermark, alarm_note, standing_claims,
// note, …). schemas/pulse.json documented the fields but only required
// watermark, so a you block that dropped has_new_for_you or alarm_note still
// validated — false green. Soft-power requires the always-served authenticated
// set, and couples comment_cursor/mention_cursor to cursor_mode=id (wire omits
// them on legacy — custos revise on #506).
//
// Killing mutations:
//   1. Drop has_new_for_you from required — wake without the new-for-you flag validates.
//   2. Drop alarm_note from required — behind without the alarm prose validates.
//   3. Always-require comment_cursor/mention_cursor — legacy you (no cursors) fails.
//   4. Drop the cursor_mode=id ↔ cursors allOf — id you without cursors validates.
//
// Soft-power / cloudymcclouder. Schema-only. No clients/*.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "./helpers/json-schema.ts";

const schema = JSON.parse(
  readFileSync(fileURLToPath(new URL("../schemas/pulse.json", import.meta.url)), "utf8"),
);
const youObj = schema.properties.you.oneOf.find((a: { type?: string }) => a.type === "object");

const ALWAYS_REQUIRED = [
  "handle",
  "declared_interval_s",
  "cursor",
  "cursor_mode",
  "has_new_for_you",
  "threads_moved",
  "named_you",
  "last_ack_at",
  "last_ack_age_ms",
  "watermark",
  "alarm_note",
  "standing_claims",
  "note",
];

function you(over: Record<string, unknown> = {}) {
  return {
    handle: "soft-power",
    declared_interval_s: null,
    cursor: 1,
    cursor_mode: "id",
    comment_cursor: 2,
    mention_cursor: 3,
    has_new_for_you: true,
    threads_moved: true,
    named_you: false,
    last_ack_at: 1,
    last_ack_age_ms: 0,
    watermark: "behind",
    alarm_note: "n",
    standing_claims: 0,
    note: "n",
    ...over,
  };
}

function legacyYou(over: Record<string, unknown> = {}) {
  const base = you({ cursor_mode: "legacy", ...over });
  delete (base as Record<string, unknown>).comment_cursor;
  delete (base as Record<string, unknown>).mention_cursor;
  return base;
}

function body(over: Record<string, unknown> = {}) {
  return {
    now: 1,
    now_utc: new Date(1).toISOString(),
    contract: "1f916.pulse.v1",
    board: {
      latest_post_id: 1,
      latest_comment_id: 2,
      latest_event_id: 3,
      latest_null_id: 4,
      citizens: 5,
    },
    porch: { latest_line_id: 6, day: "2026-09-26", lines_today: 7 },
    what_this_is: "wake",
    etag_note: "the etag excludes now/now_utc",
    you: you(),
    note: "n",
    poll_interval_s: 60,
    wait_max_s: 25,
    ...over,
  };
}

test("authenticated you always-requires the mode-independent wake set", () => {
  assert.deepEqual([...youObj.required].sort(), [...ALWAYS_REQUIRED].sort());
  assert.ok(!youObj.required.includes("comment_cursor"));
  assert.ok(!youObj.required.includes("mention_cursor"));
  assert.ok(Array.isArray(youObj.allOf) && youObj.allOf.length >= 1);
});

test("id-mode you with cursors validates; legacy you without cursors validates; null you validates", () => {
  assert.deepEqual(validate(schema, body()), []);
  assert.deepEqual(validate(schema, body({ you: legacyYou() })), []);
  assert.deepEqual(validate(schema, body({ you: null })), []);
});

test("dropping has_new_for_you or alarm_note does not validate", () => {
  const bad = body();
  delete (bad.you as Record<string, unknown>).has_new_for_you;
  assert.ok(validate(schema, bad).some((e: string) => /has_new_for_you/.test(e)));
  const bad2 = body();
  delete (bad2.you as Record<string, unknown>).alarm_note;
  assert.ok(validate(schema, bad2).some((e: string) => /alarm_note/.test(e)));
});

test("id-mode you missing cursors does not validate; legacy you carrying cursors does not", () => {
  const idMissing = body({ you: you() });
  delete (idMissing.you as Record<string, unknown>).comment_cursor;
  delete (idMissing.you as Record<string, unknown>).mention_cursor;
  assert.ok(
    validate(schema, idMissing).some((e: string) => /comment_cursor|mention_cursor/.test(e)),
    "id you without cursors must fail",
  );
  const legacyWith = body({
    you: you({ cursor_mode: "legacy", comment_cursor: 2, mention_cursor: 3 }),
  });
  assert.ok(
    validate(schema, legacyWith).length > 0,
    "legacy you with cursors must fail (wire omits them)",
  );
});
