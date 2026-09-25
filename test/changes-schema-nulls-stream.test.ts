// PR 310 review (custos): nulls_total, nulls, nulls_note, and
// next_nulls_since ride every /api/changes response but were absent from
// schemas/changes.json, so a future nulls type change went uncaught. This
// pins the four fields, served in every mode, and validates a live response
// against the schema that now describes them. nulls_total is pinned
// ["integer","null"]: 0 under nulls_since=done at main, null there once PR
// 310 lands.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { validate } from "./helpers/json-schema.ts";
import worker from "../src/index.ts";
import type { Env } from "../src/society.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const changesSchema = JSON.parse(readFileSync(new URL("../schemas/changes.json", import.meta.url), "utf8"));

function fresh() {
  const { db, env } = sqliteTestEnv(schema);
  return { db, env: { ...env, TREASURY_ADDRESS: "0x0000000000000000000000000000000000000000" } as Env };
}

function seedOneNull(db: ReturnType<typeof fresh>["db"]) {
  db.prepare(
    "INSERT INTO nulls (kind, citizen_id, target_type, target_id, reason, status, route, created_at) VALUES (?, NULL, NULL, NULL, ?, 400, ?, ?)",
  ).run("refusal", "seed refusal", "POST /api/test", Date.now());
}

async function page(env: Env, query: string) {
  const res = await worker.fetch(new Request("http://t/api/changes?" + query), env);
  assert.equal(res.status, 200, query);
  return res.json() as Promise<Record<string, unknown>>;
}

test("the schema pins the nulls stream fields the response carries in every mode", () => {
  // Red at main: schemas/changes.json has no entry for any of these four.
  for (const field of ["nulls", "nulls_total", "nulls_note", "next_nulls_since"]) {
    assert.ok(changesSchema.properties[field], "schemas/changes.json describes " + field);
    assert.ok(changesSchema.required.includes(field), field + " is served in every mode (legacy, from, done)");
  }
});

test("a live response validates against the schema, plain call and nulls_since=done", async () => {
  const { db, env } = fresh();
  seedOneNull(db);
  const plain = await page(env, "since=0");
  assert.deepEqual(validate(changesSchema, plain), [], "plain call");
  const done = await page(env, "since=0&nulls_since=done");
  assert.ok(done.nulls_total === 0 || done.nulls_total === null, "silenced: 0 at main, null once PR 310 lands");
  assert.deepEqual(validate(changesSchema, done), [], "nulls_since=done call");
});
