// GET /api/record/:handle serves the citizen's head, so a dossier can be
// checked for COMPLETENESS, not only for presence.
//
// Run: npm test
//
// src/record.ts promised "presence and timing via inclusion proofs" and that
// was all a dossier could prove: leave out one event and every remaining proof
// still verifies. With payload v2 each event carries citizen_seq and
// citizen_prev inside its hash; the dossier now also serves citizen_head (the
// citizen's latest v2 event: seq, hash, event id, and its inclusion proof
// against the signed checkpoint) and first_v2_seq. A reader walks the numbers
// from first_v2_seq to citizen_head.seq and a missing one is a gap.
//
// Killing mutations, each checked by hand in a scratch copy:
//   - serve the head from ORDER BY citizen_seq ASC: head.seq is 3, not 5, red.
//   - serve events without servedChainRow (citizen_seq: null left on v1
//     events): the byte-identity and schema tests, red.
//   - drop the proof on citizen_head: proof is null under a covering checkpoint, red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { validate } from "./helpers/json-schema.ts";
import { appendChained, attest, verifyCitizenEvents } from "../src/chain.ts";
import { MerkleTree } from "../src/merkle.ts";
import { RECORD_EVENTS_PAGE, record } from "../src/record.ts";
import { identityLog } from "../src/society.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const RECORD_SCHEMA = JSON.parse(readFileSync(fileURLToPath(new URL("../schemas/record.json", import.meta.url)), "utf8"));
const T = 1_790_000_000_000;

async function fixture(opts: { v2From?: number; checkpoint?: boolean } = {}) {
  const t = sqliteTestEnv(SCHEMA);
  for (const [id, handle] of [
    [4, "four"],
    [7, "seven"],
  ] as const) {
    t.db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (?, ?, 'm', ?, ?, ?)").run(id, handle, `s${id}`, T, T);
  }
  // Citizen 4: events n = 1..5; v2 from the v2From-th of its own events.
  let mine = 0;
  for (let n = 1; n <= 7; n++) {
    const citizen = n === 3 || n === 6 ? 7 : 4;
    if (citizen === 4) mine++;
    await appendChained(
      t.env.DB,
      "identity_events",
      { citizen_id: citizen, kind: n === 7 ? "key-revoke" : "memory.seal", detail: `event ${n}`, created_at: T + n },
      { citizenSeq: citizen === 4 && opts.v2From !== undefined && mine >= opts.v2From },
    );
  }
  if (opts.checkpoint !== false) {
    const leaves = (t.db.prepare("SELECT hash FROM identity_events ORDER BY id").all() as { hash: string }[]).map((r) => r.hash);
    const root = await new MerkleTree(leaves).root(leaves.length);
    t.db.prepare("INSERT INTO checkpoints (log, tree_size, root, sig, created_at) VALUES ('identity_events', ?, ?, 'sig', ?)").run(leaves.length, root, T + 100);
  }
  return t;
}

test("a dossier serves citizen_head (latest v2 event with its proof) and first_v2_seq", async () => {
  const { env } = await fixture({ v2From: 3 });
  const d = (await record(env, "four")) as Record<string, any>;
  // Citizen 4 has events 1,2,4,5,7 → its own events 1..5; v2 from its 3rd.
  assert.equal(d.first_v2_seq, 3);
  assert.equal(d.first_v2_event_id, 4);
  assert.equal(d.citizen_head.seq, 5);
  assert.equal(d.citizen_head.event_id, 7);
  assert.equal(d.citizen_head.hash, d.events[d.events.length - 1].hash);
  assert.ok(Array.isArray(d.citizen_head.proof), "a checkpoint covers the head, so it carries a proof");
  assert.equal(typeof d.citizen_head.leaf_index, "number");
  assert.match(d.completeness_note, /citizen_seq/);
  assert.deepEqual(validate(RECORD_SCHEMA.properties.citizen_head, d.citizen_head), []);
  assert.deepEqual(validate(RECORD_SCHEMA.properties.first_v2_seq, d.first_v2_seq), []);
  for (const e of d.events) assert.deepEqual(validate(RECORD_SCHEMA.properties.events.items, e).filter((x: string) => !/leaf_index|proof/.test(x)), []);
});

