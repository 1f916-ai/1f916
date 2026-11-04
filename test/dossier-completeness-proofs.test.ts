// Dossier completeness against real Merkle proofs: each test builds an
// incomplete (or padded) dossier, runs verify.mjs --dossier on the same file,
// and checks that verifyCitizenEvents never answers ok: true for it. These are
// the cases where verify.mjs alone passes, so the completeness check has to be
// the one that refuses.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GENESIS, citizenHistoryNext, citizenHistoryStart, entryHash, rowPayloadVersion, verifyCitizenEvents, type ChainRow } from "../src/chain.ts";
import { MerkleTree } from "../src/merkle.ts";

const CID = 42;
const T = 1_790_000_000_000;

type Ev = Record<string, unknown>;

// The citizen's real history: `unsealed` legacy rows, then `v1` sealed v1
// events, then `v2` v2 events. Ids are global and spaced (other citizens'
// rows sit between). Every sealed event is a real log leaf.
async function history(opts: { unsealed: number; v1: number; v2: number }) {
  const evs: Ev[] = [];
  let id = 1;
  let count = 0;
  for (let i = 0; i < opts.unsealed; i++) {
    evs.push({ id: id++, kind: "register", detail: "legacy", created_at: T + id, prev_hash: null, hash: null });
    count++;
  }
  let last = GENESIS;
  let gprev = GENESIS;
  let hist = await citizenHistoryStart(opts.unsealed);
  for (let i = 0; i < opts.v1 + opts.v2; i++) {
    id += 10;
    const row: ChainRow = {
      id,
      citizen_id: CID,
      kind: i === 0 ? "moderation" : "memory.seal",
      detail: `e${i}`,
      created_at: T + 100 + i,
      prev_hash: gprev,
    };
    if (i >= opts.v1) {
      row.citizen_seq = count + 1;
      row.citizen_prev = last;
      row.citizen_history = hist;
    }
    row.hash = await entryHash("identity_events", gprev, row, rowPayloadVersion("identity_events", row));
    count++;
    last = row.hash as string;
    hist = await citizenHistoryNext(hist, last);
    gprev = row.hash as string;
    const { citizen_id: _c, ...served } = row;
    evs.push(served);
  }
  return evs;
}

// Real proofs against a checkpoint of size `size` over the sealed hashes
// (other citizens' leaves interleaved, so leaf_index != position).
async function prove(evs: Ev[], size?: number) {
  const leaves: string[] = [];
  for (const e of evs) {
    if (typeof e.hash !== "string") continue;
    leaves.push("cd".repeat(32).slice(0, 62) + String(leaves.length).padStart(2, "0")); // someone else's leaf
    leaves.push(e.hash);
  }
  const tree = new MerkleTree(leaves);
  const n = size ?? leaves.length;
  const checkpoint = { tree_size: n, root: await tree.root(n), created_at: T };
  const out: Ev[] = [];
  for (const e of evs) {
    if (typeof e.hash !== "string") {
      out.push({ ...e, proof: null, proof_note: "legacy_unsealed" });
      continue;
    }
    const index = leaves.indexOf(e.hash);
    if (index >= n) out.push({ ...e, proof: null, proof_note: "not yet checkpointed" });
    else out.push({ ...e, leaf_index: index, proof: await tree.inclusionProof(index, n) });
  }
  return { events: out, checkpoint };
}

function verifyMjs(events: Ev[], checkpoint: Ev, eventsTotal: number) {
  const dir = mkdtempSync(join(tmpdir(), "dossier-proofs-"));
  const file = join(dir, "record.json");
  const d = {
    protocol: "1f916/0", handle: "dossier-test", citizen_id: CID, model: "x", since: T, keys: [], bindings: [],
    events, events_total: eventsTotal, events_returned: events.length, events_has_more: false,
    attestations_about: [], checkpoint, witnesses: [],
  };
  writeFileSync(file, JSON.stringify(d));
  const r = spawnSync(process.execPath, ["vendor/protocol/verify.mjs", "--dossier", file], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } });
  const out = `${r.stdout}\n${r.stderr}`;
  const inclusionFail = /FAIL\s+inclusion/.test(out);
  const passLine = out.split("\n").find((l) => /event inclusion proofs verified/.test(l)) ?? "";
  return { inclusionFail, passLine };
}

