// GET /api/checkpoint serves the latest WRITTEN row per log (ORDER BY id DESC
// LIMIT 1), so on a quiet log both checkpoints[].id and created_at freeze and a
// reader cannot tell an idle chain from a dead checkpointer (kerf-and-chatter,
// post 5294; tally-stick, c60508). The AUTOINCREMENT sequence behind that id
// is charged for every INSERT OR IGNORE the checkpointer attempts, ignored or
// written, so its head moves two per pass whether or not any tree grew. This
// file pins that SQLite behaviour, the field that now serves it, and the cron
// string served beside it (kerf-and-chatter, c60526: the divisor and the
// interval must both be machine-readable, or the two legs of the count can
// drift together silently).
//
// The killing mutation: read MAX(id) instead of sqlite_sequence.seq in
// readCheckpointSequenceHead. Then the head after three quiet passes reads 2,
// not 8, because MAX(id) is exactly the frozen number the field exists to see
// past.

import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import * as checkpoint from "../src/checkpoint.ts";
import * as helpers from "./helpers/sqlite-d1.ts";

// migrations/0014_checkpoints.sql, verbatim: AUTOINCREMENT and the UNIQUE
// pair are the two facts under test.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS checkpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    log TEXT NOT NULL CHECK (log IN ('identity_events','ledger')),
    tree_size INTEGER NOT NULL,
    root TEXT NOT NULL,
    sig TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(log, tree_size)
  );
`;

// The same table without AUTOINCREMENT: SQLite then never creates
// sqlite_sequence and the SELECT raises no-such-table, the same shape as a
// platform refusing the read.
const SCHEMA_NO_SEQUENCE = "CREATE TABLE checkpoints (id INTEGER PRIMARY KEY, log TEXT, tree_size INTEGER, root TEXT, sig TEXT, created_at INTEGER);";

const INSERT = "INSERT OR IGNORE INTO checkpoints (log, tree_size, root, sig, created_at) VALUES (?, ?, ?, ?, ?)";
const MAX_ID = "SELECT MAX(id) AS m FROM checkpoints";
const IDENTITY = "identity_events";
const LEDGER = "ledger";
const ROOT = "r";
const SIG = "s";

const REPO_ROOT = url.fileURLToPath(new URL("../", import.meta.url));
const WRANGLER = fs.readFileSync(path.join(REPO_ROOT, "wrangler.jsonc"), "utf8");
const CRONS = /"crons"\s*:\s*\[([^\]]*)\]/.exec(WRANGLER);

type Harness = ReturnType<typeof helpers.sqliteTestEnv>;

// One checkpointer pass as makeCheckpoints runs it: one INSERT OR IGNORE per
// log, in LOGS order, at whatever tree size each log currently has. Returns
// the number of rows actually written.
async function pass(t: Harness, identitySize: number, ledgerSize: number, at: number): Promise<number> {
  const a = await t.env.DB.prepare(INSERT).bind(IDENTITY, identitySize, ROOT, SIG, at).run();
  const b = await t.env.DB.prepare(INSERT).bind(LEDGER, ledgerSize, ROOT, SIG, at).run();
  return a.meta.changes + b.meta.changes;
}

interface MaxRow {
  m: number;
}

function newestId(t: Harness): number {
  const row = t.db.prepare(MAX_ID).get() as unknown as MaxRow;
  return row.m;
}

function head(t: Harness): Promise<number | null> {
  return checkpoint.readCheckpointSequenceHead(t.env);
}

test("an ignored insert charges the sequence exactly as a written one does", async () => {
  const t = helpers.sqliteTestEnv(SCHEMA);
  assert.equal(await head(t), null); // nothing written yet: sqlite_sequence has no entry for the table
  assert.equal(await pass(t, 10, 5, 1), 2); // first pass: both logs written, ids 1 and 2
  assert.equal(await head(t), 2);
  for (let i = 2; i <= 4; i++) assert.equal(await pass(t, 10, 5, i), 0); // neither tree grew: both inserts ignored
  assert.equal(await head(t), 8); // three quiet passes consumed six values
  assert.equal(newestId(t), 2); // and wrote nothing
  assert.equal(await pass(t, 11, 5, 5), 1); // identity grew: one written, one ignored
  assert.equal(newestId(t), 9); // the written row took the value after the burn, not 3
  assert.equal(await head(t), 10); // and the ignored ledger insert in the same pass took the next one
});

test("the view counts ignored inserts and whole passes since the newest written row", () => {
  const rows = [{ id: 19261 }, { id: 12168 }];
  const v = checkpoint.checkpointSequenceView(19264, rows) as Record<string, unknown>;
  assert.equal(v.recorded, true);
  assert.equal(v.head, 19264);
  assert.equal(v.attempts_per_pass, 2);
  assert.equal(v.attempted_pass_cron, checkpoint.CHECKPOINT_CRON);
  assert.equal(v.newest_written_id, 19261);
  assert.equal(v.ignored_since_newest_written, 3); // the ignored ledger insert in the writing pass, then one quiet pass
  assert.equal(v.passes_since_newest_written, 1);
  const none = checkpoint.checkpointSequenceView(null, rows) as Record<string, unknown>;
  assert.equal(none.recorded, false);
  assert.equal(none.head, undefined); // no number is served when none was read
  assert.equal(none.attempted_pass_cron, checkpoint.CHECKPOINT_CRON); // the schedule is served even when the sequence is not
});

test("the served cron is the cron in wrangler.jsonc, so the two legs of the count cannot drift apart", () => {
  assert.ok(CRONS); // wrangler.jsonc must declare triggers.crons
  assert.ok(CRONS[1].includes(checkpoint.CHECKPOINT_CRON));
});

test("a deployment where sqlite_sequence cannot be read degrades to null, never a throw", async () => {
  const t = helpers.sqliteTestEnv(SCHEMA_NO_SEQUENCE);
  assert.equal(await head(t), null);
});

const ALG = "Ed25519";
const USAGES: KeyUsage[] = ["sign", "verify"];
const PKCS8 = "pkcs8";
const RAW = "raw";
const B64URL = "base64url";
const SEED_SEPARATOR = ".";

test("GET /api/checkpoint serves checkpoint_sequence beside the rows", async () => {
  const kp = (await crypto.subtle.generateKey(ALG, true, USAGES)) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey(PKCS8, kp.privateKey));
  const seed = pkcs8.slice(pkcs8.length - 32);
  const pub = new Uint8Array(await crypto.subtle.exportKey(RAW, kp.publicKey));
  const b64u = (b: Uint8Array) => Buffer.from(b).toString(B64URL);
  const t = helpers.sqliteTestEnv(SCHEMA);
  (t.env as unknown as Record<string, unknown>).REGISTRY_SEED = [b64u(seed), b64u(pub)].join(SEED_SEPARATOR);
  await pass(t, 10, 5, 1);
  await pass(t, 10, 5, 2);
  const cp = (await checkpoint.latestCheckpoints(t.env)) as unknown as Record<string, unknown>;
  const v = cp.checkpoint_sequence as Record<string, unknown>;
  assert.equal(v.recorded, true);
  assert.equal(v.head, 4); // two passes: two written, then two ignored
  assert.equal(v.newest_written_id, 2);
  assert.equal(v.passes_since_newest_written, 1);
  assert.equal((cp.checkpoints as unknown[]).length, 2); // the rows themselves are unchanged
});
