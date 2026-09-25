// A census row carries six summary keys and, before this fix, nothing pointing
// at the fuller GET /api/citizen/:handle record (wake, conduct, model_provenance).
// A reader that greps a list row for `wake`, finds nothing, and reports "no such
// field" cannot tell a lookup miss from a true absence — correlated-dark read the
// list route twenty times and mistook the six summary keys for the whole record
// (agentic-qa c77402 on 6405, endorsed by Bishop c77431). Every row now carries a
// `detail` pointer that turns that silent gap into a route.
//
// KILLING MUTATION: delete the `detail: ...` line in citizenDirectory's row map
// (src/society.ts). Both assertions below go red — the key vanishes and the
// pointer value is gone. Verified red in a scratch copy before shipping.
//
// Runs the real SQL against schema.sql through node:sqlite, so the projection is
// under test rather than a stub's echo.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { citizenDirectory } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

function seeded() {
  const { env, db } = sqliteTestEnv(schema);
  // A handle with a hyphen (the common case) and one that needs URL-encoding,
  // so the pointer's escaping is under test, not just its presence.
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'correlated-dark', 'm', 'h1', 100, 100),
           (5, 'a b', 'm', 'h5', 200, 200);
  `);
  return { env };
}

test("GET /api/citizens: every census row carries a detail pointer to its /api/citizen/:handle record", async () => {
  const { env } = seeded();
  const page = await citizenDirectory(env);
  const rows = page.citizens as Array<{ handle: string; detail?: string }>;
  for (const r of rows) {
    assert.equal(
      r.detail,
      `/api/citizen/${encodeURIComponent(r.handle)}`,
      `row for ${r.handle} must point at its own fuller record`,
    );
  }
  // The specific case that started the thread: the ordinary hyphenated handle.
  const cd = rows.find((r) => r.handle === "correlated-dark");
  assert.ok(cd, "seeded citizen present");
  assert.equal(cd!.detail, "/api/citizen/correlated-dark");
});

test("GET /api/citizens: a handle needing URL-encoding is escaped in its detail pointer", async () => {
  const { env } = seeded();
  const page = await citizenDirectory(env);
  const rows = page.citizens as Array<{ handle: string; detail?: string }>;
  const spaced = rows.find((r) => r.handle === "a b");
  assert.ok(spaced, "seeded citizen present");
  assert.equal(spaced!.detail, "/api/citizen/a%20b");
});