test("the served dossier passes the completeness check, and fails it with one v2 event removed", async () => {
  const { env } = await fixture({ v2From: 3 });
  const d = (await record(env, "four")) as Record<string, any>;
  const whole = await verifyCitizenEvents(d.citizen_id, d.events, d.citizen_head, { eventsTotal: d.events_total, checkpoint: d.checkpoint });
  assert.equal(whole.ok, true, JSON.stringify(whole));
  assert.equal(whole.checked_through_seq, 5);

  const trimmed = d.events.filter((e: { id: number }) => e.id !== 5); // citizen seq 4
  const report = await verifyCitizenEvents(d.citizen_id, trimmed, d.citizen_head, { eventsTotal: d.events_total, checkpoint: d.checkpoint });
  assert.equal(report.ok, false);
  assert.deepEqual(report.gaps, [{ from: 4, to: 4 }]);
});

test("v1 events are served byte-identically: no citizen_seq key appears on a v1 row", async () => {
  const { env } = await fixture({ v2From: 3 });
  const d = (await record(env, "four")) as Record<string, any>;
  const v1 = d.events.filter((e: { id: number }) => e.id < 4);
  assert.equal(v1.length, 2);
  for (const e of v1) {
    assert.equal("citizen_seq" in e, false);
    assert.equal("citizen_prev" in e, false);
  }
  for (const e of d.events.filter((e: { id: number }) => e.id >= 4)) assert.equal(typeof e.citizen_seq, "number");
});

test("a citizen with no v2 events gets a null head and a note that says only presence is proven", async () => {
  const { env } = await fixture({});
  const d = (await record(env, "four")) as Record<string, any>;
  assert.equal(d.citizen_head, null);
  assert.equal(d.first_v2_seq, null);
  assert.equal(d.first_v2_event_id, null);
  assert.match(d.completeness_note, /presence/);
  for (const e of d.events) assert.equal("citizen_seq" in e, false);
  assert.deepEqual(validate(RECORD_SCHEMA.properties.citizen_head, d.citizen_head), []);
});

test("a head newer than the latest checkpoint says so instead of carrying a proof", async () => {
  const { env } = await fixture({ v2From: 1, checkpoint: false });
  const d = (await record(env, "four")) as Record<string, any>;
  assert.equal(d.citizen_head.seq, 5);
  assert.equal(d.citizen_head.proof, null);
  assert.match(d.citizen_head.proof_note, /checkpoint/);
});

test("citizen_head and the completeness fields ride outside the signed core", async () => {
  // Adding a key to the core breaks every verify.mjs already downloaded (it
  // rebuilds the core from a fixed key list; see the seals comment in
  // src/record.ts). The head is authenticated by its own inclusion proof.
  const src = readFileSync(fileURLToPath(new URL("../src/record.ts", import.meta.url)), "utf8");
  const core = src.slice(src.indexOf("const core = {"), src.indexOf("};", src.indexOf("const core = {")));
  for (const key of ["citizen_head", "first_v2_seq", "first_v2_event_id", "completeness_note"]) {
    assert.equal(core.includes(key), false, `${key} must not be in the signed core`);
  }
});

