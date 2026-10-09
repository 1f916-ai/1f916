// Dossier completeness, the edges: each test tries to make an incomplete
// dossier read ok: true with verify.mjs passing, and asserts what the check
// answers. Two are stated bounds rather than refusals, and say so: a legacy
// unsealed row's contents (only its count is committed), and a first v2 event
// forged at write time (caught by the global verifyRows walk, not by the
// dossier alone).
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import {
  GENESIS, appendChained, citizenHistoryNext, citizenHistoryStart, entryHash, rowPayloadVersion,
  verifyCitizenEvents, verifyRows, type ChainRow,
} from "../src/chain.ts";
import { MerkleTree } from "../src/merkle.ts";
import { record } from "../src/record.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const CID = 42;
const T = 1_790_000_000_000;
type Ev = Record<string, unknown>;

// Builds a citizen history from a spec string: u = legacy unsealed, 1 or m =
// sealed v1 (before the switch, or after it as a Worker that predates v2 would
// write it; m is a moderation), 2 = v2 written as citizenLink does: the count
// of all earlier rows + 1, the last sealed hash, and the fold over all earlier
// sealed rows. Other citizens' rows interleave
// when `others` is set. Returns the GLOBAL rows (with citizen_id).
async function build(spec: string, others = true) {
  const rows: ChainRow[] = [];
  let id = 1;
  let gprev = GENESIS;
  let count = 0;
  let unsealed = 0;
  let lastSealed = GENESIS;
  const sealedSoFar: string[] = [];
  for (const c of spec) {
    if (c === "u") {
      rows.push({ id: id++, citizen_id: CID, kind: "register", detail: `legacy ${id}`, created_at: T + id, prev_hash: null, hash: null });
      count++;
      unsealed++;
      continue;
    }
    if (others) {
      const o: ChainRow = { id: id++, citizen_id: 7, kind: "memory.seal", detail: `other ${id}`, created_at: T + id, prev_hash: gprev };
      o.hash = await entryHash("identity_events", gprev, o, 1);
      gprev = o.hash as string;
      rows.push(o);
    }
    const row: ChainRow = { id: id++, citizen_id: CID, kind: c === "m" ? "moderation" : "memory.seal", detail: `e${id}`, created_at: T + id, prev_hash: gprev };
    if (c === "2") {
      let h = await citizenHistoryStart(unsealed);
      for (const s of sealedSoFar) h = await citizenHistoryNext(h, s);
      row.citizen_seq = count + 1;
      row.citizen_prev = lastSealed;
      row.citizen_history = h;
    }
    row.hash = await entryHash("identity_events", gprev, row, rowPayloadVersion("identity_events", row));
    gprev = row.hash as string;
    lastSealed = row.hash as string;
    sealedSoFar.push(row.hash as string);
    count++;
    rows.push(row);
  }
  return rows;
}

// Serve one citizen's rows as the dossier does, with real proofs over all
// sealed rows (others included) against a checkpoint of `size` leaves.
async function serve(rows: ChainRow[], size?: number) {
  const leaves = rows.filter((r) => typeof r.hash === "string").map((r) => r.hash as string);
  const tree = new MerkleTree(leaves);
  const n = size ?? leaves.length;
  const checkpoint = { tree_size: n, root: await tree.root(n), created_at: T };
  const events: Ev[] = [];
  for (const r of rows) {
    if (r.citizen_id !== CID) continue;
    const { citizen_id: _c, ...e } = r;
    if (typeof r.hash !== "string") { events.push({ ...e, proof: null }); continue; }
    const i = leaves.indexOf(r.hash);
    if (i >= n) events.push({ ...e, proof: null });
    else events.push({ ...e, leaf_index: i, proof: await tree.inclusionProof(i, n) });
  }
  return { events, checkpoint, leaves, tree };
}

function verifyMjs(events: Ev[], checkpoint: Ev, eventsTotal: number) {
  const dir = mkdtempSync(join(tmpdir(), "dossier-bounds-"));
  const file = join(dir, "record.json");
  writeFileSync(file, JSON.stringify({
    protocol: "1f916/0", handle: "dossier-test", citizen_id: CID, model: "x", since: T, keys: [], bindings: [],
    events, events_total: eventsTotal, events_returned: events.length, events_has_more: false,
    attestations_about: [], checkpoint, witnesses: [],
  }));
  const r = spawnSync(process.execPath, ["vendor/protocol/verify.mjs", "--dossier", file], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } });
  const out = `${r.stdout}\n${r.stderr}`;
  return { inclusionFail: /FAIL\s+inclusion/.test(out), passLine: out.split("\n").find((l) => /event inclusion proofs verified/.test(l)) ?? "" };
}

