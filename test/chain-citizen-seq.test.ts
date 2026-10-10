// Payload v2: a per-citizen sequence and back-link inside the identity preimage.
//
// Run: npm test
//
// The defect this answers: a dossier proves each event it holds was
// in the log, via inclusion proofs, and never that it holds ALL of them. The
// v1 preimage (src/chain.ts PAYLOAD.identity_events) has no per-citizen
// counter, so a dossier with a moderation or key-revoke event left out
// verifies offline exactly like a whole one. v2 puts citizen_seq and
// citizen_prev into the hash, so an omission is a missing number or a broken
// link that the arithmetic catches.
//
// These are the pure halves: the preimage, the global verifier over a MIXED
// v1/v2 chain, and the per-citizen completeness check a dossier reader runs.
//
// Killing mutations, each checked by hand in a scratch copy:
//   - rowPayloadVersion always returns 1: the v2 rows fail their own hash, red.
//   - drop the citizen_seq check in verifyRows: "a skipped citizen_seq" passes, red.
//   - drop the citizen_prev check in verifyRows: "a wrong citizen_prev" passes, red.
//   - drop the v1-after-v2 check: the downgrade test finds no completeness_lost, red.
//   - verifyCitizenEvents stops counting against events_total: the tail tests
//     (newest event dropped with the head moved back to match) report ok, red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  GENESIS,
  CITIZEN_LINK_FIELDS,
  CITIZEN_PAYLOAD_VERSION,
  PAYLOAD,
  citizenHistoryNext,
  citizenHistoryStart,
  entryHash,
  rowPayloadVersion,
  verifyRows,
  verifyCitizenEvents,
  type ChainRow,
} from "../src/chain.ts";

type Spec = { citizen_id: number; kind: string; detail: string; created_at: number; v2?: boolean };

// Builds a global chain the way appendChained does: v2 rows get the next
// citizen_seq (count of that citizen's earlier rows + 1; MIXED has no unsealed
// rows), the hash of that citizen's previous sealed row (GENESIS for its
// first), and the citizen_history digest over its earlier rows.
async function build(specs: Spec[]): Promise<ChainRow[]> {
  const rows: ChainRow[] = [];
  let prev = GENESIS;
  const perCitizen = new Map<number, { count: number; hash: string; history: string }>();
  for (const [i, s] of specs.entries()) {
    const { v2, ...payload } = s;
    const row: ChainRow = { ...payload, id: i + 1, prev_hash: prev };
    const mine = perCitizen.get(s.citizen_id) ?? { count: 0, hash: GENESIS, history: await citizenHistoryStart(0) };
    if (v2) {
      row.citizen_seq = mine.count + 1;
      row.citizen_prev = mine.hash;
      row.citizen_history = mine.history;
    }
    row.hash = await entryHash("identity_events", prev, row, rowPayloadVersion("identity_events", row));
    perCitizen.set(s.citizen_id, { count: mine.count + 1, hash: row.hash as string, history: await citizenHistoryNext(mine.history, row.hash as string) });
    prev = row.hash as string;
    rows.push(row);
  }
  return rows;
}

const T = 1_790_000_000_000;
// Citizen 4 has two v1 events, then switches to v2 for three more; citizen 7
// is v2 from its first event; citizen 1 stays v1 throughout.
const MIXED: Spec[] = [
  { citizen_id: 4, kind: "key-bind", detail: "bound k1", created_at: T },
  { citizen_id: 1, kind: "moderation", detail: "pinned post 3", created_at: T + 1 },
  { citizen_id: 4, kind: "memory.seal", detail: "seal 1", created_at: T + 2 },
  { citizen_id: 4, kind: "memory.seal", detail: "seal 2", created_at: T + 3, v2: true },
  { citizen_id: 7, kind: "key-bind", detail: "bound k7", created_at: T + 4, v2: true },
  { citizen_id: 4, kind: "moderation", detail: "hidden comment 9", created_at: T + 5, v2: true },
  { citizen_id: 1, kind: "moderation", detail: "unpinned post 3", created_at: T + 6 },
  { citizen_id: 4, kind: "key-revoke", detail: "revoked k1", created_at: T + 7, v2: true },
  { citizen_id: 7, kind: "memory.seal", detail: "seal 1", created_at: T + 8, v2: true },
];

const clone = (rows: ChainRow[]): ChainRow[] => rows.map((r) => ({ ...r }));
const reseal = async (rows: ChainRow[]) => {
  // Recompute every hash and link after a tamper, the way a server that owns
  // the database could: the GLOBAL chain is then self-consistent, so only the
  // per-citizen fields can give the tamper away.
  let prev = GENESIS;
  for (const r of rows) {
    r.prev_hash = prev;
    r.hash = await entryHash("identity_events", prev, r, rowPayloadVersion("identity_events", r));
    prev = r.hash as string;
  }
  return rows;
};

