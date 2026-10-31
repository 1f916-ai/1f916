// Payload v2 on the write path, against the real schema (migration 0077).
//
// Run: npm test
//
// appendChained / appendChainedStmt assign citizen_seq and citizen_prev under
// the same race discipline as prev_hash: read the global head FIRST, then the
// citizen's head, and let a UNIQUE index refuse whichever writer lost. The
// switch that turns v2 on for a citizen's FIRST v2 event is
// CHAIN_CITIZEN_SEQ=on (default off, the maintainer's choice); once a citizen
// has a v2 event every later event of theirs is v2 regardless, so a verifier
// can treat "v1 after v2" as a break.
//
// Killing mutations, each checked by hand in a scratch copy:
//   - count ALL rows (not sealed ones) for the first seq: legacy row test, red.
//   - drop the ratchet (only write v2 when the switch is on): ratchet and
//     batched-path tests, red.
//   - leave citizen_seq out of isChainRaceViolation: the concurrent test throws
//     DuplicateRowError instead of retrying, and the refusal test, red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { appendChained, appendChainedStmt, attest, entryHash, isChainRaceViolation, rowPayloadVersion, verifyCitizenEvents, verifyRows, GENESIS, type ChainRow } from "../src/chain.ts";
import { commitWithIdentityEvent } from "../src/society.ts";
import { record } from "../src/record.ts";
import { MerkleTree } from "../src/merkle.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const T = 1_790_000_000_000;

function fixture() {
  const t = sqliteTestEnv(SCHEMA);
  for (const [id, handle] of [
    [1, "maint"],
    [4, "four"],
    [7, "seven"],
  ] as const) {
    t.db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (?, ?, 'm', ?, ?, ?)").run(id, handle, `s${id}`, T, T);
  }
  return t;
}

const ev = (citizen_id: number, n: number) => ({ citizen_id, kind: "memory.seal", detail: `event ${n}`, created_at: T + n });

function rowsOf(db: ReturnType<typeof fixture>["db"]) {
  return db.prepare("SELECT id, citizen_id, kind, detail, created_at, prev_hash, hash, citizen_seq, citizen_prev, citizen_history FROM identity_events ORDER BY id ASC").all() as ChainRow[];
}

test("migration 0077 declares the three columns and the unique race guard, mirrored in schema.sql", () => {
  const mig = readFileSync(fileURLToPath(new URL("../migrations/0077_identity_citizen_seq.sql", import.meta.url)), "utf8");
  for (const text of [mig, SCHEMA]) {
    assert.match(text, /citizen_seq\s+INTEGER/);
    assert.match(text, /citizen_prev\s+TEXT/);
    assert.match(text, /citizen_history\s+TEXT/);
    assert.match(text, /CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_events_citizen_seq\s+ON identity_events\(citizen_id, citizen_seq\) WHERE citizen_seq IS NOT NULL/);
  }
});

test("with the switch off, new rows are exactly v1: no citizen_seq, same hash as before", async () => {
  const { db, env } = fixture();
  const out = await appendChained(env.DB, "identity_events", ev(4, 1));
  const [row] = rowsOf(db);
  assert.equal(row.citizen_seq, null);
  assert.equal(row.citizen_prev, null);
  assert.equal(out.citizen_seq, undefined);
  assert.equal((await verifyRows("identity_events", rowsOf(db))).ok, true);
});

test("the first v2 event counts ALL the citizen's earlier events, unsealed legacy rows included, and links the last sealed one", async () => {
  const { db, env } = fixture();
  // A legacy unsealed row: predates sealing and carries no hash, but it is one
  // of the citizen's events, so it counts toward citizen_seq. If it did not, a
  // dossier could drop the newest event and pad its count with a copy of it.
  db.prepare("INSERT INTO identity_events (citizen_id, kind, detail, created_at) VALUES (4, 'legacy', 'x', ?)").run(T);
  await appendChained(env.DB, "identity_events", ev(4, 1));
  await appendChained(env.DB, "identity_events", ev(7, 2));
  const second = await appendChained(env.DB, "identity_events", ev(4, 3));
  const first = await appendChained(env.DB, "identity_events", ev(4, 4), { citizenSeq: true });
  assert.equal(first.citizen_seq, 4);
  assert.equal(first.citizen_prev, second.hash);
  // A citizen with no sealed history starts at 1 and links genesis.
  const fresh = await appendChained(env.DB, "identity_events", ev(1, 5), { citizenSeq: true });
  assert.equal(fresh.citizen_seq, 1);
  assert.equal(fresh.citizen_prev, GENESIS);
  assert.equal((await verifyRows("identity_events", rowsOf(db))).ok, true);
});

