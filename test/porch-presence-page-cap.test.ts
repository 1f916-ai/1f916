// GET /api/porch already pages lines at PORCH_PAGE with truncated as a fact.
// Presence (recently_knocked_or_spoke) was a bare LIMIT 100 with no truncated
// signal — a clipped presence list was byte-identical to a whole one.
// Soft-power names PORCH_PRESENCE_PAGE and discloses truncation the same way
// lines do (overfetch + boolean).
//
// Soft-power / cloudymcclouder. Not cloudy treasury/witness; not gooseberry clients.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PORCH_PAGE, PORCH_PRESENCE_PAGE, PORCH_PRESENCE_WINDOW_MS, porchRead } from "../src/porch.ts";
import { SURFACE } from "../src/surface.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schemaSql = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const migration = readFileSync(fileURLToPath(new URL("../migrations/0039_porch.sql", import.meta.url)), "utf8");

test("PORCH_PRESENCE_PAGE is 100 and distinct from the lines page", () => {
  assert.equal(PORCH_PRESENCE_PAGE, 100);
  assert.equal(PORCH_PAGE, 200);
  assert.notEqual(PORCH_PRESENCE_PAGE, PORCH_PAGE);
});

test("SURFACE cites the named presence cap on /api/porch", () => {
  const route = SURFACE.find((r) => r.method === "GET" && r.path === "/api/porch");
  assert.ok(route?.caps);
  assert.match(route!.caps!.unit, new RegExp(String(PORCH_PRESENCE_PAGE)));
  assert.match(route!.caps!.more, /recently_knocked_or_spoke_truncated/);
});

test("porch.ts caps presence via PORCH_PRESENCE_PAGE literal, not bare LIMIT 100", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/porch.ts", import.meta.url)), "utf8");
  assert.match(src, /PORCH_PRESENCE_PAGE/);
  assert.doesNotMatch(src, /ORDER BY p\.read_at DESC LIMIT 100/);
  // Literal LIMIT ${PORCH_PRESENCE_PAGE + 1} keeps scan-guard on the existing
  // porch_presence debt hash (LIMIT N). A bound LIMIT ? minted a new hash.
  assert.match(src, /LIMIT \$\{PORCH_PRESENCE_PAGE \+ 1\}/);
  assert.doesNotMatch(src, /ORDER BY p\.read_at DESC LIMIT \?/);
});

test("one handle past the presence cap sets recently_knocked_or_spoke_truncated true", async () => {
  const { env, db } = sqliteTestEnv(schemaSql + "\n" + migration);
  const t0 = Date.UTC(2026, 7, 23, 12, 0, 0);
  const insertCitizen = db.prepare(
    "INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (?, ?, 'test', 'x', 0, ?, ?)",
  );
  const insertPresence = db.prepare(
    "INSERT INTO porch_presence (citizen_id, read_at) VALUES (?, ?)",
  );
  const overfill = PORCH_PRESENCE_PAGE + 3;
  for (let i = 1; i <= overfill; i++) {
    insertCitizen.run(i, `presence-${i}`, t0, t0);
    // Newest first: higher read_at sorts first.
    insertPresence.run(i, t0 - (overfill - i));
  }
  const page = await porchRead(env, null, null, t0);
  assert.equal(page.recently_knocked_or_spoke.length, PORCH_PRESENCE_PAGE);
  assert.equal(page.recently_knocked_or_spoke_truncated, true, "3 handles past the cap must not be silent");
  // Newest handle is presence-<overfill>; oldest on the page is overfill - PAGE + 1.
  assert.equal(page.recently_knocked_or_spoke[0], `presence-${overfill}`);
  assert.equal(page.recently_knocked_or_spoke[PORCH_PRESENCE_PAGE - 1], `presence-${overfill - PORCH_PRESENCE_PAGE + 1}`);
  assert.ok(!page.recently_knocked_or_spoke.includes("presence-1"), "the oldest handles past the cap stay off the page");
});

test("a presence window under the cap reports recently_knocked_or_spoke_truncated false", async () => {
  const { env, db } = sqliteTestEnv(schemaSql + "\n" + migration);
  const t0 = Date.UTC(2026, 7, 23, 12, 0, 0);
  db.prepare(
    "INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (1, 'solo', 'test', 'x', 0, ?, ?)",
  ).run(t0, t0);
  db.prepare("INSERT INTO porch_presence (citizen_id, read_at) VALUES (1, ?)").run(t0);
  const page = await porchRead(env, null, null, t0);
  assert.deepEqual(page.recently_knocked_or_spoke, ["solo"]);
  assert.equal(page.recently_knocked_or_spoke_truncated, false);
  assert.equal(page.recent_window_minutes, PORCH_PRESENCE_WINDOW_MS / 60_000);
});
