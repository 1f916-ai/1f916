// Attacks on the dossier completeness check: each tries to make a dossier that
// is missing an event read ok: true.
//
// Run: npm test
//
// verifyCitizenEvents (src/chain.ts) counts the events held against the
// dossier's signed events_total and walks citizen_seq. These are the ways a
// registry could try to keep the count right while leaving the newest event
// out: pad it with an unsealed (legacy) row, or replace the newest event with
// a made-up one. Each must read false, or at worst null (undetermined), never
// true.

import test from "node:test";
import assert from "node:assert/strict";
import { GENESIS, citizenHistoryNext, citizenHistoryStart, entryHash, rowPayloadVersion, verifyCitizenEvents, type ChainRow } from "../src/chain.ts";

const CID = 42;
const T = 1_790_000_000_000;
const PROOF = ["checked by verify.mjs"];
const CHECKPOINT = { tree_size: 1_000_000, created_at: T + 1000 };

// One citizen's dossier as served: `unsealed` legacy rows (no hash), then
// sealed events, the first `v1` of them v1 and the rest v2. citizen_seq counts
// every earlier event, unsealed ones included, and citizen_history folds them,
// as the write path does. The
// global prev_hash is a stand-in: only the per-citizen fields matter here.
async function dossier(opts: { unsealed: number; v1: number; v2: number }) {
  const out: Record<string, unknown>[] = [];
  let id = 1;
  let count = 0;
  for (let i = 0; i < opts.unsealed; i++) {
    out.push({ id: id++, kind: "register", detail: "legacy", created_at: T + id, prev_hash: null, hash: null, proof: null });
    count++;
  }
  let last = GENESIS;
  let history = await citizenHistoryStart(opts.unsealed);
  for (let i = 0; i < opts.v1 + opts.v2; i++) {
    const prev = "ab".repeat(32);
    const row: ChainRow = {
      id: id++ * 10,
      citizen_id: CID,
      kind: i === opts.v1 + opts.v2 - 1 ? "moderation" : "memory.seal",
      detail: `e${i}`,
      created_at: T + 100 + i,
      prev_hash: prev,
    };
    if (i >= opts.v1) {
      row.citizen_seq = count + 1;
      row.citizen_prev = last;
      row.citizen_history = history;
    }
    row.hash = await entryHash("identity_events", prev, row, rowPayloadVersion("identity_events", row));
    count++;
    last = row.hash as string;
    history = await citizenHistoryNext(history, last);
    const { citizen_id: _c, ...served } = row;
    out.push({ ...served, leaf_index: Number(row.id), proof: PROOF });
  }
  return out;
}

const headOf = (evs: Record<string, unknown>[]) => {
  const v2 = evs.filter((e) => e.citizen_seq != null);
  const h = v2[v2.length - 1];
  return h ? { seq: Number(h.citizen_seq), hash: String(h.hash), event_id: Number(h.id) } : null;
};

test("control: an honest dossier with a legacy unsealed row is ok: true", async () => {
  const evs = await dossier({ unsealed: 1, v1: 1, v2: 3 });
  const r = await verifyCitizenEvents(CID, evs, headOf(evs), { eventsTotal: evs.length, checkpoint: CHECKPOINT });
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("control: the newest event dropped with the head moved back and an honest total reads false", async () => {
  const full = await dossier({ unsealed: 1, v1: 1, v2: 3 });
  const cut = full.slice(0, -1);
  const r = await verifyCitizenEvents(CID, cut, headOf(cut), { eventsTotal: full.length, checkpoint: CHECKPOINT });
  assert.equal(r.ok, false);
});

test("the newest event dropped and the legacy unsealed row duplicated to keep the count is caught", async () => {
  const full = await dossier({ unsealed: 1, v1: 1, v2: 3 });
  const cut = full.slice(0, -1);
  const padded = [cut[0], { ...cut[0] }, ...cut.slice(1)];
  assert.equal(padded.length, full.length);
  const r = await verifyCitizenEvents(CID, padded, headOf(padded), { eventsTotal: full.length, checkpoint: CHECKPOINT });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.ok(r.problems.some((p) => /strictly increase/.test(p)), JSON.stringify(r.problems));
});

test("the newest event dropped and a made-up unsealed row placed first is caught", async () => {
  const full = await dossier({ unsealed: 0, v1: 0, v2: 4 });
  const cut = full.slice(0, -1);
  const padded = [{ id: 3, kind: "register", detail: "x", created_at: T, prev_hash: null, hash: null, proof: null }, ...cut];
  const r = await verifyCitizenEvents(CID, padded, headOf(padded), { eventsTotal: full.length, checkpoint: CHECKPOINT });
  assert.equal(r.ok, false, JSON.stringify(r));
});

test("the newest event dropped and a made-up unsealed row appended after the sealed ones is caught", async () => {
  const full = await dossier({ unsealed: 0, v1: 0, v2: 4 });
  const cut = full.slice(0, -1);
  const padded = [...cut, { id: 999999, kind: "register", detail: "x", created_at: T, prev_hash: null, hash: null, proof: null }];
  const r = await verifyCitizenEvents(CID, padded, headOf(cut), { eventsTotal: full.length, checkpoint: CHECKPOINT });
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.ok(r.problems.some((p) => /unsealed event after a sealed one/.test(p)), JSON.stringify(r.problems));
});

test("the newest event replaced by a made-up one (same seq and link, self-consistent hash, no proof) is never ok: true", async () => {
  const full = await dossier({ unsealed: 0, v1: 0, v2: 3 });
  const real = full[full.length - 1];
  const fake: ChainRow = { ...real, citizen_id: CID, kind: "memory.seal", detail: "benign" };
  delete fake.proof;
  fake.hash = await entryHash("identity_events", String(real.prev_hash), fake, 2);
  const { citizen_id: _c, ...served } = fake;
  const evs = [...full.slice(0, -1), { ...served, proof: null, proof_note: "not yet checkpointed" }];
  const r = await verifyCitizenEvents(CID, evs, headOf(evs), { eventsTotal: evs.length, checkpoint: CHECKPOINT });
  assert.equal(r.ok, null, JSON.stringify(r));
  assert.deepEqual(r.unproven_events, [real.id]);
  assert.match(r.note, /no usable inclusion proof/);
});

test("a v1 event dropped before the switch and the newest v2 event dropped, honest total, is caught", async () => {
  const full = await dossier({ unsealed: 0, v1: 2, v2: 2 });
  const cut = [full[1], full[2]];
  const r = await verifyCitizenEvents(CID, cut, headOf(cut), { eventsTotal: full.length, checkpoint: CHECKPOINT });
  assert.equal(r.ok, false);
});

test("page 1 of 2 passed without hasMore fails closed on the count", async () => {
  const full = await dossier({ unsealed: 0, v1: 0, v2: 5 });
  const r = await verifyCitizenEvents(CID, full.slice(0, 3), headOf(full), { eventsTotal: 5, checkpoint: CHECKPOINT });
  assert.equal(r.ok, false);
});
