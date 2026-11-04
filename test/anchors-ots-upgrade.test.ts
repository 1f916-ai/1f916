// The OTS upgrade pass (issue #517): pending OpenTimestamps rows older than an
// hour, OTS_UPGRADES_PER_PASS per pass, oldest first, each asked of its own calendar at the
// address the decoded proof names — GET /timestamp/<attestee-message-hex>,
// where the attestee message is the stored op chain replayed from the digest
// (probed live: calendars 404 a root-digest lookup; PR #648 probe history).
// A calendar answer carrying a BitcoinBlockHeaderAttestation flips the row:
// the completed proof is stored (prefix + stamp-prefix + upgraded terminal
// node), status becomes `confirmed`, and confirmed_at is set. Anything else —
// no attestation yet, a calendar error, an undecodable proof — leaves the row
// exactly as it was for the next pass.
//
// Killing mutations, each checked against a scratch copy of src/anchors.ts:
//   - drop the one-hour age gate: a fresh pending row is upgraded in the same
//     pass that created it, red.
//   - LIMIT ? -> LIMIT 200: all limit+1 pending rows upgrade in one pass, red.
//   - OTS_UPGRADES_PER_PASS back to 2: the backlog outruns the pass, red.
//   - serve the raw calendar response as the whole proof: the served file no
//     longer parses as a detached file (it must be prefix + stamp-prefix +
//     upgraded terminal node), red.
//   - drop stamp.slice(0, decoded.attestationStart) in the splice (`concatBytes(prefix, upgraded)`):
//     the digest-to-commitment op chain vanishes from the stored proof, red.
//   - confirm on a response WITHOUT the attestation tag: a pending row flips
//     on an unmined batch, red.
//   - skip the UPDATE: rows stay pending and ots_upgraded stays 0, red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { anchorCheckpoints, decodeOtsTail, hasBitcoinAttestation, otsFile, sha256Bytes, b64, OTS_UPGRADES_PER_PASS, type AnchorDeps } from "../src/anchors.ts";
import type { Env } from "../src/society.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const ROOT_A = "e2bbc6d49fb5b3e92b7574aa22b0374ff29db80207219de9bba33e5901d78fde";
const ROOT_B = "ce96f39e1f5a53795fb9b505c6c56c053438744fa7df5abd3026de0a7ea541d3";
const T0 = 1_790_000_000_000;
const HOUR = 60 * 60 * 1000;
const CAL = "https://alice.btc.calendar.opentimestamps.org";

// An upgraded terminal node in the format a calendar serves once the batch is
// mined: no ops, then 00, the BitcoinBlockHeaderAttestation tag
// 0588960d73d71901 (python-opentimestamps core/notary.py), and its payload as
// varbytes: length 3, then the block height 900000 as a varuint (a0 f7 36).
const BITCOIN_TAG = [0x05, 0x88, 0x96, 0x0d, 0x73, 0xd7, 0x19, 0x01];
const UPGRADED_NODE = new Uint8Array([0x00, ...BITCOIN_TAG, 0x03, 0xa0, 0xf7, 0x36]);
// The four bytes 83 df d3 07 are not an OpenTimestamps tag. An answer built
// around them is not a Bitcoin attestation and must not confirm a row.
const NOT_A_TAG_NODE = new Uint8Array([0x00, 0x83, 0xdf, 0xd3, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x87, 0x6d, 0x2c]);
// Same shape, no attestation: the calendar still holds only a pending one.
const PENDING_NODE = (() => {
  const uri = new TextEncoder().encode(CAL);
  const out = new Uint8Array(1 + 8 + 1 + uri.length);
  out[0] = 0x00;
  out.set([0x83, 0xdf, 0xe3, 0x0d, 0x2e, 0xf9, 0x0c, 0x8e], 1);
  out[9] = uri.length;
  out.set(uri, 10);
  return out;
})();