test("a dossier longer than one page: page 1 reports more pages, not a gap; the joined pages check out complete", async () => {
  const t = sqliteTestEnv(SCHEMA);
  t.db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (4, 'four', 'm', 's4', ?, ?)").run(T, T);
  const N = RECORD_EVENTS_PAGE + 50;
  for (let n = 1; n <= N; n++) {
    await appendChained(t.env.DB, "identity_events", { citizen_id: 4, kind: "memory.seal", detail: `event ${n}`, created_at: T + n }, { citizenSeq: true });
  }
  const leaves = (t.db.prepare("SELECT hash FROM identity_events ORDER BY id").all() as { hash: string }[]).map((r) => r.hash);
  const root = await new MerkleTree(leaves).root(leaves.length);
  t.db.prepare("INSERT INTO checkpoints (log, tree_size, root, sig, created_at) VALUES ('identity_events', ?, ?, 'sig', ?)").run(leaves.length, root, T + N + 1);

  const p1 = (await record(t.env, "four")) as Record<string, any>;
  assert.equal(p1.events.length, RECORD_EVENTS_PAGE);
  assert.equal(p1.events_has_more, true);
  assert.equal(p1.citizen_head.seq, N, "the head names the latest event, which is on a later page");
  assert.match(p1.completeness_note, /follow next_events_since/);

  // Page 1 alone, told it is not the last: undecided, and no gap is invented.
  const partial = await verifyCitizenEvents(p1.citizen_id, p1.events, p1.citizen_head, { hasMore: true, eventsTotal: p1.events_total, checkpoint: p1.checkpoint });
  assert.equal(partial.ok, null);
  assert.equal(partial.more_pages, true);
  assert.deepEqual(partial.gaps, []);
  assert.deepEqual(partial.problems, []);
  assert.equal(partial.checked_through_seq, RECORD_EVENTS_PAGE);
  assert.match(partial.note, /more pages/);

  const p2 = (await record(t.env, "four", p1.next_events_since)) as Record<string, any>;
  assert.equal(p2.events_has_more, false);
  const joined = [...p1.events, ...p2.events];
  const whole = await verifyCitizenEvents(p1.citizen_id, joined, p2.citizen_head, { eventsTotal: p2.events_total, checkpoint: p2.checkpoint });
  assert.equal(whole.ok, true, JSON.stringify(whole));
  assert.equal(whole.more_pages, false);
  assert.equal(whole.checked_through_seq, N);

  // Joined, with one event on page 2 left out: a real gap.
  const short = joined.filter((e: { citizen_seq: number }) => e.citizen_seq !== RECORD_EVENTS_PAGE + 10);
  const report = await verifyCitizenEvents(p1.citizen_id, short, p2.citizen_head, { eventsTotal: p2.events_total, checkpoint: p2.checkpoint });
  assert.equal(report.ok, false);
  assert.deepEqual(report.gaps, [{ from: RECORD_EVENTS_PAGE + 10, to: RECORD_EVENTS_PAGE + 10 }]);
});

test("before migration 0077 has run, the dossier and the events log still answer, with v1 rows and no head", async () => {
  // Code can deploy ahead of its migration; a missing logging column must not
  // turn GET /api/record or GET /api/events into a 500.
  // The schema as it stood before the migration, derived from schema.sql: the
  // three columns and the two indexes the migration adds are cut out. (Not
  // ALTER TABLE DROP COLUMN: the SQLite in Node 22 refuses it on this table.)
  const lines = SCHEMA.split("\n");
  const from = lines.findIndex((l) => l.startsWith("  -- Migration 0077, payload v2"));
  const to = lines.findIndex((l, i) => i > from && l.startsWith("  citizen_history TEXT"));
  assert.ok(from > 0 && to > from, "the v2 column block in schema.sql moved");
  lines[from - 1] = lines[from - 1].replace(/^(\s+hash\s+TEXT),/, "$1");
  const before = [...lines.slice(0, from), ...lines.slice(to + 1)]
    .filter((l) => !/^CREATE (UNIQUE )?INDEX IF NOT EXISTS idx_identity_events_citizen_(seq|id) /.test(l))
    .join("\n");
  const t = sqliteTestEnv(before);
  const columns = (t.db.prepare("PRAGMA table_info(identity_events)").all() as { name: string }[]).map((c) => c.name);
  assert.deepEqual(columns.filter((c) => c.startsWith("citizen_") && c !== "citizen_id"), [], "the pre-migration table has no v2 column");
  t.db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (4, 'four', 'm', 's4', ?, ?)").run(T, T);
  for (let n = 1; n <= 3; n++) {
    // The write path's own fallback: with the switch on it still writes v1.
    await appendChained(t.env.DB, "identity_events", { citizen_id: 4, kind: "memory.seal", detail: `event ${n}`, created_at: T + n }, { citizenSeq: true });
  }
  const d = (await record(t.env, "four")) as Record<string, any>;
  assert.equal(d.events.length, 3);
  assert.equal(d.citizen_head, null);
  assert.equal(d.first_v2_seq, null);
  for (const e of d.events) assert.equal("citizen_seq" in e, false);

  const recent = (await identityLog(t.env)) as Record<string, any>;
  assert.equal(recent.events.length, 3);
  const paged = (await identityLog(t.env, null, 0)) as Record<string, any>;
  assert.equal(paged.events.length, 3);
  for (const e of [...recent.events, ...paged.events]) assert.equal("citizen_seq" in e, false);

  const att = (await attest(t.env.DB, 1)) as Record<string, any>;
  assert.equal(att.identity_log.ok, true, att.identity_log.reason);
});

