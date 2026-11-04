// A failed anchor row serves when this server recorded it failed.
//
// A row's created_at is when the attempt was made; a Base transaction that the
// node never mines, or an archive job the archive later refuses, is recorded
// failed by a later confirmation pass, sometimes days later (live: row 14583,
// sent 2026-10-15, settled failed by the 2026-10-24T23:15:53Z pass). Nothing
// on the row said when that happened, so "when did this fail" was answerable
// only by having watched the table. Each write that sets status 'failed' now
// stamps failed_at with that pass's clock (created_at for a row refused at
// submission), and the row serves it. It is null on every row that is not
// failed, including a row that sat pending through many asks and then
// confirmed. Offered to kerf-and-chatter on #9938 (c120336); no id-order
// assertion here, per c120360: two rows settled in one pass can carry
// instants a few milliseconds apart, so only the deciding pass is pinned.
//
// Killing mutations, each applied by hand to src/anchors.ts (tests 1-4 were
// red on the unpatched tree first):
//   - stamp-every-touched-pass: stampAsked also writes failed_at = now on
//     every row it asks: test 1 red (a pending row and a later-confirmed row
//     serve a failed_at).
//   - stamp-on-any-settle: the Base receipt UPDATE binds failed_at = now
//     whatever the status: test 1 red (the confirmed row serves one).
//   - dropped-not-stamped: the dropped-transaction UPDATE binds failed_at null: tests 1 and 4 red.
//   - reverted-not-stamped: the receipt UPDATE binds null for status failed: test 1 red.
//   - archive-poll-not-stamped: the archive job UPDATE binds null for failed: test 2 red.
//   - insert-not-stamped: insertAnchor binds failed_at null always: test 3 red.
//   - not-served: listAnchors drops failed_at from the paged rows: tests 1, 2, 3 red.
//   - latest-not-served: the latest-checkpoint select drops failed_at: test 4 red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { anchorCheckpoints, listAnchors, OTS_CALENDARS, BASE_DROPPED_MS, type AnchorDeps } from "../src/anchors.ts";
import type { Env } from "../src/society.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ROOT = "e2bbc6d49fb5b3e92b7574aa22b0374ff29db80207219de9bba33e5901d78fde";
const T0 = 1_792_100_000_000;
const DAY = 86_400_000;
const PASS = 300_000;
const KEY = "0x" + "11".repeat(32);
const hash = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const noSend = async () => { throw new Error("no send expected"); };
const dead = (async () => new Response("", { status: 500 })) as typeof fetch;

type Served = Record<string, unknown> & { id: number };
async function servedRows(env: Env): Promise<Map<number, Served>> {
  const body = await listAnchors(env, undefined);
  return new Map((body.anchors as Served[]).map((a) => [a.id, a]));
}

// Checkpoints whose calendar and archive rows exist (confirmed), so a pass
// sends nothing new and only the confirmation loops run.
function settledFixture(baseIds: number[], baseCreated: (id: number) => number) {
  const { env, db } = sqliteTestEnv(SCHEMA);
  for (const id of baseIds) {
    db.exec(`INSERT INTO checkpoints (id, log, tree_size, root, sig, created_at) VALUES (${id}, 'identity_events', ${id}, '${ROOT}', 's', ${T0 - 9 * DAY})`);
    db.exec(`INSERT INTO anchors (id, checkpoint_id, kind, target, status, created_at) VALUES (${id}, ${id}, 'base', '${hash(id)}', 'pending', ${baseCreated(id)})`);
  }
  for (const id of baseIds) {
    for (const cal of OTS_CALENDARS) db.exec(`INSERT INTO anchors (checkpoint_id, kind, target, status, created_at) VALUES (${id}, 'ots', '${cal}', 'confirmed', ${T0})`);
    db.exec(`INSERT INTO anchors (checkpoint_id, kind, target, status, created_at) VALUES (${id}, 'archive', 'https://web.archive.org/web/x', 'confirmed', ${T0})`);
  }
  return { env, db };
}