const head = (evs: Ev[]) => {
  const v2 = evs.filter((e) => e.citizen_seq != null);
  const h = v2[v2.length - 1];
  return h ? { seq: Number(h.citizen_seq), hash: String(h.hash), event_id: Number(h.id) } : null;
};
const check = (evs: Ev[], total: number, cp: { tree_size: number; created_at: number }, extra: Record<string, unknown> = {}) =>
  verifyCitizenEvents(CID, evs, head(evs), { eventsTotal: total, checkpoint: cp, ...extra });

// ---------------------------------------------------------------- controls

test("an honest dossier (two legacy rows, one v1, two v2) is ok: true and verify.mjs passes", async () => {
  const { events, checkpoint } = await serve(await build("uu122"));
  const r = await check(events, events.length, checkpoint);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(verifyMjs(events, checkpoint, events.length).inclusionFail, false);
});

// ---------------------------------------------------------------- U count

test("stated bound: a legacy unsealed row's contents rewritten reads ok: true, because only the count of legacy rows is committed", async () => {
  const { events, checkpoint } = await serve(await build("uu22"));
  const forged = events.map((e, i) => (i === 0 ? { ...e, kind: "register", detail: "rewritten: was a moderation" } : e));
  const r = await check(forged, events.length, checkpoint);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(verifyMjs(forged, checkpoint, events.length).inclusionFail, false);
});

test("one legacy row dropped and the total lowered: false", async () => {
  const { events, checkpoint } = await serve(await build("uu22"));
  const forged = events.slice(1);
  const r = await check(forged, forged.length, checkpoint);
  assert.equal(r.ok, false, JSON.stringify(r));
});

test("a made-up legacy row added first and the total raised: false", async () => {
  const { events, checkpoint } = await serve(await build("uu22"));
  const forged = [{ id: 0, kind: "register", detail: "x", created_at: T, prev_hash: null, hash: null, proof: null }, ...events];
  const r = await check(forged, forged.length, checkpoint);
  assert.equal(r.ok, false, JSON.stringify(r));
});

test("a sealed pre-switch event served as unsealed (hash removed) to keep the count: false", async () => {
  const { events, checkpoint } = await serve(await build("u122"));
  const forged = events.map((e, i) => (i === 1 ? { ...e, hash: null, prev_hash: null, proof: null, leaf_index: undefined } : e));
  const r = await check(forged, events.length, checkpoint);
  assert.equal(r.ok, false, JSON.stringify(r));
});

test("no sealed rows before the switch, no legacy rows: drop seq 1 and lower total: false", async () => {
  const { events, checkpoint } = await serve(await build("222"));
  const r = await check(events.slice(1), 2, checkpoint);
  assert.equal(r.ok, false, JSON.stringify(r));
});

// ---------------------------------------------------------------- other citizens

test("another citizen's real event (real proof) put in place of a dropped one of ours: false (hash binds citizen_id)", async () => {
  const rows = await build("1122");
  const { events, checkpoint, leaves, tree } = await serve(rows);
  const other = rows.find((r) => r.citizen_id === 7)!;
  const { citizen_id: _c, ...oe } = other;
  const i = leaves.indexOf(other.hash as string);
  const swapped = { ...oe, leaf_index: i, proof: await tree.inclusionProof(i, checkpoint.tree_size) };
  const forged = [swapped, ...events.slice(1)].sort((a, b) => Number(a.id) - Number(b.id));
  const r = await check(forged, events.length, checkpoint);
  assert.equal(verifyMjs(forged, checkpoint, events.length).inclusionFail, false);
  assert.equal(r.ok, false, JSON.stringify(r));
});

// ---------------------------------------------------------------- sealedFromId not given

test("sealedFromId not given: a made-up unsealed row placed between sealed rows: false (unsealed after sealed)", async () => {
  const { events, checkpoint } = await serve(await build("1122"));
  const forged = [events[0], { id: Number(events[0].id) + 0.5, kind: "x", detail: "x", created_at: T, prev_hash: null, hash: null, proof: null }, ...events.slice(2)];
  const r = await check(forged, events.length, checkpoint);
  assert.equal(r.ok, false, JSON.stringify(r));
});

// ---------------------------------------------------------------- checkpoint

test("checkpoint: tree_size as string or float makes it undetermined, never true", async () => {
  const { events } = await serve(await build("122"));
  for (const ts of ["9", 8.5, -1]) {
    const r = await verifyCitizenEvents(CID, events, head(events), { eventsTotal: events.length, checkpoint: { tree_size: ts as unknown as number, created_at: T } });
    assert.equal(r.ok, null, `${ts}: ${JSON.stringify(r)}`);
  }
});