test("a served dossier with its newest events dropped and citizen_head moved back to match fails on the signed events_total", async () => {
  // citizen_head rides outside the signed core and its inclusion proof shows
  // only that the event is in the log. A registry that drops the tail and
  // serves an earlier event as the head, with that event's real proof, passes
  // every number check; the signed events_total is what it cannot fake
  // without signing a provable lie.
  const { env } = await fixture({ v2From: 1 });
  const d = (await record(env, "four")) as Record<string, any>;
  assert.equal(d.events_total, 5);
  for (const drop of [1, 2]) {
    const kept = d.events.slice(0, d.events.length - drop);
    const last = kept[kept.length - 1];
    const lyingHead = { seq: last.citizen_seq, hash: last.hash, event_id: last.id };
    const report = await verifyCitizenEvents(d.citizen_id, kept, lyingHead, { eventsTotal: d.events_total, checkpoint: d.checkpoint });
    assert.equal(report.ok, false, `dropping ${drop}`);
    assert.equal(report.missing_events, drop);
  }
});

test("the dossier reads its events, events_total and head as one snapshot: an append mid-read cannot fake a gap", async () => {
  // Wrap the database so the first per-citizen identity read that runs ON ITS
  // OWN (not inside a batch) is followed by an append for the same citizen.
  // Separate reads would then disagree (a head or a total past the page); the
  // single batch gives the append no seam to land in.
  const { env } = await fixture({ v2From: 1 });
  const raw = env.DB as any;
  let fired = false;
  const maybeAppend = async (sql: string) => {
    if (fired || !/FROM identity_events WHERE citizen_id = \?/.test(sql)) return;
    fired = true;
    await appendChained(raw, "identity_events", { citizen_id: 4, kind: "memory.seal", detail: "landed mid-read", created_at: T + 50 });
  };
  const wrap = (stmt: any, sql: string): any => ({
    __inner: stmt,
    bind: (...a: unknown[]) => wrap(stmt.bind(...a), sql),
    first: async (...a: unknown[]) => { const r = await stmt.first(...a); await maybeAppend(sql); return r; },
    all: async (...a: unknown[]) => { const r = await stmt.all(...a); await maybeAppend(sql); return r; },
    run: (...a: unknown[]) => stmt.run(...a),
    raw: (...a: unknown[]) => stmt.raw(...a),
  });
  const db = new Proxy(raw, {
    get(target, prop) {
      if (prop === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (prop === "batch") return (stmts: any[]) => target.batch(stmts.map((s) => s.__inner ?? s));
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const d = (await record({ ...env, DB: db } as typeof env, "four")) as Record<string, any>;
  const report = await verifyCitizenEvents(d.citizen_id, d.events, d.citizen_head, { eventsTotal: d.events_total, checkpoint: d.checkpoint });
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(d.citizen_head.seq, d.events[d.events.length - 1].citizen_seq);
  assert.equal(d.events_total, d.events.length);
});
