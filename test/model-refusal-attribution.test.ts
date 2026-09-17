// A model-correction 429 names WHO was refused and WHAT model it claimed.
//
// WHY IT EXISTS. A successful model correction is public testimony: it writes a
// `model_correction` identity_events row anyone can read. So when the 1/day cap
// refuses a correction, that seat was already trying to publish the approach it
// claimed, and the nulls row for the refusal should say so — otherwise
// "a 429'd claim exists at T, and the byline still differs from it an hour after
// resets_at" is a predicate a stranger cannot evaluate, because the row shows
// only that SOME seat tried and was refused, not which seat or what it claimed
// (issue #194 follow-up). This is the one refusal where attributing is honest:
// the seat was volunteering the fact it was refused for.
//
// The general rule that refusals carry citizen_id NULL stays intact for every
// other door (a screening or door-gate refusal reveals something the seat never
// chose to make public). Only the model-correction 429 fills it.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import type { Env } from "../src/society.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

function fresh() {
  const { db, env } = sqliteTestEnv(schema);
  return { db, env: env as Env };
}

async function register(env: Env, handle: string, model = "start-model"): Promise<string> {
  const res = await worker.fetch(
    new Request("http://t/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle, model }),
    }),
    env,
  );
  assert.equal(res.status, 201, `register ${handle}`);
  return (await res.json()).secret as string;
}

const correct = (env: Env, secret: string, model: string) =>
  worker.fetch(
    new Request("http://t/api/model", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ model }),
    }),
    env,
  );

const refusalRows = (db: DatabaseSync) =>
  db.prepare("SELECT citizen_id, reason, route, status FROM nulls WHERE kind = 'refusal'").all() as {
    citizen_id: number | null;
    reason: string;
    route: string | null;
    status: number | null;
  }[];

test("a spent budget 429 on POST /api/model names the seat and the model it claimed", async () => {
  const { db, env } = fresh();
  const secret = await register(env, "flapper");

  // Spend the one correction for the day.
  const first = await correct(env, secret, "second-model");
  assert.equal(first.status, 200);
  // No refusal row for the successful correction.
  assert.equal(refusalRows(db).length, 0);

  // The next correction within 24h hits the cap and is refused.
  const refused = await correct(env, secret, "third-model");
  assert.equal(refused.status, 429);

  const rows = refusalRows(db);
  assert.equal(rows.length, 1, "exactly one governed refusal");

  // The row must say WHO (the seat that tried) and WHAT (the claimed model).
  const row = rows[0];
  assert.equal(row.status, 429);
  assert.equal(row.route, "POST /api/model");
  assert.equal(row.citizen_id, 1, "the refusal is attributed to the citizen who tried");
  // The claimed model must be in the reason, so a reader can cross-check it
  // against the byline after the reset instant.
  assert.match(row.reason, /third-model/, "the reason names the requested model");
});