test("the ratchet: once a citizen has a v2 event, later events stay v2 with the switch off", async () => {
  const { db, env } = fixture();
  const a = await appendChained(env.DB, "identity_events", ev(4, 1), { citizenSeq: true });
  const b = await appendChained(env.DB, "identity_events", ev(4, 2)); // switch off
  assert.equal(a.citizen_seq, 1);
  assert.equal(b.citizen_seq, 2);
  assert.equal(b.citizen_prev, a.hash);
  // Another citizen is untouched by citizen 4's ratchet.
  const c = await appendChained(env.DB, "identity_events", ev(7, 3));
  assert.equal(c.citizen_seq, undefined);
  assert.equal((await verifyRows("identity_events", rowsOf(db))).ok, true);
});

test("the ledger never gets a citizen sequence", async () => {
  const { db, env } = fixture();
  await appendChained(env.DB, "ledger", { entry_date: "2026-09-29", description: "x", amount_cents: 1, created_at: T }, { citizenSeq: true });
  const row = db.prepare("SELECT prev_hash, hash FROM ledger").get() as ChainRow;
  assert.equal(row.prev_hash, GENESIS);
});

test("concurrent appends for one citizen cannot share a seq: they serialize and stay contiguous", async () => {
  const { db, env } = fixture();
  await appendChained(env.DB, "identity_events", ev(4, 0), { citizenSeq: true });
  // All three read the same heads before any of them writes; two lose on a
  // UNIQUE index and retry.
  const results = await Promise.all([1, 2, 3].map((n) => appendChained(env.DB, "identity_events", ev(4, n), { citizenSeq: true })));
  const seqs = results.map((r) => r.citizen_seq).sort();
  assert.deepEqual(seqs, [2, 3, 4]);
  const stored = (db.prepare("SELECT citizen_seq FROM identity_events WHERE citizen_id = 4 ORDER BY id").all() as { citizen_seq: number }[]).map((r) => r.citizen_seq);
  assert.deepEqual(stored, [1, 2, 3, 4]);
  assert.equal((await verifyRows("identity_events", rowsOf(db))).ok, true);
});

test("the database itself refuses a duplicate (citizen_id, citizen_seq), and the refusal reads as a race", async () => {
  const { db, env } = fixture();
  const a = await appendChained(env.DB, "identity_events", ev(4, 1), { citizenSeq: true });
  let caught: unknown = null;
  try {
    db.prepare("INSERT INTO identity_events (citizen_id, kind, detail, created_at, prev_hash, hash, citizen_seq, citizen_prev) VALUES (4, 'x', 'y', 1, ?, ?, 1, ?)").run(a.hash, "ab".repeat(32), GENESIS);
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, "a second seq 1 for citizen 4 must be refused");
  assert.match(String(caught), /UNIQUE/);
  assert.equal(isChainRaceViolation(caught), true, String(caught));
  assert.equal(isChainRaceViolation(new Error("D1_ERROR: UNIQUE constraint failed: index 'idx_identity_events_citizen_seq'")), true);
});

test("the batched path (appendChainedStmt) assigns the same numbers, guard included", async () => {
  const { db, env } = fixture();
  const one = await appendChainedStmt(env.DB, "identity_events", ev(4, 1), undefined, { citizenSeq: true });
  await env.DB.batch([one.stmt]);
  const two = await appendChainedStmt(env.DB, "identity_events", ev(4, 2), { sql: "1 = 1", binds: [] });
  await env.DB.batch([two.stmt]);
  const stored = db.prepare("SELECT citizen_seq, citizen_prev FROM identity_events ORDER BY id").all() as ChainRow[];
  assert.deepEqual(stored.map((r) => r.citizen_seq), [1, 2]);
  assert.equal(stored[1].citizen_prev, one.hash);
  assert.equal(two.citizen_seq, 2);
  assert.equal((await verifyRows("identity_events", rowsOf(db))).ok, true);
});

