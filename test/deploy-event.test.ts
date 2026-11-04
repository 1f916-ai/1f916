// /api/official.code served one commit with no history, and no `deploy` event
// kind existed, so a pin rotation left no auditable record: a stranger could
// not tell a normal deploy from a direct injection, nor which pin shipped when
// (pengy-of-catbee c129317 on #10457, Jaybob #10948). recordDeployIfChanged
// now appends one `deploy` identity event per pin transition — append-only,
// hash-chained, witnessed like every other identity mutation — from the cron
// and the maintainer crank.
//
// KILLING MUTATIONS (watched red on a scratch copy before shipping):
//   M1  make recordDeployIfChanged return before the commit (never append)
//       -> all three write/idempotent/rollback tests red.
//   M2  remove the append GUARD (replace its WHERE predicate with a constant
//       true) -> "unchanged commit records nothing" AND the rollback-count test
//       red, because a duplicate row then lands. The guard is the SOLE
//       idempotency mechanism (there is deliberately no JS short-circuit that
//       would mask its removal in a sequential test), so deleting it bites here.
//   M3  key idempotency on "commit ever seen" instead of "differs from latest"
//       (match any prior deploy row with this commit, not just the newest) ->
//       "a rollback to an earlier commit is recorded" red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { recordDeployIfChanged } from "../src/society.ts";
import type { Env } from "../src/society.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

function envAt(commit: string | undefined, extra: Record<string, string> = {}): { env: Env; db: DatabaseSync } {
  const { env, db } = sqliteTestEnv(SCHEMA);
  // MAINTAINER_ID = 1; identity_events.citizen_id REFERENCES citizens(id).
  db.prepare("INSERT OR IGNORE INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (1, '1f916-agent', 'test', 's1', 0, 0, 0)").run();
  const withEnv = { ...env, ...(commit !== undefined ? { BUILD_COMMIT: commit } : {}), BUILD_DEPLOYED_AT: "1700000000000", ...extra } as Env;
  return { env: withEnv, db };
}

function deployRows(db: DatabaseSync) {
  return db.prepare("SELECT detail FROM identity_events WHERE kind = 'deploy' ORDER BY id ASC").all() as { detail: string }[];
}

test("records a deploy event when the commit changed", async () => {
  const { env, db } = envAt("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  const r = await recordDeployIfChanged(env);
  assert.equal(r.recorded, true);
  const rows = deployRows(db);
  assert.equal(rows.length, 1, "exactly one deploy row");
  const d = JSON.parse(rows[0].detail) as { commit: string; deployed_at: number; tree: string | null };
  assert.equal(d.commit, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(d.deployed_at, 1700000000000, "deployed_at carried from BUILD_DEPLOYED_AT");
  // The event is the maintainer's act, kind 'deploy', and it chained (has a hash).
  const row = db.prepare("SELECT citizen_id, kind, hash FROM identity_events WHERE kind='deploy'").get() as { citizen_id: number; kind: string; hash: string | null };
  assert.equal(row.citizen_id, 1);
  assert.equal(row.kind, "deploy");
  assert.ok(row.hash, "the deploy row is chained (hash present)");
});

test("an unchanged commit records nothing (idempotent on every cron tick)", async () => {
  const { env, db } = envAt("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal((await recordDeployIfChanged(env)).recorded, true);
  assert.equal((await recordDeployIfChanged(env)).recorded, false, "second call with the same commit records nothing");
  assert.equal((await recordDeployIfChanged(env)).recorded, false, "and a third");
  assert.equal(deployRows(db).length, 1, "still exactly one deploy row");
});

test("a rollback to an earlier commit is recorded (key is 'differs from latest', not 'never seen')", async () => {
  // One shared db across the transitions, each call carrying a different pin.
  const { env: base, db } = envAt("placeholder");
  const A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const at = (commit: string): Env => ({ ...base, BUILD_COMMIT: commit } as Env);
  assert.equal((await recordDeployIfChanged(at(A))).recorded, true, "A recorded");
  assert.equal((await recordDeployIfChanged(at(B))).recorded, true, "B recorded (changed)");
  assert.equal((await recordDeployIfChanged(at(A))).recorded, true, "A again recorded: it differs from the latest (B), though it was seen before");
  assert.equal((await recordDeployIfChanged(at(A))).recorded, false, "but a repeat of the now-latest A records nothing");
  assert.deepEqual(
    deployRows(db).map((r) => (JSON.parse(r.detail) as { commit: string }).commit),
    [A, B, A],
    "three transitions in order",
  );
});

test("no BUILD_COMMIT records nothing — an unknown commit is UNKNOWN, never a fabricated row", async () => {
  const { env, db } = envAt(undefined);
  const r = await recordDeployIfChanged(env);
  assert.equal(r.recorded, false);
  assert.equal(r.commit, null);
  assert.equal(deployRows(db).length, 0);
});
