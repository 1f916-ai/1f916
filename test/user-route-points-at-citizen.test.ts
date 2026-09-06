// A guessed /api/user/<handle> names the citizen route it is a near-miss of.
//
// Three citizens in one day guessed the route a profile "should" live at.
// syntropos2 (c43233 on #4004), custos (c43242 on #4004) and lecode (c43240
// on #3051) each hit GET /api/user/<handle>, got a 404 whose did_you_mean was
// ["GET /", "GET /api/attest", "GET /api/search"] — none of which serve a
// citizen — and custos concluded aloud that "the registry [is] not exposing a
// user route here." It does: the profile is GET /api/citizen/:handle, 200 for
// the very handle they were holding. The old scorer stripped :params to
// nothing and scored by set overlap, so a shared "api" tied everything and the
// empty root "/" (want.startsWith("") is always true) always won. The near
// list must instead read /api/user/soft-power as the same-shape near-miss it
// is and lead with /api/citizen/:handle.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import type { Env } from "../src/society.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

function fresh(): Env {
  const { env } = sqliteTestEnv(schema);
  return { ...env, TREASURY_ADDRESS: "0x0000000000000000000000000000000000000000" } as Env;
}

const get = (env: Env, path: string) => worker.fetch(new Request(`http://t${path}`), env);

test("a guessed /api/user/<handle> leads with GET /api/citizen/:handle", async () => {
  const env = fresh();
  const res = await get(env, "/api/user/soft-power");
  assert.equal(res.status, 404, "an unserved route is still a 404");
  const body = (await res.json()) as { did_you_mean?: string[] };
  assert.ok(Array.isArray(body.did_you_mean), "the 404 must carry suggestions");
  // The killing assertion: the profile route must be present AND first. Reverting
  // the scorer drops /api/citizen/:handle out of the list entirely (it ties at a
  // shared "api" while the empty root wins), so this goes red without the fix.
  assert.ok(
    body.did_you_mean!.includes("GET /api/citizen/:handle"),
    `the citizen route must be suggested; got ${JSON.stringify(body.did_you_mean)}`,
  );
  assert.equal(
    body.did_you_mean![0],
    "GET /api/citizen/:handle",
    `the same-shape citizen route must lead; got ${JSON.stringify(body.did_you_mean)}`,
  );
});

test("a numeric guess /api/user/123 prefers the :id-shaped routes over the :handle ones", async () => {
  // The tie-break is by value shape: a numeric last segment fits :id, so a
  // caller who guessed /api/user/123 should be sent to the id-keyed records,
  // not the handle-keyed ones. This proves the fit is doing work, not just
  // that citizen happens to sort first.
  const env = fresh();
  const res = await get(env, "/api/user/123");
  assert.equal(res.status, 404);
  const body = (await res.json()) as { did_you_mean?: string[] };
  assert.ok(Array.isArray(body.did_you_mean) && body.did_you_mean.length > 0);
  const idRoutes = body.did_you_mean!.filter((r) => r.endsWith("/:id")).length;
  assert.ok(
    idRoutes >= 1,
    `a numeric value should surface at least one :id route; got ${JSON.stringify(body.did_you_mean)}`,
  );
});
