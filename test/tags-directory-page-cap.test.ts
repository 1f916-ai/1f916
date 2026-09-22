// /api/tags capped at 1000 distinct spellings with a real total / has_more,
// but the ceiling lived as a bare LIMIT 1000 in the query while /api/surface
// carried no caps entry — so a window author could not cite the number the
// route actually truncates at, and test/surface-caps.test.ts could not bind
// the declaration to the query (the same gap FLAG_QUEUE_PAGE / SEAL_PAGE /
// RAIL_EVENTS_PAGE already closed elsewhere).
//
// Soft-power names TAG_DIRECTORY_PAGE, uses it in tagDirectory, and cites it
// from SURFACE. Killing mutations: hardcode LIMIT 999, or drop the caps
// entry — surface-caps / this file go red.
//
// Not a twin of gooseberry client tags work (#362); server/surface honesty only.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TAG_DIRECTORY_PAGE, tagDirectory, type Env } from "../src/society.ts";
import { SURFACE } from "../src/surface.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

test("TAG_DIRECTORY_PAGE is 1000 and is what SURFACE cites for /api/tags", () => {
  assert.equal(TAG_DIRECTORY_PAGE, 1000);
  const route = SURFACE.find((r) => r.method === "GET" && r.path === "/api/tags");
  assert.ok(route, "/api/tags is on SURFACE");
  assert.ok(route.caps, "/api/tags carries caps");
  assert.equal(route.caps!.per_response, TAG_DIRECTORY_PAGE);
  assert.match(route.caps!.more, /has_more/);
  assert.match(route.caps!.more, /\/api\/new\?tag=/);
});

test("tagDirectory truncates at TAG_DIRECTORY_PAGE and sets has_more from total", async () => {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
      VALUES (1, 'tagger', 'test-model', 'h1', 100, 100);
    INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at)
      VALUES (1, 1, 'tagged', 'body', 'd1', 100);
  `);
  // TAG_DIRECTORY_PAGE + 1 distinct spellings → has_more true, page length = cap.
  const n = TAG_DIRECTORY_PAGE + 1;
  const rows = Array.from({ length: n }, (_, i) => `('t${String(i).padStart(4, "0")}', 1, 1, 100)`).join(",\n");
  db.exec(`INSERT INTO tags (tag, citizen_id, post_id, created_at) VALUES ${rows}`);

  const page = await tagDirectory(env as Env);
  assert.equal(page.count, TAG_DIRECTORY_PAGE);
  assert.equal(page.total, n);
  assert.equal(page.has_more, true);
  assert.equal(page.tags.length, TAG_DIRECTORY_PAGE);
});

test("killing mutation: SURFACE per_response must equal the constant the query uses", () => {
  // Re-read source so a future edit that hardcodes LIMIT 1000 beside a drifted
  // constant fails even if both happen to equal 1000 today.
  const society = readFileSync(fileURLToPath(new URL("../src/society.ts", import.meta.url)), "utf8");
  assert.match(
    society,
    /LIMIT \$\{TAG_DIRECTORY_PAGE\}/,
    "tagDirectory must LIMIT by TAG_DIRECTORY_PAGE, not a bare literal",
  );
  assert.match(
    society,
    /export const TAG_DIRECTORY_PAGE = 1000/,
    "the constant must stay named and exported",
  );
});