test("v2 is registered for identity_events, and the v1 contract did not move", () => {
  assert.equal(CITIZEN_PAYLOAD_VERSION, 2);
  assert.deepEqual([...CITIZEN_LINK_FIELDS], ["citizen_seq", "citizen_prev", "citizen_history"]);
  assert.deepEqual([...PAYLOAD.identity_events], ["citizen_id", "kind", "detail", "created_at"]);
});

test("the v2 preimage appends citizen_seq, citizen_prev and citizen_history to the v1 array, in that order", async () => {
  const row: ChainRow = { citizen_id: 4, kind: "k", detail: "d", created_at: 5, citizen_seq: 3, citizen_prev: "ab".repeat(32), citizen_history: "ef".repeat(32) };
  const prev = "cd".repeat(32);
  const { createHash } = await import("node:crypto");
  const expected = createHash("sha256")
    .update(prev + "\n" + JSON.stringify([4, "k", "d", 5, 3, "ab".repeat(32), "ef".repeat(32)]))
    .digest("hex");
  assert.equal(await entryHash("identity_events", prev, row, 2), expected);
  // A v1 array has four elements and a v2 array seven, so no v1 preimage can
  // equal a v2 preimage: the version is bound into the bytes.
  assert.notEqual(await entryHash("identity_events", prev, row, 1), expected);
});

test("a row's version is read from the row, and the hash binds it", async () => {
  assert.equal(rowPayloadVersion("identity_events", { citizen_id: 1, citizen_seq: null }), 1);
  assert.equal(rowPayloadVersion("identity_events", { citizen_id: 1 }), 1);
  assert.equal(rowPayloadVersion("identity_events", { citizen_id: 1, citizen_seq: 1, citizen_prev: GENESIS }), 2);
  // The ledger has no citizen; it is v1 whatever the row says.
  assert.equal(rowPayloadVersion("ledger", { citizen_seq: 1 }), 1);
  await assert.rejects(() => entryHash("ledger", GENESIS, { entry_date: "x" }, 2), /identity_events/);
});

test("citizen_history is the published fold: H0 over the unsealed count, then one step per sealed hash", async () => {
  const { createHash } = await import("node:crypto");
  const sha = (x: string) => createHash("sha256").update(x).digest("hex");
  assert.equal(await citizenHistoryStart(2), sha("citizen-history:2"));
  const a = "11".repeat(32);
  assert.equal(await citizenHistoryNext(await citizenHistoryStart(0), a), sha(sha("citizen-history:0") + "\n" + a));
});

test("a wrong citizen_history is caught by verifyRows even when the number and the link are right", async () => {
  const rows = clone(await build(MIXED));
  rows[3].citizen_history = "00".repeat(31) + "01"; // citizen 4's first v2 event
  await reseal(rows);
  const report = await verifyRows("identity_events", rows);
  assert.equal(report.ok, false);
  assert.equal(report.broken_at, 4);
  assert.match(report.reason!, /citizen_history/);
});

test("the v1 fixture still reproduces under the version its rows declare", async () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/chain-payload-v1.json", import.meta.url), "utf8")) as {
    table: "ledger";
    rows: Array<ChainRow & { prev_hash: string; hash: string }>;
  };
  for (const row of fixture.rows) {
    const v = rowPayloadVersion(fixture.table, row);
    assert.equal(v, 1);
    assert.equal(await entryHash(fixture.table, row.prev_hash, row, v), row.hash, `fixture row ${row.id}`);
  }
});

test("a mixed v1/v2 chain verifies end to end", async () => {
  const report = await verifyRows("identity_events", await build(MIXED));
  assert.equal(report.ok, true, report.reason);
  assert.equal(report.sealed_entries, MIXED.length);
});

test("a v1-only chain is untouched by the v2 checks", async () => {
  const report = await verifyRows("identity_events", await build(MIXED.map(({ v2: _v2, ...s }) => s)));
  assert.equal(report.ok, true, report.reason);
});

test("stripping citizen_seq off a v2 row breaks its hash (a v2 row cannot be passed off as v1)", async () => {
  const rows = clone(await build(MIXED));
  rows[3].citizen_seq = null;
  rows[3].citizen_prev = null;
  const report = await verifyRows("identity_events", rows);
  assert.equal(report.ok, false);
  assert.equal(report.broken_at, 4);
  assert.match(report.reason!, /contents do not match/);
});

