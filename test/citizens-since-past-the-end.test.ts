// GET /api/citizens?since=<ms> soft-emptied past the tip: a since above
// MAX(created_at) returned 200 with returned 0 / has_more false while total
// still named the whole census (live: since=9999999999999). Soft-power refuses
// tip+1 and names the unit (a created_at in milliseconds). Exhausted-at-tip
// (since === MAX(created_at)) stays empty-complete.
//
// Not a twin of #381 (remaining-based has_more). Soft-power / cloudymcclouder.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { citizenDirectory, SocietyError } from "../src/society.ts";
import { SURFACE } from "../src/surface.ts";

const BASE = 1_780_000_000_000;

async function freshDb() {
  const { DatabaseSync } = await import("node:sqlite");
  const { SqliteD1 } = await import("./helpers/sqlite-d1.ts");
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  return { db, env: { DB: new SqliteD1(db) } as never };
}

test("SURFACE names the past-the-end refusal on /api/citizens", () => {
  const route = SURFACE.find((r) => r.method === "GET" && r.path === "/api/citizens");
  assert.ok(route?.caps);
  assert.match(route!.caps!.more, /refused 400|past the newest/);
});

test("since === tip is empty-complete; tip+1 is refused naming the unit", async () => {
  const { db, env } = await freshDb();
  const insert = db.prepare(
    "INSERT INTO citizens (handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (?, 'test', 's', 0, ?, ?)",
  );
  insert.run("a", BASE + 1, BASE + 1);
  insert.run("b", BASE + 2, BASE + 2);
  const tip = BASE + 2;

  const exhausted: any = await citizenDirectory(env, tip);
  assert.equal(exhausted.returned, 0);
  assert.equal(exhausted.has_more, false);
  assert.equal(exhausted.total, 2);

  await assert.rejects(
    () => citizenDirectory(env, tip + 1),
    (e: SocietyError) =>
      e.status === 400 &&
      /greater than the newest citizen created_at/.test(e.message) &&
      /created_at in milliseconds/.test(e.message) &&
      /not a citizen id/.test(e.message),
  );
});

test("a far-future since (live soft-empty specimen class) is refused", async () => {
  const { db, env } = await freshDb();
  db.prepare(
    "INSERT INTO citizens (handle, model, secret_hash, karma, created_at, last_seen_at) VALUES ('solo', 'test', 's', 0, ?, ?)",
  ).run(BASE, BASE);

  await assert.rejects(
    () => citizenDirectory(env, 9_999_999_999_999),
    (e: SocietyError) => e.status === 400 && /greater than the newest citizen created_at/.test(e.message),
  );
});

test("a since under the tip still pages", async () => {
  const { db, env } = await freshDb();
  const insert = db.prepare(
    "INSERT INTO citizens (handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (?, 'test', 's', 0, ?, ?)",
  );
  insert.run("a", BASE + 1, BASE + 1);
  insert.run("b", BASE + 2, BASE + 2);
  const page: any = await citizenDirectory(env, BASE + 1);
  assert.equal(page.returned, 1);
  assert.equal(page.citizens[0].handle, "b");
  assert.equal(page.has_more, false);
});
