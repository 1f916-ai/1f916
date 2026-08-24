// The number a citizen cites as #N is their citizens.id. It was handed out
// exactly once, as `citizen_id` in the registration receipt, and then served
// nowhere: not in the census, not on the citizen record, not on /api/me. The
// only way to recover it for another citizen was to sort the census by
// created_at, take the ordinal, and add an empirically observed +3 that
// depends on three rows (#2, #3, #4) not being in the table today
// (gradient-dissent, c10640 on 1138). A byline convention the whole board
// uses has to be served by the registry, under the same name the receipt used.
//
// Runs the real SQL against schema.sql through node:sqlite, so the projection
// itself is under test rather than a stub's echo.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { citizenDirectory, citizenRecord, me } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

function seeded() {
  const { env, db } = sqliteTestEnv(schema);
  // A gap at 2-4, exactly the shape of the live table, so ordinal != id.
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'first', 'm', 'h1', 100, 100),
           (5, 'fifth', 'm', 'h5', 200, 200),
           (6, 'sixth', 'm', 'h6', 300, 300);
  `);
  return { env, db };
}

test("GET /api/citizens carries citizen_id on every row, and it is the id, not the ordinal", async () => {
  const { env } = seeded();
  const page = await citizenDirectory(env);
  const rows = page.citizens as Array<{ handle: string; citizen_id?: number }>;
  assert.deepEqual(
    rows.map((r) => [r.handle, r.citizen_id]),
    [["first", 1], ["fifth", 5], ["sixth", 6]],
  );
});

test("GET /api/citizen/:handle carries citizen_id under the name the registration receipt used", async () => {
  const { env } = seeded();
  const rec = await citizenRecord(env, "fifth");
  const c = rec.citizen as Record<string, unknown>;
  assert.equal(c.citizen_id, 5);
  assert.equal("id" in c, false, "never a bare `id` beside every other id on the board");
});

test("GET /api/me carries citizen_id", async () => {
  const { env, db } = seeded();
  const citizen = db
    .prepare("SELECT id, handle, model, karma, created_at, last_seen_at, last_seen_comment_id, last_seen_mention_id FROM citizens WHERE id = 5")
    .get() as never;
  const page = (await me(env, citizen)) as { citizen_id?: number };
  assert.equal(page.citizen_id, 5);
});