test("commitWithIdentityEvent reads the switch from env.CHAIN_CITIZEN_SEQ", async () => {
  const off = fixture();
  await commitWithIdentityEvent(off.env, null, { citizen_id: 4, kind: "memory.seal", detail: "a" }, "refused");
  assert.equal((off.db.prepare("SELECT citizen_seq FROM identity_events").get() as ChainRow).citizen_seq, null);

  const on = fixture();
  (on.env as unknown as Record<string, string>).CHAIN_CITIZEN_SEQ = "on";
  await commitWithIdentityEvent(on.env, null, { citizen_id: 4, kind: "memory.seal", detail: "a" }, "refused");
  await commitWithIdentityEvent(on.env, null, { citizen_id: 4, kind: "memory.seal", detail: "b" }, "refused");
  const seqs = (on.db.prepare("SELECT citizen_seq FROM identity_events ORDER BY id").all() as ChainRow[]).map((r) => r.citizen_seq);
  assert.deepEqual(seqs, [1, 2]);
  assert.equal((await verifyRows("identity_events", rowsOf(on.db))).ok, true);
});

// ---- a resumed attest page carries each citizen's state across the boundary ----

// Citizen 4: two v1 events, then v2 (seq 3, 4, 5); citizen 7 on v2 from its
// first; citizen 1 on v1 throughout. Ids 1..9.
async function crossPageFixture() {
  const t = fixture();
  const plan: Array<[number, boolean]> = [
    [4, false],
    [1, false],
    [4, false],
    [4, true],
    [7, true],
    [4, true],
    [1, false],
    [4, true],
    [7, true],
  ];
  for (const [n, [citizen, v2]] of plan.entries()) {
    await appendChained(t.env.DB, "identity_events", ev(citizen, n + 1), { citizenSeq: v2 });
  }
  return t;
}

// What a server that owns the database could do after deleting or inserting a
// row: recompute every global hash and link, so prev_hash holds everywhere and
// only the per-citizen fields can give the tamper away.
async function reseal(db: ReturnType<typeof fixture>["db"]) {
  let prev = GENESIS;
  for (const r of rowsOf(db)) {
    const hash = await entryHash("identity_events", prev, r, rowPayloadVersion("identity_events", r));
    db.prepare("UPDATE identity_events SET prev_hash = ?, hash = ? WHERE id = ?").run(prev, hash, r.id as number);
    prev = hash;
  }
}

async function identityAttest(env: ReturnType<typeof fixture>["env"], from: number) {
  return ((await attest(env.DB, from)) as unknown as { identity_log: { ok: boolean; status: string; broken_at?: number; reason?: string; completeness_lost?: unknown } }).identity_log;
}

test("a clean chain verifies from every resume point, with the per-citizen state carried in", async () => {
  const { env } = await crossPageFixture();
  for (let from = 0; from <= 9; from++) {
    const r = await identityAttest(env, from);
    assert.equal(r.ok, true, `from=${from}: ${r.reason}`);
  }
});

test("a citizen's v2 event deleted BEFORE the resume point is caught on the resumed page", async () => {
  const { db, env } = await crossPageFixture();
  db.prepare("DELETE FROM identity_events WHERE id = 6").run(); // citizen 4, seq 4
  await reseal(db);
  // The page after id 7 holds citizen 4's seq 5 (id 8) and none of its earlier
  // events: checked against its own rows only, the page reads clean.
  const page = rowsOf(db).filter((r) => (r.id as number) > 7);
  const anchor = (rowsOf(db).find((r) => r.id === 7) as ChainRow).hash as string;
  assert.equal((await verifyRows("identity_events", page, anchor)).ok, true, "without the carried state the boundary hides it");
  const r = await identityAttest(env, 7);
  assert.equal(r.ok, false);
  assert.equal(r.status, "broken");
  assert.equal(r.broken_at, 8);
  assert.match(r.reason!, /citizen_seq 5 is not 4/);
});

test("a v1 event deleted before a switch to v2 that lands on the resumed page is caught by the count", async () => {
  const { db, env } = await crossPageFixture();
  db.prepare("DELETE FROM identity_events WHERE id = 3").run(); // citizen 4's second v1 event
  await reseal(db);
  const r = await identityAttest(env, 3);
  assert.equal(r.ok, false);
  assert.equal(r.broken_at, 4);
  assert.match(r.reason!, /citizen_seq 3 is not 2/);
});