function fixture(rows: { id: number; checkpoint: number; target: string; proof: string; age_ms: number }[]) {
  const { env, db } = sqliteTestEnv(SCHEMA);
  db.exec(`INSERT INTO checkpoints (id, log, tree_size, root, sig, created_at) VALUES
    (10, 'identity_events', 5, '${ROOT_A}', 'sigA', ${T0 - 1000}),
    (11, 'ledger', 2, '${ROOT_B}', 'sigB', ${T0 - 900})`);
  // An archive row fresh at T0 keeps the 55-minute archive gate shut, so the
  // pass exercises only the OTS paths under test. Explicit ids: the ots rows
  // below are addressed by id in the assertions.
  db.exec(`INSERT INTO anchors (id, checkpoint_id, kind, target, proof, status, error, created_at, confirmed_at)
           VALUES (100, 10, 'archive', 'attempt:x', NULL, 'failed', 'gate', ${T0}, NULL);`);
  for (const r of rows) {
    db.exec(`INSERT INTO anchors (id, checkpoint_id, kind, target, proof, status, error, created_at, confirmed_at)
             VALUES (${r.id}, ${r.checkpoint}, 'ots', '${r.target}', '${r.proof}', 'pending', NULL, ${T0 - r.age_ms}, NULL);`);
  }
  return { env, db };
}

// Non-empty digest-to-commitment op chain (append 0x41 -> sha256 -> prepend 0x4243 -> sha256)
// before the terminal pending node, matching the shape real calendars return.
const OP_CHAIN = new Uint8Array([0xf0, 0x01, 0x41, 0x08, 0xf1, 0x02, 0x42, 0x43, 0x08]);

async function seedProof(digestSeed: number): Promise<{ proof: string; digest: Uint8Array; attestee: Uint8Array; prefix: Uint8Array }> {
  const digest = await sha256Bytes(`seed-${digestSeed}`);
  const step1 = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array([...digest, 0x41])));
  const attestee = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array([0x42, 0x43, ...step1])));
  const tail = new Uint8Array([...OP_CHAIN, ...PENDING_NODE]);
  const full = otsFile(digest, tail);
  const prefix = full.slice(0, full.length - tail.length);
  return { proof: b64(full), digest, attestee, prefix };
}

function depsWith(upgradeResponse: () => Response, calls: string[]): AnchorDeps {
  return {
    calls,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      // New submissions for checkpoints without anchors still happen in the
      // same pass; serve them a minimal initial timestamp.
      if (url.endsWith("/digest")) return new Response(new Uint8Array([0xf0, 0x08, 0x01]), { status: 200 });
      return upgradeResponse();
    }) as typeof fetch,
    submitBase: async () => {
      throw new Error("submitBase must not be called by the upgrade pass");
    },
    confirmBase: async () => "pending" as const,
  } as AnchorDeps & { calls: string[] };
}

test("decodeOtsTail computes the attestee message of a linear op chain", async () => {
  // digest -> append(0x41) -> sha256 -> prepend(0x42,0x43) -> terminal pending
  const digest = await sha256Bytes("chain-seed");
  const uri = new TextEncoder().encode(CAL);
  const tail = new Uint8Array([0xf0, 0x01, 0x41, 0x08, 0xf1, 0x02, 0x42, 0x43, 0x08, 0x00, ...[0x83, 0xdf, 0xe3, 0x0d, 0x2e, 0xf9, 0x0c, 0x8e], uri.length, ...uri]);
  const decoded = await decodeOtsTail(tail, digest);
  assert.ok(decoded, "a linear chain must decode");
  // attestee message: the ops are append(0x41) -> sha256 -> prepend(0x4243)
  // -> sha256, so the intermediate hash after the first sha256 is load-bearing.
  const step1 = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array([...digest, 0x41])));
  const step2 = new Uint8Array([0x42, 0x43, ...step1]);
  const expected = new Uint8Array(await crypto.subtle.digest("SHA-256", step2));
  assert.deepEqual([...decoded.attesteeMsg], [...expected]);
  assert.equal(decoded.attestationStart, 9);
});

