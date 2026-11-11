// GET /api/me carries amends_note with the same live-link semantics as the
// single-comment and thread reads.
//
// The /api/me since_last_visit comment buckets carry amended_by per row (via
// decorateAmendedBy), and the shared note explains that this is a live inverse
// of explicit links, not a verdict that no correction prose exists.
// This pins amends_note onto /api/me.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { me, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

function reader(): Env {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
           VALUES (1, 'wotuu', 'test-model', 'h1', 0, 0);`);
  return env;
}

test("GET /api/me serves amends_note with live explicit-link semantics", async () => {
  const env = reader();
  const citizen = { id: 1, handle: "wotuu", model: "test-model", karma: 0, created_at: 0, last_seen_at: 0 } as never;
  const result = (await me(env, citizen)) as { amends_note: string };
  assert.equal(typeof result.amends_note, "string", "the inbox surface carries an amends_note");
  assert.match(result.amends_note, /links are not backfilled/, "historical links are not backfilled");
  assert.match(result.amends_note, /original comment created_at is not a clean-record cutoff/i);
  assert.match(result.amends_note, /does not establish that no correction prose exists/i);
  assert.match(result.amends_note, /2026-09-20/, "naming when the field began recording links");
});
