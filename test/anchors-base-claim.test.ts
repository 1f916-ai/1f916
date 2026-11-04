// A pass claims a checkpoint's Base send before it sends.
//
// Two scheduled passes that overlap each read the anchors table before either
// has written its transaction hash, and each sent a Base transaction for the
// same checkpoint (live: checkpoint 41777, rows 16901/16902; checkpoint 42953,
// rows 18392/18393; found by kerf-and-chatter on #9938, c121093). Each pass now
// claims the checkpoint in anchor_base_claims first and sends only if it won.
// The constraints kerf-and-chatter set in c121105 are the other arms: a failed
// send still retries after BASE_RETRY_MS, a claim whose pass died is taken over
// once stale, and a row written by a pass that finished first still blocks.
//
// Killing mutations, each applied to src/anchors.ts:
//   - no-claim (the unpatched behavior): claimBase returns true: tests 1, 3, 4, 5 red.
//   - claim-never-stale: the upsert's WHERE compares against 0: tests 2 and 3 red.
//   - claim-always-stale: the upsert has no WHERE: tests 1, 3, 5 red.
//   - no-reread: claimBase skips the fresh Base-row read: test 4 red.
//   - lost-claim-tries-next: a lost claim leaves baseSent false: test 5 red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { anchorCheckpoints, OTS_CALENDARS, BASE_RETRY_MS, BASE_CLAIM_STALE_MS, type AnchorDeps } from "../src/anchors.ts";
import type { Env } from "../src/society.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ROOT = "e2bbc6d49fb5b3e92b7574aa22b0374ff29db80207219de9bba33e5901d78fde";
const T0 = 1_792_100_000_000;
const KEY = "0x" + "11".repeat(32);
const MIN = 60_000;
const hash = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const dead = (async () => new Response("", { status: 500 })) as typeof fetch;

// Checkpoints whose calendar and archive rows already exist, so the only due
// attempt is each checkpoint's Base send. `withOts: false` leaves the calendar
// rows out, so the pass calls fetch before reaching Base.
function fixture(ids: number[], withOts = true) {
  const { env, db } = sqliteTestEnv(SCHEMA);
  for (const id of ids) {
    db.exec(`INSERT INTO checkpoints (id, log, tree_size, root, sig, created_at) VALUES (${id}, ${id === ids[0] ? "'identity_events'" : "'ledger'"}, ${id}, '${ROOT}', 's', ${T0 - MIN})`);
    if (withOts) for (const cal of OTS_CALENDARS) db.exec(`INSERT INTO anchors (checkpoint_id, kind, target, status, created_at) VALUES (${id}, 'ots', '${cal}', 'confirmed', ${T0 - MIN})`);
    db.exec(`INSERT INTO anchors (checkpoint_id, kind, target, status, created_at) VALUES (${id}, 'archive', 'https://web.archive.org/web/x', 'confirmed', ${T0 - MIN})`);
  }
  return { env: { ...env, ANCHOR_BASE_KEY: KEY } as Env, db };
}

function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}

function sender(sent: string[], wait?: Promise<void>): AnchorDeps["submitBase"] {
  return async (_env, payload) => {
    sent.push(payload);
    if (wait) await wait;
    return hash(sent.length);
  };
}

const baseRows = (db: ReturnType<typeof sqliteTestEnv>["db"], id: number) =>
  db.prepare("SELECT target, status FROM anchors WHERE checkpoint_id = ? AND kind = 'base' ORDER BY id").all(id) as { target: string; status: string }[];

test("two_overlapping_passes_must_send_one_base_transaction_for_one_checkpoint", async () => {
  const { env, db } = fixture([1]);
  const sent: string[] = [];
  const g = gate();
  const deps: AnchorDeps = { fetch: dead, submitBase: sender(sent, g.p), confirmBase: async () => "pending" };
  const a = anchorCheckpoints(env, T0, deps);
  const b = anchorCheckpoints(env, T0 + 1_000, deps);
  // let both passes run up to the send before the first one returns
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
  g.open();
  await Promise.all([a, b]);
  assert.equal(sent.length, 1, "exactly one submitBase across the two passes");
  assert.equal(baseRows(db, 1).length, 1, "one Base row for the checkpoint");
});