test("decodeOtsTail refuses shapes the pass must not rewrite", async () => {
  const digest = await sha256Bytes("refuse-seed");
  const uri = new TextEncoder().encode(CAL);
  const pendTag = [0x83, 0xdf, 0xe3, 0x0d, 0x2e, 0xf9, 0x0c, 0x8e];
  // A branch separator: not produced by a direct digest submission.
  assert.equal(await decodeOtsTail(new Uint8Array([0xff, 0x08, 0x00, ...pendTag, uri.length, ...uri]), digest), null);
  // Already-terminal bitcoin attestation instead of a pending one.
  assert.equal(await decodeOtsTail(new Uint8Array([0x00, ...BITCOIN_TAG, 0x03, 0xa0, 0xf7, 0x36]), digest), null);
  // Unsupported op.
  assert.equal(await decodeOtsTail(new Uint8Array([0x67, 0x00, ...pendTag, uri.length, ...uri]), digest), null);
  // Trailing garbage after the terminal node.
  assert.equal(await decodeOtsTail(new Uint8Array([0x00, ...pendTag, uri.length, ...uri, 0x99]), digest), null);
});

test("a pending OTS row older than an hour upgrades and confirms when the calendar returns a Bitcoin attestation", async () => {
  const { proof, attestee, prefix } = await seedProof(1);
  const { env, db } = fixture([{ id: 1, checkpoint: 10, target: CAL, proof, age_ms: 2 * HOUR }]);
  const calls: string[] = [];
  const report = await anchorCheckpoints(env, T0, depsWith(() => new Response(UPGRADED_NODE, { status: 200 }), calls));

  assert.equal(report.ots_upgraded, 1);
  assert.equal(report.confirmed, 1);
  const stampCalls = calls.filter((c) => c.includes("/timestamp/"));
  assert.deepEqual(stampCalls, [`GET ${CAL}/timestamp/${Buffer.from(attestee).toString("hex")}`]);
  const row = db.prepare("SELECT status, confirmed_at, proof FROM anchors WHERE id = 1").get() as { status: string; confirmed_at: number; proof: string };
  assert.equal(row.status, "confirmed");
  assert.equal(row.confirmed_at, T0);
  // The stored proof must equal prefix + stamp[0:attestationStart] + upgraded
  // byte for byte, preserving the non-empty digest-to-commitment op chain.
  const stored = Buffer.from(row.proof, "base64");
  assert.ok(hasBitcoinAttestation(new Uint8Array(stored)));
  assert.deepEqual([...stored], [...prefix, ...OP_CHAIN, ...UPGRADED_NODE]);
});

test("a calendar answer without a Bitcoin attestation leaves the row pending and untouched", async () => {
  const { proof } = await seedProof(2);
  const { env, db } = fixture([{ id: 1, checkpoint: 10, target: CAL, proof, age_ms: 2 * HOUR }]);
  const calls: string[] = [];
  const report = await anchorCheckpoints(env, T0, depsWith(() => new Response(PENDING_NODE, { status: 200 }), calls));

  assert.equal(report.ots_upgraded, 0);
  assert.equal(report.confirmed, 0);
  const row = db.prepare("SELECT status, confirmed_at, proof FROM anchors WHERE id = 1").get() as { status: string; confirmed_at: number | null; proof: string };
  assert.equal(row.status, "pending");
  assert.equal(row.confirmed_at, null);
  assert.equal(row.proof, proof, "the stored proof must not change without an attestation");
});

test("hasBitcoinAttestation knows the real eight-byte tag and nothing else", () => {
  assert.equal(hasBitcoinAttestation(UPGRADED_NODE), true);
  assert.equal(hasBitcoinAttestation(PENDING_NODE), false);
  assert.equal(hasBitcoinAttestation(NOT_A_TAG_NODE), false);
});

test("an answer carrying the four bytes 83dfd307 instead of the Bitcoin tag leaves the row pending", async () => {
  const { proof } = await seedProof(8);
  const { env, db } = fixture([{ id: 1, checkpoint: 10, target: CAL, proof, age_ms: 2 * HOUR }]);
  const calls: string[] = [];
  const report = await anchorCheckpoints(env, T0, depsWith(() => new Response(NOT_A_TAG_NODE, { status: 200 }), calls));

  assert.equal(report.ots_upgraded, 0);
  const row = db.prepare("SELECT status, proof FROM anchors WHERE id = 1").get() as { status: string; proof: string };
  assert.equal(row.status, "pending");
  assert.equal(row.proof, proof);
});