test("checkpoint: a stale genuine checkpoint with an event above it still carrying a leaf_index: false", async () => {
  const rows = await build("1222");
  const all = await serve(rows);
  // events proven against the full tree, but the dossier names a smaller checkpoint
  const small = { tree_size: 4, created_at: T };
  const r = await check(all.events, all.events.length, small);
  assert.equal(r.ok, false, JSON.stringify(r));
});

test("checkpoint: verifyCitizenEvents is handed a LARGER checkpoint than verify.mjs checks (caller mix-up): leaf range check is relative to what it is handed", async () => {
  const rows = await build("1222");
  const { events, checkpoint } = await serve(rows, 4);
  // last events unproven under the size-4 checkpoint -> null, as it should be
  const r = await check(events, events.length, checkpoint);
  assert.equal(r.ok, null, JSON.stringify(r));
});

// ---------------------------------------------------------------- v1 after v2 (completeness_lost)

test("a v1 event written after the switch, then omitted with events_total lowered: false once a later v2 event exists", async () => {
  // 1 2 m 2 2: m is a moderation written v1 by a Worker that predates v2
  const rows = await build("12m22");
  const { events, checkpoint } = await serve(rows);
  assert.equal(events.length, 5);
  const honest = await check(events, 5, checkpoint);
  assert.equal(honest.ok, true, JSON.stringify(honest));
  const omitted = events.filter((e) => e.kind !== "moderation");
  const r = await check(omitted, omitted.length, checkpoint);
  assert.equal(verifyMjs(omitted, checkpoint, omitted.length).inclusionFail, false);
  assert.equal(r.ok, false, JSON.stringify(r));
  // the global walk: the next v2 row commits to it, so nothing is left listed
  const g = await verifyRows("identity_events", rows);
  assert.equal(g.ok, true, JSON.stringify(g));
  assert.equal(g.completeness_lost, undefined);
});

test("a v1 event after the switch with nothing after it yet: undetermined, and listed by the global walk", async () => {
  const rows = await build("122m");
  const { events, checkpoint } = await serve(rows);
  const r = await check(events, events.length, checkpoint);
  assert.equal(r.ok, null, JSON.stringify(r));
  const omitted = events.filter((e) => e.kind !== "moderation");
  assert.equal((await check(omitted, omitted.length, checkpoint)).ok, true, "the uncommitted tail is the one case left, and it is what ok: null on the honest dossier warns about");
  const g = await verifyRows("identity_events", rows);
  assert.equal(g.ok, true);
  assert.equal(g.completeness_lost?.length, 1);
});

test("contrast: a dropped v2 event is exposed by the later ones (gap)", async () => {
  const rows = await build("12222");
  const { events, checkpoint } = await serve(rows);
  const omitted = events.filter((_, i) => i !== 3); // seq 4 of 5 dropped
  const r = await check(omitted, omitted.length, checkpoint);
  assert.equal(r.ok, false);
});

// ---------------------------------------------------------------- write-time forged history

test("stated bound: a first v2 event forged at write time over a prefix that skips a moderation passes the dossier check, and only the global verifyRows walk refuses it", async () => {
  // real log: m 1 then a v2 that pretends only '1' came before
  const rows = await build("m1", true);
  const gprev = rows[rows.length - 1].hash as string;
  const one = rows[rows.length - 1];
  const fake: ChainRow = { id: 100, citizen_id: CID, kind: "memory.seal", detail: "v2", created_at: T + 100, prev_hash: gprev, citizen_seq: 2, citizen_prev: one.hash, citizen_history: await citizenHistoryNext(await citizenHistoryStart(0), one.hash as string) };
  fake.hash = await entryHash("identity_events", gprev, fake, 2);
  const all = [...rows, fake];
  const { events, checkpoint } = await serve(all);
  const omitted = events.filter((e) => e.kind !== "moderation");
  const r = await check(omitted, omitted.length, checkpoint);
  assert.equal(verifyMjs(omitted, checkpoint, omitted.length).inclusionFail, false);
  assert.equal(r.ok, true, JSON.stringify(r));
  const g = await verifyRows("identity_events", all);
  assert.equal(g.ok, false, JSON.stringify(g));
});

// ---------------------------------------------------------------- type tricks

test("citizen_history case / whitespace / non-hex on a real v2 event: false (hashed)", async () => {
  const { events, checkpoint } = await serve(await build("122"));
  for (const f of [(s: string) => s.toUpperCase(), (s: string) => ` ${s}`, (s: string) => s.slice(0, 63) + "g"]) {
    const forged = events.map((e, i) => (i === 1 ? { ...e, citizen_history: f(String(e.citizen_history)) } : e));
    const r = await check(forged, events.length, checkpoint);
    assert.equal(r.ok, false);
  }
});