test("a_checkpoint_whose_only_base_row_failed_over_an_hour_ago_must_still_get_one_send", async () => {
  // with the failed pass's claim still on file, and with none (failed before 0081)
  for (const claim of [true, false]) {
    const { env, db } = fixture([1]);
    const failedAt = T0 - BASE_RETRY_MS - MIN;
    db.exec(`INSERT INTO anchors (checkpoint_id, kind, target, status, error, created_at, failed_at) VALUES (1, 'base', 'failed:${failedAt}', 'failed', 'nonce too low', ${failedAt}, ${failedAt})`);
    if (claim) db.exec(`INSERT INTO anchor_base_claims (checkpoint_id, claimed_at) VALUES (1, ${failedAt})`);
    const sent: string[] = [];
    await anchorCheckpoints(env, T0, { fetch: dead, submitBase: sender(sent), confirmBase: async () => "pending" });
    assert.equal(sent.length, 1, `retry sends once (claim on file: ${claim})`);
    assert.deepEqual(baseRows(db, 1).map((r) => r.status), ["failed", "pending"]);
  }
});

test("a_claim_whose_pass_died_must_block_while_fresh_and_be_taken_over_once_stale", async () => {
  for (const [age, expect] of [[MIN, 0], [BASE_CLAIM_STALE_MS - 1, 0], [BASE_CLAIM_STALE_MS + 1, 1]] as const) {
    const { env, db } = fixture([1]);
    db.exec(`INSERT INTO anchor_base_claims (checkpoint_id, claimed_at) VALUES (1, ${T0 - age})`);
    const sent: string[] = [];
    await anchorCheckpoints(env, T0, { fetch: dead, submitBase: sender(sent), confirmBase: async () => "pending" });
    assert.equal(sent.length, expect, `claim ${age} ms old`);
    assert.equal(baseRows(db, 1).length, expect);
    const claimedAt = (db.prepare("SELECT claimed_at FROM anchor_base_claims WHERE checkpoint_id = 1").get() as { claimed_at: number }).claimed_at;
    assert.equal(claimedAt, expect ? T0 : T0 - age, "a lost claim leaves the holder's instant alone");
  }
});

test("a_base_row_written_after_this_pass_read_the_table_must_still_block_its_send", async () => {
  // B reads the anchors table, then stalls at the calendars; A runs whole and
  // records its transaction; B resumes after A's claim has gone stale.
  const { env, db } = fixture([1], false);
  const sentA: string[] = [];
  const sentB: string[] = [];
  const g = gate();
  const stalled = (async () => { await g.p; return new Response("", { status: 500 }); }) as unknown as typeof fetch;
  const b = anchorCheckpoints(env, T0 + BASE_CLAIM_STALE_MS + MIN, { fetch: stalled, submitBase: sender(sentB), confirmBase: async () => "pending" });
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  await anchorCheckpoints(env, T0, { fetch: dead, submitBase: sender(sentA), confirmBase: async () => "pending" });
  assert.equal(sentA.length, 1);
  g.open();
  await b;
  assert.equal(sentB.length, 0, "B re-reads the checkpoint's Base rows after claiming");
  assert.equal(baseRows(db, 1).length, 1);
});

test("a_pass_that_loses_a_claim_must_send_no_base_that_pass", async () => {
  // checkpoint 1 is held by a fresh claim; checkpoint 2 is free
  const { env, db } = fixture([1, 2]);
  db.exec(`INSERT INTO anchor_base_claims (checkpoint_id, claimed_at) VALUES (1, ${T0 - MIN})`);
  const sent: string[] = [];
  await anchorCheckpoints(env, T0, { fetch: dead, submitBase: sender(sent), confirmBase: async () => "pending" });
  assert.equal(sent.length, 0, "one Base attempt per pass, even when the claim is lost");
  assert.equal(baseRows(db, 2).length, 0);
});