test("a calendar error leaves the row pending for the next pass and records no failure", async () => {
  const { proof } = await seedProof(3);
  const { env, db } = fixture([{ id: 1, checkpoint: 10, target: CAL, proof, age_ms: 2 * HOUR }]);
  const calls: string[] = [];
  const report = await anchorCheckpoints(env, T0, depsWith(() => new Response("nope", { status: 404 }), calls));

  assert.equal(report.ots_upgraded, 0);
  assert.equal(report.failed, 0, "a dead calendar is an upgrade poll miss, not an anchor failure");
  const row = db.prepare("SELECT status, confirmed_at, error FROM anchors WHERE id = 1").get() as { status: string; confirmed_at: number | null; error: string | null };
  assert.equal(row.status, "pending");
  assert.equal(row.confirmed_at, null);
  assert.equal(row.error, null, "the error column documents the original attempt, not upgrade polls");
});

test("a row younger than the hour gate is not asked", async () => {
  const { proof } = await seedProof(4);
  const { env, db } = fixture([{ id: 1, checkpoint: 10, target: CAL, proof, age_ms: 5 * 60 * 1000 }]);
  const calls: string[] = [];
  const report = await anchorCheckpoints(env, T0, depsWith(() => new Response(UPGRADED_NODE, { status: 200 }), calls));

  assert.equal(report.ots_upgraded, 0);
  assert.equal(calls.filter((c) => c.includes("/timestamp/")).length, 0, "no calendar call for a row inside the age gate");
  const row = db.prepare("SELECT status FROM anchors WHERE id = 1").get() as { status: string };
  assert.equal(row.status, "pending");
});

test("OTS_UPGRADES_PER_PASS rows per pass, oldest first", async () => {
  // One row more than the limit, oldest id first. A row is unique per
  // (checkpoint, kind, target), so each gets its own calendar path.
  const rows = [];
  for (let i = 1; i <= OTS_UPGRADES_PER_PASS + 1; i++) {
    const p = await seedProof(100 + i);
    rows.push({ id: i, checkpoint: i % 2 ? 10 : 11, target: `${CAL}/${i}`, proof: p.proof, age_ms: HOUR + 1 + (OTS_UPGRADES_PER_PASS + 1 - i) * 60_000 });
  }
  const { env, db } = fixture(rows);
  const calls: string[] = [];
  const report = await anchorCheckpoints(env, T0, depsWith(() => new Response(UPGRADED_NODE, { status: 200 }), calls));

  assert.equal(report.ots_upgraded, OTS_UPGRADES_PER_PASS, "exactly the per-pass limit upgrades");
  assert.equal(calls.filter((c) => c.includes("/timestamp/")).length, OTS_UPGRADES_PER_PASS);
  const statuses = db.prepare("SELECT id, status FROM anchors WHERE kind = 'ots' ORDER BY id").all() as { id: number; status: string }[];
  for (const s of statuses) {
    assert.equal(s.status, s.id <= OTS_UPGRADES_PER_PASS ? "confirmed" : "pending", `row ${s.id}`);
  }
});

// The limit has to outrun intake, or a fresh row waits behind the whole
// backlog while its commitment is already in a block. Rows arrive at about
// 1.5 per five-minute pass (three calendars per checkpoint); two slots
// drained a 12,700-row backlog by about 74 a day live. Four slots is the
// least that clears it within a month; the bound above keeps a pass inside
// the cron's shared subrequest budget.
test("the OTS per-pass limit outruns intake and stays inside the subrequest budget", () => {
  const passesPerDay = 24 * 12;
  const intakePerDay = 436;
  const backlog = 12_700;
  const netPerDay = OTS_UPGRADES_PER_PASS * passesPerDay - intakePerDay;
  assert.ok(netPerDay > 0 && backlog / netPerDay <= 30, `backlog would take ${(backlog / netPerDay).toFixed(0)} days to clear`);
  assert.ok(OTS_UPGRADES_PER_PASS <= 16, "each slot is a calendar fetch from the cron's shared budget");
});
