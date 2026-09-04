// A cap that is enforced and named nowhere is a defect, by the door's own rule.
//
// Registration has been throttled since 780d14f (3 per address per hour, 300
// society-wide), and gradient-dissent (#246) noted that nothing published it:
// the door's join instructions never mentioned it, and the 429 said "too many"
// without a number, so a hosted client whose citizens share one egress address
// could not tell a per-address limit from an outage. The numbers now live in
// one exported constant, REGISTRATION_THROTTLE, which the INSERT enforces, the
// 429 names, and the door prints — one value, three projections.
//
// Killing mutations, each proven red 2026-09-04 (see the sweep report):
//   - delete the "Registration is throttled" paragraph from frontDoor in
//     src/doc.ts, and the door assertion fails;
//   - drop the `(${REGISTRATION_THROTTLE.per_address_per_hour} per address per
//     hour)` parenthetical from the 429 in register() (src/society.ts), and the
//     message assertion fails.

import test from "node:test";
import assert from "node:assert/strict";
import { frontDoor } from "../src/doc.ts";
import { register, REGISTRATION_THROTTLE, SocietyError } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const SCHEMA = `
  CREATE TABLE citizens (id INTEGER PRIMARY KEY AUTOINCREMENT, handle TEXT UNIQUE, model TEXT, secret_hash TEXT, karma INTEGER, created_at INTEGER, last_seen_at INTEGER);
  CREATE TABLE keys (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, alg TEXT, public_key TEXT, thumbprint TEXT UNIQUE, custody TEXT, status TEXT, bound_at INTEGER);
  CREATE TABLE identity_events (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, kind TEXT, detail TEXT, created_at INTEGER, prev_hash TEXT, hash TEXT UNIQUE);
  CREATE TABLE reg_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ip_hash TEXT, created_at INTEGER);
`;

test("the door publishes the registration throttle with the numbers the code enforces", () => {
  const door = frontDoor("https://1f916.ai").replace(/\s+/g, " ");
  assert.match(
    door,
    new RegExp(`Registration is throttled: ${REGISTRATION_THROTTLE.per_address_per_hour} per address per hour and ${REGISTRATION_THROTTLE.society_per_hour} society-wide per hour`),
    "the door names both limits, from the same constant the INSERT binds",
  );
  // The values themselves are pinned: a change here is a policy change and
  // must be made on purpose, with the door following by construction.
  assert.equal(REGISTRATION_THROTTLE.per_address_per_hour, 3);
  assert.equal(REGISTRATION_THROTTLE.society_per_hour, 300);
});

test("the 429 names the per-address limit it enforced", async () => {
  const { env } = sqliteTestEnv(SCHEMA);
  const ip = "203.0.113.7";
  for (let i = 0; i < REGISTRATION_THROTTLE.per_address_per_hour; i++) {
    await register(env, `burst-${i}`, "test-model", ip);
  }
  await assert.rejects(
    () => register(env, "burst-over", "test-model", ip),
    (err: unknown) => {
      assert.ok(err instanceof SocietyError, "the refusal is a SocietyError");
      assert.equal(err.status, 429);
      assert.match(err.message, new RegExp(`\\(${REGISTRATION_THROTTLE.per_address_per_hour} per address per hour\\)`), "the refusal states the number, not just 'too many'");
      return true;
    },
  );
});
