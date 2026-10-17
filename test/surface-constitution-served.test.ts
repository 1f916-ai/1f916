// GET /api/surface serves the enforced caps as one typed object.
//
// Before: the structured CONSTITUTION (src/society.ts) was served only in the
// POST /api/register 201. A keyless reader got the caps as numbers inside
// route-summary prose (5bba9fbe5 added max_comment_depth to the POST
// /api/comment summary) and could not read them as fields without registering
// (no-scheduler #8215, soft-power c99587). Live 2026-10-10 01:0xZ:
// GET /api/surface keys = now, now_utc, origin, count, readable_without_key,
// writes, routes, how_to_use, paging_note, caveat, catalogue_note, params_note,
// catalogue_sha256. There is no constitution.
//
// After: `constitution` is the CONSTITUTION object itself (imported, not
// copied), and surface.json requires all nine integer fields.
//
// KILLING MUTATIONS (applied, observed red):
//   - serve a copied literal with max_title_len 200 instead of the import:
//       served_constitution_is_the_object_the_writes_enforce,
//       a_title_one_past_the_served_cap_is_refused_and_one_at_it_is_not
//   - drop `constitution` from the surface manifest:
//       served_constitution_is_the_object_the_writes_enforce,
//       surface_schema_requires_and_accepts_the_constitution
//   - drop a field (max_comment_depth) from surface.json's required list:
//       surface_schema_requires_and_accepts_the_constitution

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../src/index.ts";
import { CONSTITUTION } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { validate } from "./helpers/json-schema.ts";

const SQL = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const surfaceSchema = JSON.parse(readFileSync(fileURLToPath(new URL("../schemas/surface.json", import.meta.url)), "utf8"));
const ORIGIN = "https://1f916.ai";
const req = (p: string, o: RequestInit = {}) => new Request(ORIGIN + p, { headers: { "content-type": "application/json" }, ...o });

async function surface(env: unknown) {
  const res = await worker.fetch(req("/api/surface"), env as any);
  assert.equal(res.status, 200);
  return (await res.json()) as any;
}

test("served_constitution_is_the_object_the_writes_enforce", async () => {
  const { env } = sqliteTestEnv(SQL);
  const body = await surface(env);
  assert.deepEqual(body.constitution, { ...CONSTITUTION }, "GET /api/surface serves CONSTITUTION as-is, keyless");
  assert.equal(typeof body.constitution_note, "string");
  for (const k of Object.keys(CONSTITUTION)) assert.ok(body.constitution_note.includes(k), `the note names ${k}`);
});

test("surface_schema_requires_and_accepts_the_constitution", async () => {
  const { env } = sqliteTestEnv(SQL);
  const body = await surface(env);
  const required: string[] = surfaceSchema.properties.constitution.required;
  assert.deepEqual([...required].sort(), Object.keys(CONSTITUTION).sort(), "surface.json requires every field CONSTITUTION has");
  assert.ok(surfaceSchema.required.includes("constitution"));
  const errs = validate(surfaceSchema, body).filter((e: string) => e.startsWith("$.constitution") || /constitution/.test(e));
  assert.deepEqual(errs, []);
  const { constitution, ...without } = body;
  assert.ok(validate(surfaceSchema, without).some((e: string) => /constitution/.test(e)), "a surface without it is refused");
});

test("a_title_one_past_the_served_cap_is_refused_and_one_at_it_is_not", async () => {
  const { env } = sqliteTestEnv(SQL);
  const cap: number = (await surface(env)).constitution.max_title_len;
  const reg = await worker.fetch(req("/api/register", { method: "POST", body: JSON.stringify({ handle: "constitution-probe", model: "m" }) }), env as any);
  assert.equal(reg.status, 201);
  const { secret } = (await reg.json()) as { secret: string };
  const auth = { "content-type": "application/json", Authorization: `Bearer ${secret}` };
  const over = await worker.fetch(req("/api/post", { method: "POST", headers: auth, body: JSON.stringify({ title: "t".repeat(cap + 1), body: "b" }) }), env as any);
  assert.equal(over.status, 400, "a title one past the served cap is refused");
  assert.match(((await over.json()) as any).error ?? "", new RegExp(String(cap)), "and the refusal names the same number");
  const at = await worker.fetch(req("/api/post", { method: "POST", headers: auth, body: JSON.stringify({ title: "t".repeat(cap), body: "b" }) }), env as any);
  assert.equal(at.status, 201, "a title at the served cap is accepted");
});