test("a made-up event with proof [] passes the presence check and verify.mjs refuses it", async () => {
  const { events, checkpoint } = await serve(await build("122"));
  const real = events[2];
  const fake: ChainRow = { ...real, citizen_id: CID, detail: "benign" };
  delete (fake as Ev).proof; delete (fake as Ev).leaf_index;
  fake.hash = await entryHash("identity_events", String(fake.prev_hash), fake, 2);
  const { citizen_id: _c, ...served } = fake;
  const forged = [...events.slice(0, 2), { ...served, leaf_index: real.leaf_index, proof: [] }];
  const r = await check(forged, events.length, checkpoint);
  assert.equal(r.ok, true, "the check alone passes it: it never verifies proofs");
  assert.equal(verifyMjs(forged, checkpoint, events.length).inclusionFail, true, "verify.mjs is what stops it");
});

// ---------------------------------------------------------------- record(): checkpoint outside the snapshot

test("an append and a new checkpoint landing right after the dossier's snapshot: the served checkpoint is the snapshot's, so no uncounted event sits inside it", async () => {
  const t = sqliteTestEnv(SCHEMA);
  for (const [id, h] of [[4, "four"], [7, "seven"]] as const) {
    t.db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (?, ?, 'm', ?, ?, ?)").run(id, h, `s${id}`, T, T);
  }
  // The leaves are tracked here rather than read back: the late append runs
  // inside the dossier's own call, where a read would count as the Worker's.
  const known: string[] = [];
  for (let n = 1; n <= 4; n++) {
    known.push((await appendChained(t.env.DB, "identity_events", { citizen_id: n === 2 ? 7 : 4, kind: "memory.seal", detail: `e${n}`, created_at: T + n }, { citizenSeq: true })).hash);
  }
  t.db.prepare("INSERT INTO checkpoints (log, tree_size, root, sig, created_at) VALUES ('identity_events', ?, ?, 'sig', ?)").run(known.length, await new MerkleTree(known).root(known.length), T + 10);
  const raw = t.env.DB as any;
  let late = "";
  const db = new Proxy(raw, {
    get(target, prop) {
      if (prop === "batch") {
        return async (stmts: any[]) => {
          const res = await target.batch(stmts);
          if (!late) {
            // an append and a checkpoint covering it land right after the snapshot
            late = (await appendChained(raw, "identity_events", { citizen_id: 4, kind: "key-revoke", detail: "late", created_at: T + 50 }, { citizenSeq: true })).hash;
            known.push(late);
            t.db.prepare("INSERT INTO checkpoints (log, tree_size, root, sig, created_at) VALUES ('identity_events', ?, ?, 'sig', ?)").run(known.length, await new MerkleTree(known).root(known.length), T + 60);
          }
          return res;
        };
      }
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const d = (await record({ ...t.env, DB: db } as typeof t.env, "four")) as Record<string, any>;
  const r = await verifyCitizenEvents(d.citizen_id, d.events, d.citizen_head, { eventsTotal: d.events_total, checkpoint: d.checkpoint });
  const leaves = (t.db.prepare("SELECT hash FROM identity_events ORDER BY id").all() as { hash: string }[]).map((x) => x.hash);
  const lateIndex = leaves.indexOf(late);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(d.checkpoint.tree_size, 4, "the checkpoint read with the events, not the one written after");
  assert.ok(lateIndex >= d.checkpoint.tree_size, "the uncounted event lies outside the checkpoint the verdict is as of");
  assert.equal(d.events.some((e: Ev) => e.hash === late), false);
});

// ---------------------------------------------------------------- writer concurrency

test("concurrency: three first-v2 appends for one citizen race: one switch, numbers contiguous, chain verifies", async () => {
  const t = sqliteTestEnv(SCHEMA);
  t.db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (4, 'four', 'm', 's', ?, ?)").run(T, T);
  await appendChained(t.env.DB, "identity_events", { citizen_id: 4, kind: "memory.seal", detail: "pre", created_at: T });
  await Promise.all([
    appendChained(t.env.DB, "identity_events", { citizen_id: 4, kind: "memory.seal", detail: "a", created_at: T + 1 }, { citizenSeq: true }),
    appendChained(t.env.DB, "identity_events", { citizen_id: 4, kind: "memory.seal", detail: "b", created_at: T + 2 }, { citizenSeq: true }),
    appendChained(t.env.DB, "identity_events", { citizen_id: 4, kind: "memory.seal", detail: "c", created_at: T + 3 }, { citizenSeq: true }),
  ]);
  const rows = t.db.prepare("SELECT id, citizen_id, kind, detail, created_at, prev_hash, hash, citizen_seq, citizen_prev, citizen_history FROM identity_events ORDER BY id").all() as ChainRow[];
  const g = await verifyRows("identity_events", rows);
  assert.equal(g.ok, true, JSON.stringify(g));
  assert.deepEqual(rows.map((r) => r.citizen_seq), [null, 2, 3, 4]);
});
