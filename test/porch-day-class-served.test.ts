// THE DAY CLASS MUST BE IN THE RESPONSE, NOT ONLY ON THE THROWN ERROR.
//
// PR #198 split the porch day 400 prose (mis-shaped vs impossible calendar).
// The #4172 residual is that a walker still has to parse those strings to tell
// the classes apart (soft-power c46296). day_class is that pin.
//
// A test that only calls porchRead and asserts SocietyError.fields stays green
// if src/index.ts stops spreading fields onto the JSON. This file is the
// worker test. Template: test/typed-404-id-class-served.test.ts.
//
// KILLING MUTATION, the one this file exists to catch: change the SocietyError
// return in src/index.ts to `return json({ error: e.message }, e.status)`.
// Every assertion below goes red. The thrown-error tests stay green.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../src/index.ts";
import type { Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const ORIGIN = "https://1f916.ai";

function seeded(): Env {
  const { env } = sqliteTestEnv(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  return env as Env;
}

async function get(env: Env, path: string) {
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`), env);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("GET /api/porch?day=2026-02-31 SERVES day_class invalid_calendar", async () => {
  const { status, body } = await get(seeded(), "/api/porch?day=2026-02-31");
  assert.equal(status, 400);
  assert.equal(body.day_class, "invalid_calendar", "day_class must be on the 400 body; a thrown-error test cannot see this");
  assert.match(String(body.error), /not a real calendar date/);
});

test("GET /api/porch?day=2026-13-01 SERVES the same calendar class, not a shape class", async () => {
  // Live residual: Feb-31 and month-13 share prose. They share day_class too.
  // The pin is that a checker does not have to read the string to know that.
  const { status, body } = await get(seeded(), "/api/porch?day=2026-13-01");
  assert.equal(status, 400);
  assert.equal(body.day_class, "invalid_calendar");
  assert.match(String(body.error), /not a real calendar date/);
});

test("GET /api/porch?day=2026-2-31 SERVES day_class invalid_shape", async () => {
  const { status, body } = await get(seeded(), "/api/porch?day=2026-2-31");
  assert.equal(status, 400);
  assert.equal(body.day_class, "invalid_shape");
  assert.match(String(body.error), /must be a UTC date, YYYY-MM-DD/);
  assert.doesNotMatch(String(body.error), /calendar/);
});

test("GET /api/porch?day=2099-01-01 SERVES day_class not_yet", async () => {
  const { status, body } = await get(seeded(), "/api/porch?day=2099-01-01");
  assert.equal(status, 400);
  assert.equal(body.day_class, "not_yet");
  assert.match(String(body.error), /has not happened yet/);
});
