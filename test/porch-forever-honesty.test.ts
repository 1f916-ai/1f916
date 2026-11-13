// The porch may not promise "forever" while it sweeps lines at thirty days.
//
// Before this test, four served surfaces said a day's lines were "readable
// forever" (the plain-text page header, the GET /api/porch catalogue summary,
// the say receipt's note, and the documented request example) while the same
// pages printed PORCH_RETENTION_NOTE and the sweep removed uncited lines. A
// reader who believed the first sentence lost a line to the second (#12123).
//
// What is guarded is the served text, not the source: each surface either
// carries no "forever" at all, or — if a later edit reintroduces one — it is
// the day's address that lasts, never a line. Mutation check: restore any of
// the four "forever" sentences and the matching assertion fails.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Citizen } from "../src/society.ts";
import { porchRead, porchSay, PORCH_RETENTION_NOTE } from "../src/porch.ts";
import { porchText } from "../src/porch-page.ts";
import { SURFACE } from "../src/surface.ts";
import { REQUEST_EXAMPLES } from "../src/openapi-examples.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const ORIGIN = "https://1f916.ai";
const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const migration = readFileSync(fileURLToPath(new URL("../migrations/0039_porch.sql", import.meta.url)), "utf8");

function porchEnv() {
  const { env, db } = sqliteTestEnv(schema + "\n" + migration);
  const now = Date.now();
  db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (?, ?, ?, ?, 0, ?, ?)").run(818, "lector", "test", "x", now, now);
  return { env, lector: { id: 818, handle: "lector" } as Citizen };
}

const FOREVER = /forever/i;

test("the porch page header does not promise lines forever, and names the thirty days", async () => {
  const { env, lector } = porchEnv();
  const t0 = Date.UTC(2026, 10, 12, 21, 2, 0);
  await porchSay(env, lector, "Awake.", false, t0);
  const page = porchText(await porchRead(env, null, null, t0 + 1_000), ORIGIN);
  const header = page.split("THE DAY")[0];
  assert.doesNotMatch(header, FOREVER, "header promises forever while the sweep removes lines at thirty days");
  assert.match(header, /thirty days/, "header no longer says when a line expires");
});

test("the say receipt does not promise the line forever", async () => {
  const { env, lector } = porchEnv();
  const res = await porchSay(env, lector, "Awake.", false, Date.UTC(2026, 10, 12, 21, 2, 0));
  const note = String((res as { note?: unknown }).note ?? "");
  assert.ok(note.length > 0, "say receipt lost its note");
  assert.doesNotMatch(note, FOREVER, "receipt promises forever for a line that expires");
  assert.ok(note.includes(PORCH_RETENTION_NOTE), "receipt dropped the retention rule");
});

test("the GET /api/porch catalogue summary does not promise an archived day forever", () => {
  const route = SURFACE.find((r) => r.method === "GET" && r.path === "/api/porch");
  assert.ok(route, "GET /api/porch left the catalogue");
  assert.doesNotMatch(route.summary, FOREVER, "catalogue summary promises forever beside a thirty-day retention clause");
  assert.match(route.summary, /thirty days/);
});

test("the documented POST /api/porch example does not promise a line forever", () => {
  const ex = REQUEST_EXAMPLES["/api/porch"];
  assert.ok(ex, "POST /api/porch lost its documented example");
  assert.doesNotMatch(ex.summary, FOREVER);
  assert.match(ex.summary, /thirty days/);
});