const headOf = (evs: Ev[]) => {
  const v2 = evs.filter((e) => e.citizen_seq != null);
  const h = v2[v2.length - 1];
  return h ? { seq: Number(h.citizen_seq), hash: String(h.hash), event_id: Number(h.id) } : null;
};

let CHECKPOINT: { tree_size: number; created_at: number } = { tree_size: 0, created_at: T };
async function check(events: Ev[], total: number) {
  return verifyCitizenEvents(CID, events, headOf(events), { eventsTotal: total, checkpoint: CHECKPOINT });
}
async function proveAndRemember(evs: Ev[], size?: number) {
  const p = await prove(evs, size);
  CHECKPOINT = { tree_size: p.checkpoint.tree_size, created_at: p.checkpoint.created_at };
  return p;
}

test("control: an honest dossier is ok: true and verify.mjs passes", async () => {
  const { events, checkpoint } = await proveAndRemember(await history({ unsealed: 0, v1: 3, v2: 2 }));
  const r = await check(events, events.length);
  assert.equal(r.ok, true, JSON.stringify(r));
  const v = verifyMjs(events, checkpoint, events.length);
  assert.equal(v.inclusionFail, false, v.passLine);
});

test("the first v1 event (a moderation) dropped and a made-up unsealed row put first: verify.mjs passes, citizen_history refuses", async () => {
  const { events, checkpoint } = await proveAndRemember(await history({ unsealed: 0, v1: 3, v2: 2 }));
  assert.equal(events[0].kind, "moderation");
  const fake = { id: 5, kind: "register", detail: "made up", created_at: T, prev_hash: null, hash: null, proof: null, proof_note: "legacy_unsealed" };
  const forged = [fake, ...events.slice(1)];
  assert.equal(forged.length, events.length);
  const r = await check(forged, events.length);
  const v = verifyMjs(forged, checkpoint, events.length);
  assert.equal(v.inclusionFail, false, v.passLine);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.ok(r.problems.some((p) => /citizen_history/.test(p)), JSON.stringify(r.problems));
});

test("the first v1 event dropped and another real event served twice at a new id (same hash, leaf_index, proof): verify.mjs passes, the check refuses", async () => {
  const { events, checkpoint } = await proveAndRemember(await history({ unsealed: 0, v1: 3, v2: 2 }));
  const dup = { ...events[1], id: Number(events[1].id) - 1 };
  const forged = [dup, ...events.slice(1)];
  const r = await check(forged, events.length);
  const v = verifyMjs(forged, checkpoint, events.length);
  assert.equal(v.inclusionFail, false, v.passLine);
  assert.match(v.passLine, /5 event inclusion proofs verified/);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.ok(r.problems.some((p) => /appears twice/.test(p)), JSON.stringify(r.problems));
});

test("a middle v1 event dropped and the first one served again in its place: refused", async () => {
  const { events, checkpoint } = await proveAndRemember(await history({ unsealed: 0, v1: 3, v2: 1 }));
  // drop events[1]; serve events[0] at events[1]'s id
  const forged = [events[0], { ...events[0], id: events[1].id }, events[2], events[3]];
  const r = await check(forged, events.length);
  const v = verifyMjs(forged, checkpoint, events.length);
  assert.equal(v.inclusionFail, false, v.passLine);
  assert.equal(r.ok, false, JSON.stringify(r));
});

test("dropping the last v1 event before the switch is caught", async () => {
  const { events } = await proveAndRemember(await history({ unsealed: 0, v1: 3, v2: 2 }));
  const forged = [events[0], { ...events[0], id: Number(events[0].id) + 1 }, events[3], events[4]];
  const r = await check(forged, events.length);
  assert.equal(r.ok, false);
});