test("removing one citizen's event and re-sealing the global chain is caught by citizen_seq", async () => {
  // The attack v1 cannot see: the operator deletes citizen 4's moderation row
  // and recomputes every global hash, so prev_hash links all hold.
  const rows = clone(await build(MIXED));
  rows.splice(5, 1);
  await reseal(rows);
  const report = await verifyRows("identity_events", rows);
  assert.equal(report.ok, false);
  assert.equal(report.broken_at, 8);
  assert.match(report.reason!, /citizen_seq/);
});

test("a wrong citizen_prev is caught even when the number is right", async () => {
  const rows = clone(await build(MIXED));
  rows[5].citizen_prev = rows[0].hash; // points past the citizen's previous event
  await reseal(rows);
  const report = await verifyRows("identity_events", rows);
  assert.equal(report.ok, false);
  assert.equal(report.broken_at, 6);
  assert.match(report.reason!, /citizen_prev/);
});

test("the first v2 event's number must count the citizen's earlier sealed events (from genesis)", async () => {
  const rows = clone(await build(MIXED));
  rows[3].citizen_seq = 1; // pretends citizen 4 had no history before it
  await reseal(rows);
  const report = await verifyRows("identity_events", rows);
  assert.equal(report.ok, false);
  assert.equal(report.broken_at, 4);
  assert.match(report.reason!, /citizen_seq/);
});

test("a v1 row after a citizen's v2 rows is that citizen's completeness lost, not a broken chain", async () => {
  // A Worker that predates v2 (a rollback, a gradual deploy) writes exactly
  // this row. Its hash holds, so the chain stands; the citizen's guarantee
  // does not, and the report names the row.
  const rows = clone(await build(MIXED));
  rows[7].citizen_seq = null;
  rows[7].citizen_prev = null;
  await reseal(rows);
  const report = await verifyRows("identity_events", rows);
  assert.equal(report.ok, true, report.reason);
  assert.equal(report.broken_at, undefined);
  assert.deepEqual(report.completeness_lost, [{ citizen_id: 4, event_id: 8 }]);
  assert.equal("completeness_lost" in (await verifyRows("identity_events", await build(MIXED))), false, "absent when nothing was lost");
});

test("a resumed page checks links between rows it sees and skips counts it cannot know", async () => {
  const rows = await build(MIXED);
  // Resume after row 4: citizen 4's next v2 row (id 6) has no earlier row for
  // citizen 4 in this page, so neither its number nor its link is checkable
  // here; row 8 links to row 6, which is.
  const report = await verifyRows("identity_events", rows.slice(4), rows[3].hash as string);
  assert.equal(report.ok, true, report.reason);
});

// ---- the dossier reader's check ----

function dossierEvents(rows: ChainRow[], citizenId: number) {
  return rows
    .filter((r) => r.citizen_id === citizenId)
    .map(({ citizen_id: _c, ...rest }) => {
      // Served with a proof, as the dossier serves a checkpointed event. Its
      // content is verify.mjs's business; verifyCitizenEvents checks presence.
      const out: Record<string, unknown> = { ...rest, leaf_index: Number(rest.id) - 1, proof: ["checked by verify.mjs"] };
      if (out.citizen_seq == null) {
        delete out.citizen_seq;
        delete out.citizen_prev;
        delete out.citizen_history;
      }
      return out;
    });
}

function headOf(rows: ChainRow[], citizenId: number) {
  const mine = rows.filter((r) => r.citizen_id === citizenId && r.citizen_seq != null);
  const last = mine[mine.length - 1];
  return { seq: Number(last.citizen_seq), hash: String(last.hash), event_id: Number(last.id) };
}

// Citizen 4 holds five events in MIXED; that is the dossier's signed events_total.
const CP = { tree_size: MIXED.length, created_at: T + 100 };
const TOTAL4 = { eventsTotal: 5, checkpoint: CP };

test("a whole dossier checks out complete against its signed events_total", async () => {
  const rows = await build(MIXED);
  const report = await verifyCitizenEvents(4, dossierEvents(rows, 4), headOf(rows, 4), TOTAL4);
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.first_v2_seq, 3);
  assert.equal(report.checked_through_seq, 5);
  assert.deepEqual(report.gaps, []);
  assert.equal(report.missing_events, 0);
});

test("without events_total the same dossier is undetermined, never a pass", async () => {
  const rows = await build(MIXED);
  const report = await verifyCitizenEvents(4, dossierEvents(rows, 4), headOf(rows, 4));
  assert.equal(report.ok, null);
  assert.match(report.note, /events_total/);
});

test("a dossier with one v2 event removed reports the gap by number", async () => {
  const rows = await build(MIXED);
  const events = dossierEvents(rows, 4).filter((e) => e.kind !== "moderation"); // drop seq 4
  const report = await verifyCitizenEvents(4, events, headOf(rows, 4), TOTAL4);
  assert.equal(report.ok, false);
  assert.deepEqual(report.gaps, [{ from: 4, to: 4 }]);
  assert.equal(report.missing_events, 1);
});

