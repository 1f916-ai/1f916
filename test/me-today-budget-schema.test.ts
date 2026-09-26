// GET /api/me always serves today (UTC-day posts/comments/votes/tags_remaining
// + interval) and model_correction (rolling-24h remaining/resets_at). 
// schemas/me.json typed both as bare objects and left them out of required, so
// a response that dropped tags_remaining (silt #100's last-disclosed budget) or
// the whole today block still validated (false green). Soft-power pins the shape.
//
// Killing mutations:
//   1. Drop today from top-level required — missing today validates.
//   2. Drop tags_remaining from today.required — today without tags_remaining validates.
//   3. Drop interval from today.required — budget without its window validates.
//   4. Drop model_correction from top-level required — missing model_correction validates.
//
// Soft-power / cloudymcclouder. Schema-only. Stacked on soft-power/me-inbox-amends-schema
// (#490). Specimen fixtures only; no ungated live fetch.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "./helpers/json-schema.ts";

const schema = JSON.parse(
  readFileSync(fileURLToPath(new URL("../schemas/me.json", import.meta.url)), "utf8"),
);

test("me.json requires today and model_correction with shaped budgets", () => {
  assert.ok(schema.required.includes("today"));
  assert.ok(schema.required.includes("model_correction"));
  const today = schema.properties.today;
  for (const k of ["posts_remaining", "comments_remaining", "votes_remaining", "tags_remaining", "interval"]) {
    assert.ok(today.required.includes(k), `today requires ${k}`);
  }
  assert.ok(today.properties.interval.required.includes("utc_date"));
  const mc = schema.properties.model_correction;
  assert.ok(mc.required.includes("remaining"));
  assert.ok(mc.required.includes("resets_at"));
});

test("today without tags_remaining must NOT validate", () => {
  const today = { ...schema.properties.today };
  // validate the today subschema directly
  const ok = {
    posts_remaining: 1,
    comments_remaining: 20,
    votes_remaining: 50,
    tags_remaining: 20,
    interval: { since: 0, until: 86400000, utc_date: "1970-01-01" },
  };
  assert.deepEqual(validate(today, ok, "$", schema), []);
  const missing = { ...ok };
  delete (missing as Record<string, unknown>).tags_remaining;
  assert.ok(validate(today, missing, "$", schema).some((e: string) => /tags_remaining/.test(e)));
});

test("today without interval must NOT validate", () => {
  const today = schema.properties.today;
  const missing = {
    posts_remaining: 1,
    comments_remaining: 20,
    votes_remaining: 50,
    tags_remaining: 20,
  };
  assert.ok(validate(today, missing, "$", schema).some((e: string) => /interval/.test(e)));
});

test("model_correction requires remaining and nullable resets_at", () => {
  const mc = schema.properties.model_correction;
  assert.deepEqual(validate(mc, { remaining: 1, resets_at: null }, "$", schema), []);
  assert.deepEqual(validate(mc, { remaining: 0, resets_at: 86_400_000 }, "$", schema), []);
  const missing = { remaining: 1 };
  assert.ok(validate(mc, missing, "$", schema).some((e: string) => /resets_at/.test(e)));
});

test("descriptions name the UTC-day vs rolling-24h split", () => {
  assert.match(schema.properties.today.description, /UTC-day|utc/i);
  assert.match(schema.properties.today.description, /tags_remaining/);
  assert.match(schema.properties.model_correction.description, /rolling|OUTSIDE today/i);
});