test("a v1 event after the switch is listed until the citizen's next v2 event commits to it; omitting it then fails the dossier", async () => {
  const { db, env } = await crossPageFixture();
  const last = rowsOf(db).at(-1) as ChainRow;
  const row: ChainRow = { citizen_id: 4, kind: "memory.seal", detail: "a downgraded event", created_at: T + 99 };
  const hash = await entryHash("identity_events", last.hash as string, row, 1);
  db.prepare("INSERT INTO identity_events (citizen_id, kind, detail, created_at, prev_hash, hash) VALUES (4, ?, ?, ?, ?, ?)").run(
    row.kind as string,
    row.detail as string,
    row.created_at as number,
    last.hash as string,
    hash,
  );
  // Written as a Worker that predates v2 would: nothing commits to it yet.
  for (const from of [0, 9]) {
    const r = await identityAttest(env, from);
    assert.equal(r.ok, true, `from=${from}: ${r.reason}`);
    assert.equal(r.status, "verified");
    assert.deepEqual(r.completeness_lost, [{ citizen_id: 4, event_id: 10 }]);
  }
  // A v2-aware Worker then writes the citizen's next event: it counts the
  // stray row, links it and folds it in.
  const next = await appendChained(env.DB, "identity_events", ev(4, 100));
  assert.equal(next.citizen_seq, 7);
  assert.equal(next.citizen_prev, hash);
  for (const from of [0, 9, 10]) {
    const r = await identityAttest(env, from);
    assert.equal(r.ok, true, `from=${from}: ${r.reason}`);
    assert.equal(r.completeness_lost, undefined, `from=${from}: the next v2 event commits to it`);
  }
  // The dossier: honest, it checks out; with the stray event left out and
  // events_total lowered to match, the next v2 event's number, link and
  // history give it away.
  const leaves = (db.prepare("SELECT hash FROM identity_events ORDER BY id").all() as { hash: string }[]).map((r) => r.hash);
  db.prepare("INSERT INTO checkpoints (log, tree_size, root, sig, created_at) VALUES ('identity_events', ?, ?, 'sig', ?)").run(leaves.length, await new MerkleTree(leaves).root(leaves.length), T + 200);
  const d = (await record(env, "four")) as Record<string, any>;
  const honest = await verifyCitizenEvents(d.citizen_id, d.events, d.citizen_head, { eventsTotal: d.events_total, checkpoint: d.checkpoint });
  assert.equal(honest.ok, true, JSON.stringify(honest));
  const omitted = d.events.filter((e: { id: number }) => e.id !== 10);
  const short = await verifyCitizenEvents(d.citizen_id, omitted, d.citizen_head, { eventsTotal: d.events_total - 1, checkpoint: d.checkpoint });
  assert.equal(short.ok, false, JSON.stringify(short));
});

test("a v1 event after the switch with no v2 event after it leaves the dossier undetermined, never complete", async () => {
  const { db, env } = await crossPageFixture();
  const last = rowsOf(db).at(-1) as ChainRow;
  const row: ChainRow = { citizen_id: 4, kind: "memory.seal", detail: "a downgraded event", created_at: T + 99 };
  const hash = await entryHash("identity_events", last.hash as string, row, 1);
  db.prepare("INSERT INTO identity_events (citizen_id, kind, detail, created_at, prev_hash, hash) VALUES (4, ?, ?, ?, ?, ?)").run(row.kind as string, row.detail as string, row.created_at as number, last.hash as string, hash);
  const leaves = (db.prepare("SELECT hash FROM identity_events ORDER BY id").all() as { hash: string }[]).map((r) => r.hash);
  db.prepare("INSERT INTO checkpoints (log, tree_size, root, sig, created_at) VALUES ('identity_events', ?, ?, 'sig', ?)").run(leaves.length, await new MerkleTree(leaves).root(leaves.length), T + 200);
  const d = (await record(env, "four")) as Record<string, any>;
  const r = await verifyCitizenEvents(d.citizen_id, d.events, d.citizen_head, { eventsTotal: d.events_total, checkpoint: d.checkpoint });
  assert.equal(r.ok, null, JSON.stringify(r));
  assert.deepEqual(r.uncommitted_events, [10]);
});

test("a resumed page holding a switch to v2 counts the citizen's unsealed legacy rows too", async () => {
  const { db, env } = fixture();
  db.prepare("INSERT INTO identity_events (citizen_id, kind, detail, created_at) VALUES (4, 'legacy', 'x', ?)").run(T);
  await appendChained(env.DB, "identity_events", ev(4, 1));
  await appendChained(env.DB, "identity_events", ev(7, 2));
  const first = await appendChained(env.DB, "identity_events", ev(4, 3), { citizenSeq: true });
  assert.equal(first.citizen_seq, 3, "one unsealed + one sealed row before it");
  for (let from = 0; from <= 4; from++) {
    const r = await identityAttest(env, from);
    assert.equal(r.ok, true, `from=${from}: ${r.reason}`);
  }
});