test("the newest event dropped AND citizen_head moved back to match is caught by the signed count", async () => {
  // The registry serves seq 1..4 and a head naming seq 4 with its real proof:
  // the numbers are contiguous and the head agrees, so only events_total, which
  // sits in the signed core, can show the tail is gone.
  const rows = await build(MIXED);
  const events = dossierEvents(rows, 4).slice(0, -1);
  const lyingHead = { seq: 4, hash: String(events[events.length - 1].hash) };
  const report = await verifyCitizenEvents(4, events, lyingHead, TOTAL4);
  assert.equal(report.ok, false);
  assert.equal(report.missing_events, 1);
  assert.ok(report.problems.some((p) => /events_total is 5/.test(p)), JSON.stringify(report.problems));
  // The same dossier with no count to check against cannot be passed either.
  assert.equal((await verifyCitizenEvents(4, events, lyingHead)).ok, null);
});

test("a run of the newest events dropped is caught by the signed count", async () => {
  const rows = await build(MIXED);
  const events = dossierEvents(rows, 4).slice(0, 3); // seq 1..3 of 5
  const lyingHead = { seq: 3, hash: String(events[2].hash) };
  const report = await verifyCitizenEvents(4, events, lyingHead, TOTAL4);
  assert.equal(report.ok, false);
  assert.equal(report.missing_events, 2);
});

test("a dossier missing its newest events is also caught against an honest citizen_head", async () => {
  const rows = await build(MIXED);
  const events = dossierEvents(rows, 4).slice(0, -1); // drop seq 5, the key-revoke
  const report = await verifyCitizenEvents(4, events, headOf(rows, 4), TOTAL4);
  assert.equal(report.ok, false);
  assert.deepEqual(report.gaps, [{ from: 5, to: 5 }]);
});

test("a dossier missing a v1 event before the first v2 event is caught by the count", async () => {
  const rows = await build(MIXED);
  const events = dossierEvents(rows, 4).filter((e) => e.detail !== "bound k1");
  const report = await verifyCitizenEvents(4, events, headOf(rows, 4), TOTAL4);
  assert.equal(report.ok, false);
  assert.deepEqual(report.gaps, [{ from: 2, to: 2 }]);
});

test("an edited event is a problem, not a gap", async () => {
  const rows = await build(MIXED);
  const events = dossierEvents(rows, 4);
  events[4].detail = "revoked nothing";
  const report = await verifyCitizenEvents(4, events, headOf(rows, 4), TOTAL4);
  assert.equal(report.ok, false);
  assert.ok(report.problems.some((p) => /hash/.test(p)), JSON.stringify(report.problems));
});

test("a head whose hash disagrees with the event at its number is a problem", async () => {
  const rows = await build(MIXED);
  const head = { ...headOf(rows, 4), hash: "ee".repeat(32) };
  const report = await verifyCitizenEvents(4, dossierEvents(rows, 4), head, TOTAL4);
  assert.equal(report.ok, false);
  assert.ok(report.problems.some((p) => /citizen_head/.test(p)));
});

test("a citizen with no v2 events is undetermined (presence only), and a short count still fails", async () => {
  const rows = await build(MIXED);
  const v1Only = dossierEvents(rows, 1); // two v1 events
  const report = await verifyCitizenEvents(1, v1Only, null, { eventsTotal: 2 });
  assert.equal(report.ok, null);
  assert.equal(report.first_v2_seq, null);
  assert.equal(report.checked_through_seq, null);
  assert.match(report.note, /presence/);
  // Serving only some of a citizen's events with no head: the signed count shows it.
  const short = await verifyCitizenEvents(1, v1Only.slice(0, 1), null, { eventsTotal: 2 });
  assert.equal(short.ok, false);
  assert.equal(short.missing_events, 1);
  // A citizen on v2 served as if it had no v2 events (its v2 events and head withheld).
  const v1Part = dossierEvents(rows, 4).slice(0, 2);
  const hidden = await verifyCitizenEvents(4, v1Part, null, TOTAL4);
  assert.equal(hidden.ok, false);
  assert.equal(hidden.missing_events, 3);
});

test("a later window (not from the start) shows gaps but cannot prove completeness", async () => {
  const rows = await build(MIXED);
  const events = dossierEvents(rows, 4).slice(3); // seq 4 and 5 only
  const report = await verifyCitizenEvents(4, events, headOf(rows, 4), { fromStart: false, eventsTotal: 5 });
  assert.equal(report.ok, null, JSON.stringify(report));
  assert.deepEqual(report.gaps, []);
  assert.deepEqual(report.problems, []);
});