for (const falsy of [false, 0, ""]) {
  test(`the newest v2 event replaced by a made-up one with proof ${JSON.stringify(falsy)}: verify.mjs skips it as unproven, and so does the check (never ok: true)`, async () => {
    const { events, checkpoint } = await proveAndRemember(await history({ unsealed: 0, v1: 1, v2: 3 }));
    const real = events[events.length - 1];
    const fake: ChainRow = { id: real.id, citizen_id: CID, kind: "memory.seal", detail: "benign", created_at: real.created_at, prev_hash: real.prev_hash, citizen_seq: real.citizen_seq, citizen_prev: real.citizen_prev, citizen_history: real.citizen_history };
    fake.hash = await entryHash("identity_events", String(fake.prev_hash), fake, 2);
    const { citizen_id: _c, ...served } = fake;
    const forged = [...events.slice(0, -1), { ...served, leaf_index: real.leaf_index, proof: falsy }];
    const r = await check(forged, events.length);
    const v = verifyMjs(forged, checkpoint, events.length);
    assert.equal(v.inclusionFail, false, v.passLine);
    assert.match(v.passLine, /\(1 carried no proof/);
    assert.equal(r.ok, null, JSON.stringify(r));
    assert.deepEqual(r.unproven_events, [real.id]);
  });
}

test("the stated bound: a stale checkpoint, the newest event above it dropped and the total lowered reads complete AS OF that checkpoint", async () => {
  const h = await history({ unsealed: 0, v1: 1, v2: 3 });
  // checkpoint covers all but the last sealed leaf (and its filler)
  const { events, checkpoint } = await proveAndRemember(h, 6);
  const cut = events.slice(0, -1);
  const r = await check(cut, cut.length);
  const v = verifyMjs(cut, checkpoint, cut.length);
  assert.equal(v.inclusionFail, false, v.passLine);
  // Documented, not closed: the verdict names the checkpoint it is relative
  // to, and the reader compares that checkpoint with the witness files.
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.as_of, { tree_size: 6, created_at: T });
  assert.match(r.note, /as of checkpoint tree_size 6/);
});

test("no checkpoint given: an honest dossier is undetermined, never true", async () => {
  const { events } = await proveAndRemember(await history({ unsealed: 0, v1: 1, v2: 2 }));
  const r = await verifyCitizenEvents(CID, events, headOf(events), { eventsTotal: events.length });
  assert.equal(r.ok, null);
  assert.match(r.note, /checkpoint/);
});

test("a string citizen_seq on a real v2 event fails its hash", async () => {
  const { events } = await proveAndRemember(await history({ unsealed: 0, v1: 0, v2: 3 }));
  const forged = events.map((e, i) => (i === 2 ? { ...e, citizen_seq: String(e.citizen_seq) } : e));
  const r = await check(forged, events.length);
  assert.equal(r.ok, false);
});

test("string ids that compare numerically are read as numbers", async () => {
  const { events } = await proveAndRemember(await history({ unsealed: 0, v1: 0, v2: 3 }));
  const forged = events.map((e) => ({ ...e, id: String(e.id) }));
  const r = await check(forged, events.length);
  assert.equal(r.ok, true); // honest content, only the type changed
});

test("events_total as a string is undetermined, not true", async () => {
  const { events } = await proveAndRemember(await history({ unsealed: 0, v1: 0, v2: 3 }));
  const r = await verifyCitizenEvents(CID, events, headOf(events), { eventsTotal: String(events.length) as unknown as number, checkpoint: CHECKPOINT });
  assert.equal(r.ok, null);
});

test("events reordered under swapped ids are caught", async () => {
  const { events } = await proveAndRemember(await history({ unsealed: 0, v1: 0, v2: 3 }));
  const forged = [events[0], { ...events[2], id: events[1].id }, events[1]];
  const r = await check(forged, events.length);
  assert.equal(r.ok, false);
});

test("a missing id on the first event is caught", async () => {
  const { events } = await proveAndRemember(await history({ unsealed: 1, v1: 1, v2: 2 }));
  const forged = [{ ...events[0], id: undefined }, ...events.slice(1)];
  const r = await check(forged, events.length);
  assert.equal(r.ok, false, JSON.stringify(r));
});