test("a_base_row_settled_failed_must_serve_the_deciding_pass_and_no_other_row_may", async () => {
  // 1: dropped (node never heard of it), old enough on the first pass.
  // 2: reverted receipt, answered on the second pass.
  // 3: pending on the first pass, mined on the second.
  // 4: pending on every ask.
  const { env } = settledFixture([1, 2, 3, 4], () => T0 - 8 * DAY);
  const answers: Record<number, (pass: number) => Awaited<ReturnType<AnchorDeps["confirmBase"]>>> = {
    1: () => "unknown",
    2: (pass) => (pass === 0 ? "pending" : { status: "failed", block_number: 52_638_700 }),
    3: (pass) => (pass === 0 ? "pending" : { status: "confirmed", block_number: 52_638_732 }),
    4: () => "pending",
  };
  let pass = 0;
  const deps: AnchorDeps = { fetch: dead, submitBase: noSend, confirmBase: async (_e, target) => answers[parseInt(target, 16)](pass) };
  const baseEnv = { ...env, ANCHOR_BASE_KEY: KEY } as Env;
  for (pass = 0; pass < 4; pass++) await anchorCheckpoints(baseEnv, T0 + pass * PASS, deps);
  const rows = await servedRows(env);
  assert.equal(rows.get(1)!.status, "failed");
  assert.equal(rows.get(1)!.failed_at, T0, "the dropped row serves the pass that recorded it failed, not created_at");
  assert.equal(rows.get(2)!.status, "failed");
  const reverted = rows.get(2)!.failed_at as number;
  assert.ok(reverted > T0 && reverted <= T0 + 3 * PASS, `the reverted row serves a pass after the first ask that left it pending (got ${reverted})`);
  assert.equal(reverted, rows.get(2)!.last_asked_at, "and it is the pass that asked and got the answer");
  assert.equal(rows.get(3)!.status, "confirmed");
  assert.equal(rows.get(3)!.failed_at, null, "a row that was pending through asks and then confirmed never failed");
  assert.equal(rows.get(4)!.status, "pending");
  assert.ok(rows.get(4)!.last_asked_at !== null, "the pending row was asked");
  assert.equal(rows.get(4)!.failed_at, null, "being asked is not failing");
  for (const r of rows.values()) if (r.status !== "failed") assert.equal(r.failed_at, null, `row ${r.id} (${r.status}) serves null, not an absent key`);
});

test("an_archive_job_the_archive_refused_must_serve_when_it_was_read", async () => {
  const fx = sqliteTestEnv(SCHEMA);
  fx.db.exec(`INSERT INTO checkpoints (id, log, tree_size, root, sig, created_at) VALUES (10, 'identity_events', 5, '${ROOT}', 's', ${T0 - DAY})`);
  for (const cal of OTS_CALENDARS) fx.db.exec(`INSERT INTO anchors (checkpoint_id, kind, target, status, created_at) VALUES (10, 'ots', '${cal}', 'confirmed', ${T0})`);
  fx.db.exec(`INSERT INTO anchors (id, checkpoint_id, kind, target, status, created_at) VALUES (301, 10, 'archive', 'https://web.archive.org/save/status/refused', 'pending', ${T0})`);
  const deps: AnchorDeps = {
    fetch: (async () => Response.json({ status: "error", message: "blocked by robots" })) as typeof fetch,
    submitBase: noSend,
    confirmBase: async () => "pending",
  };
  const archEnv = { ...fx.env, ARCHIVE_ORG_ACCESS: "a", ARCHIVE_ORG_SECRET: "s" } as Env;
  await anchorCheckpoints(archEnv, T0 + 2 * PASS, deps);
  const row = (await servedRows(fx.env)).get(301)!;
  assert.equal(row.status, "failed");
  assert.equal(row.failed_at, T0 + 2 * PASS, "the poll that read the refusal is the failure instant");
  assert.equal(row.created_at, T0, "created_at still dates the attempt");
});

test("a_row_refused_at_submission_must_serve_failed_at_equal_to_created_at", async () => {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.exec(`INSERT INTO checkpoints (id, log, tree_size, root, sig, created_at) VALUES (10, 'identity_events', 5, '${ROOT}', 's', ${T0 - DAY})`);
  // Every calendar errors and the Base send throws: each row is born failed.
  const deps: AnchorDeps = { fetch: dead, submitBase: async () => { throw new Error("nonce too low"); }, confirmBase: async () => "pending" };
  await anchorCheckpoints({ ...env, ANCHOR_BASE_KEY: KEY } as Env, T0, deps);
  const rows = [...(await servedRows(env)).values()];
  assert.ok(rows.length >= OTS_CALENDARS.length + 1, `rows recorded: ${rows.length}`);
  for (const r of rows) {
    assert.equal(r.status, "failed", `row ${r.id} (${r.kind})`);
    assert.equal(r.failed_at, r.created_at, `row ${r.id} (${r.kind}) was refused at submission`);
  }
});

test("the_latest_checkpoint_copy_of_a_row_serves_failed_at_and_the_prose_says_what_it_is", async () => {
  const { env } = settledFixture([1], () => T0 - BASE_DROPPED_MS - 1);
  const deps: AnchorDeps = { fetch: dead, submitBase: noSend, confirmBase: async () => "unknown" };
  await anchorCheckpoints({ ...env, ANCHOR_BASE_KEY: KEY } as Env, T0, deps);
  const body = await listAnchors(env, undefined);
  const latest = body.latest_checkpoints[0].anchors as Record<string, unknown>[];
  const base = latest.find((a) => a.kind === "base")!;
  assert.equal(base.status, "failed");
  assert.equal(base.failed_at, T0);
  for (const a of latest.filter((a) => a.kind !== "base")) assert.equal(a.failed_at, null);
  assert.match(body.what_an_anchor_proves, /failed_at/);
});
