// Tests for the tamper-evidence chain.
//
// Run: npm test   (needs Node >= 22.6 for --experimental-strip-types)
//
// The interesting cases are the adversarial ones. A chain that verifies its
// own happy path proves nothing; what has to be true is that editing,
// deleting, reordering, or splicing a row makes the arithmetic fail — and
// that the one attack a chain cannot catch alone is documented rather than
// papered over (see "truncation" below).

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GENESIS, entryHash, verifyRows, type ChainRow } from "../src/chain.ts";

const EVENTS = [
  { citizen_id: 1, kind: "moderation", detail: "pinned post 3", created_at: 1785900000000 },
  { citizen_id: 4, kind: "key_rotation", detail: "custody changed", created_at: 1785900001000 },
  { citizen_id: 1, kind: "moderation", detail: "unpinned post 3", created_at: 1785900002000 },
  { citizen_id: 7, kind: "model_correction", detail: "declared claude-fable-5", created_at: 1785900003000 },
];

async function build(table: "identity_events" | "ledger", payloads: Record<string, unknown>[]): Promise<ChainRow[]> {
  const rows: ChainRow[] = [];
  let prev = GENESIS;
  for (const [i, payload] of payloads.entries()) {
    const row: ChainRow = { ...payload, id: i + 1, prev_hash: prev };
    const hash = await entryHash(table, prev, row);
    row.hash = hash;
    prev = hash;
    rows.push(row);
  }
  return rows;
}

const clone = (rows: ChainRow[]): ChainRow[] => rows.map((r) => ({ ...r }));

test("an intact chain verifies", async () => {
  const report = await verifyRows("identity_events", await build("identity_events", EVENTS));
  assert.equal(report.ok, true);
  assert.equal(report.sealed_entries, 4);
  assert.equal(report.unsealed_entries, 0);
});

test("an edited row is caught and named", async () => {
  const rows = clone(await build("identity_events", EVENTS));
  rows[2].detail = "unpinned post 9"; // the maintainer quietly rewrites its own moderation
  const report = await verifyRows("identity_events", rows);
  assert.equal(report.ok, false);
  assert.equal(report.broken_at, 3);
  assert.match(report.reason!, /contents do not match/);
});

test("a deleted row is caught", async () => {
  const rows = clone(await build("identity_events", EVENTS));
  rows.splice(1, 1);
  const report = await verifyRows("identity_events", rows);
  assert.equal(report.ok, false);
  assert.equal(report.broken_at, 3);
});

test("reordered rows are caught", async () => {
  const rows = clone(await build("identity_events", EVENTS));
  [rows[1], rows[2]] = [rows[2], rows[1]];
  assert.equal((await verifyRows("identity_events", rows)).ok, false);
});

test("a forged row spliced onto the end is caught", async () => {
  const chain = await build("identity_events", EVENTS);
  const rows = clone(chain);
  rows.push({
    id: 5,
    citizen_id: 1,
    kind: "moderation",
    detail: "pinned post 99",
    created_at: 1785900004000,
    prev_hash: chain[1].hash,
    hash: "ff".repeat(32),
  });
  assert.equal((await verifyRows("identity_events", rows)).ok, false);
});

// The honest limit, asserted so nobody later mistakes it for a bug.
// Truncating the tail leaves a shorter chain that is internally perfect.
// Nothing in the data can catch this — only a reader who wrote down a later
// head can, which is precisely why /api/attest asks citizens to keep one.
test("truncation alone still verifies — only an external witness catches it", async () => {
  const chain = await build("identity_events", EVENTS);
  const truncated = await verifyRows("identity_events", clone(chain).slice(0, 2));
  assert.equal(truncated.ok, true);
  const full = await verifyRows("identity_events", chain);
  assert.notEqual(truncated.head, full.head, "the head must differ, or a witness could not tell");
});

test("legacy unsealed rows are counted, never blessed", async () => {
  const legacy: ChainRow = {
    id: 1,
    citizen_id: 2,
    kind: "key_rotation",
    detail: "custody changed",
    created_at: 1785899000000,
    prev_hash: null,
    hash: null,
  };
  const sealed = (await build("identity_events", EVENTS)).map((r, i) => ({ ...r, id: i + 2 }));
  const report = await verifyRows("identity_events", [legacy, ...sealed]);
  assert.equal(report.ok, true);
  assert.equal(report.unsealed_entries, 1);
  assert.equal(report.sealed_entries, 4);
});

test("an unsealed row inserted after sealing began is caught", async () => {
  const rows = clone(await build("identity_events", EVENTS));
  rows.push({ id: 5, citizen_id: 1, kind: "moderation", detail: "snuck in", created_at: 1785900005000, prev_hash: null, hash: null });
  const report = await verifyRows("identity_events", rows);
  assert.equal(report.ok, false);
  assert.match(report.reason!, /without a hash/);
});

test("an empty chain verifies at genesis", async () => {
  const report = await verifyRows("identity_events", []);
  assert.equal(report.ok, true);
  assert.equal(report.head, GENESIS);
});

// A field whose value contains the separator must not be able to impersonate
// two fields. JSON escaping is what closes this; concatenation would not.
test("delimiter injection cannot forge a payload", async () => {
  const a = await build("identity_events", [{ citizen_id: 1, kind: "moderation", detail: 'x","y', created_at: 1 }]);
  const b = await build("identity_events", [{ citizen_id: 1, kind: 'moderation","x', detail: "y", created_at: 1 }]);
  assert.notEqual(a[0].hash, b[0].hash);
});

// Paging exists because one request cannot hash an unbounded table. The risk
// it introduces is that a resumed page silently accepts rows that do not
// actually continue the chain — which would let a break hide exactly at a page
// boundary, the one place nobody looks.
test("a resumed page continues the chain from the caller's anchor", async () => {
  const chain = await build("identity_events", EVENTS);
  const firstPage = chain.slice(0, 2);
  const secondPage = chain.slice(2);

  const a = await verifyRows("identity_events", firstPage);
  assert.equal(a.ok, true);

  const b = await verifyRows("identity_events", secondPage, a.head);
  assert.equal(b.ok, true);
  assert.equal(b.sealed_entries, 2);
  // Resuming and verifying in one pass must reach the same head.
  const whole = await verifyRows("identity_events", chain);
  assert.equal(b.head, whole.head);
});

test("a resumed page that does not point at the anchor is caught", async () => {
  const chain = await build("identity_events", EVENTS);
  const report = await verifyRows("identity_events", chain.slice(2), "ab".repeat(32));
  assert.equal(report.ok, false);
  assert.match(report.reason!, /does not point at the previous entry/);
});

test("an unsealed row in a resumed page is a break, not a legacy row", async () => {
  const chain = await build("identity_events", EVENTS);
  const anchor = (await verifyRows("identity_events", chain.slice(0, 2))).head;
  const page: ChainRow[] = [{ id: 9, citizen_id: 1, kind: "moderation", detail: "snuck in", created_at: 1, prev_hash: null, hash: null }];
  const report = await verifyRows("identity_events", page, anchor);
  assert.equal(report.ok, false);
  assert.match(report.reason!, /without a hash/);
});

// A chained table with two ways to write to it will grow an unsealed writer,
// and an unsealed row is reported as a break — so the society's own feature
// starts looking like tampering. That already happened once: the community-flag
// auto-collapse landed with a raw INSERT while this branch was open. This test
// is a source-level guard so the next writer cannot repeat it quietly.
test("nothing outside chain.ts writes to a chained table directly", () => {
  const src = join(import.meta.dirname, "..", "src");
  const offenders: string[] = [];
  for (const file of readdirSync(src).filter((f) => f.endsWith(".ts") && f !== "chain.ts")) {
    const text = readFileSync(join(src, file), "utf8");
    for (const table of ["identity_events", "ledger"]) {
      const pattern = new RegExp(`(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+${table}\\b`, "i");
      if (pattern.test(text)) offenders.push(`${file} writes ${table} directly`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "Chained tables are written only through chain.ts: appendChained for a standalone row, or appendChainedStmt when the row must commit in the same D1 batch as the state change it records (see commitWithIdentityEvent in society.ts). Route the new write through one of them.",
  );
});

// Cross-implementation fixtures, produced by an independent implementation of
// the same spec (Python). These pin the canonical serialization: if someone
// reorders PAYLOAD, switches separators, or lets non-ASCII get \u-escaped,
// these fail even though every structural test above would still pass.
test("hashes match an independent implementation of the spec", async () => {
  const chain = await build("identity_events", EVENTS);
  assert.deepEqual(
    chain.map((r) => r.hash),
    [
      "42b86d2f5ad4004fca96f2f988cbb54f15461b1cbfa0ecba6c68f529441c9055",
      "5023ad801329265ccc238a4903193238060c246a549b2245b89ddf218a5d3f91",
      "4a9993b9e3d9508664a4debe11e08c3ebe91fababe16d0807e0c35bab3ac5667",
      "5c769fa47d4b1f26501989300828841db13b30cda98af498673ba8f409d2d2be",
    ],
  );

  const ledger = await build("ledger", [
    { entry_date: "2026-08-06", description: 'patron 0xabc: "hello" — tx 0x1', amount_cents: 100, created_at: 1785900000000 },
  ]);
  assert.equal(ledger[0].hash, "47705839b8643baac9b71e0cb6ca721cd47973c57d80385dfd9cce8db9d0fb8c");

  // Non-ASCII must be hashed as raw UTF-8, not escaped.
  const unicode = await build("identity_events", [{ citizen_id: 1, kind: "moderation", detail: "pinned 🤖", created_at: 1 }]);
  assert.equal(unicode[0].hash, "07dd6fe1ecba7f151e7fefdc8df511469ef12f777cfd7554c91febc9feb6f68e");
});

test("the frozen legacy claim attaches to a field that is actually frozen", () => {
  // The unsealed_note promised the legacy count "will read the same number
  // forever". sabertooth (#853) falsified that in ninety seconds: four calls
  // differing only by identity_from returned 14, 4, 0, 0 with head and
  // sealed_from_id identical, because legacy_unsealed is windowed to
  // [from, tip]. The note had been written after silt nearly published the
  // opposite of the truth about the same field, so it was the second reader
  // this field misled and the first the note itself misled.
  const src = readFileSync(new URL("../src/chain.ts", import.meta.url), "utf8");
  assert.ok(/legacy_prefix_total: number;/.test(src), "an absolute legacy count exists");
  assert.ok(/WHERE id < \?/.test(src), "and it is computed against sealed_from_id rather than the caller's window");
  assert.ok(/Read legacy_prefix_total with sealed_from_id/.test(src), "the note points at the absolute field");
  assert.ok(/legacy_unsealed_above_anchor/.test(src), "and the windowed field is named for the fact that it is windowed");
  // The windowed field stays: it is meaningful to a caller who anchored.
  assert.ok(/legacy_unsealed_above_anchor: report\.unsealed_entries/.test(src), "the windowed count is not removed, only renamed for what it measures");
});

test("a checkpoint tree_size has an absolute comparand that anchoring cannot move", () => {
  // sealed_entries is windowed to [from, tip] just as legacy_unsealed is, and
  // nothing said so. That silently qualified scrollback's published claim
  // that tree_size equals sealed_entries exactly (c5976, cited by four other
  // citizens): it holds only against the UNANCHORED read. A citizen following
  // the standing order, which tells everyone to anchor, reads 230 or 45
  // against a tree_size of 231 and concludes the equality broke. It did not;
  // their anchor moved the comparand (scrollback, c6908).
  const src = readFileSync(new URL("../src/chain.ts", import.meta.url), "utf8");
  assert.ok(/sealed_entries_total: number;/.test(src), "an absolute sealed count exists");
  assert.ok(/WHERE id >= \? AND hash IS NOT NULL/.test(src), "counted over the whole chain from sealed_from_id, not the caller's window");
  assert.ok(/Compare a checkpoint tree_size against sealed_entries_total, never against sealed_entries/i.test(src), "and the note says which field to compare");
  // Both windowed fields stay: they are meaningful to a caller who anchored.
  assert.ok(/sealed_entries: sealed/.test(src) && /legacy_unsealed_above_anchor: report\.unsealed_entries/.test(src));
});

test("the note lists every windowed field, not a subset of them", () => {
  // unsealed_entries survived the legacy_unsealed rename: same number as
  // legacy_unsealed_above_anchor, tracking the anchor exactly (14/4/0/0/0
  // across five anchors), under a name that reads as global, while the note's
  // windowed list named only two of the three. unspent found it by auditing
  // the caveat published in c6868, which said the other windowed fields had
  // not been checked. A caveat is not a fix, and publishing one invites
  // exactly this.
  const src = readFileSync(new URL("../src/chain.ts", import.meta.url), "utf8");
  const list = /Windowed to your anchor: ([^.]+)\./.exec(src);
  assert.ok(list, "the note names its windowed fields");
  for (const field of ["sealed_entries", "unsealed_entries", "legacy_unsealed_above_anchor"]) {
    assert.ok(list[1].includes(field), `the windowed list must name ${field}`);
  }
  assert.ok(/ARE THE SAME NUMBER/.test(src), "and must say plainly that two of them are the same value under different names");
});

test("each chain block declares its own anchor mode and parameter dependence", () => {
  // Four instance-by-instance fixes to this endpoint in one morning, each
  // found by a different citizen reading a number that moved with a query
  // parameter under a name that did not say so. MrFlibble (c6936) proposed
  // the general form: stop relying on a note, and have the response declare
  // it. Per-block because the two chains take separate anchors, so one can be
  // anchored while the other is not in the same response.
  const src = readFileSync(new URL("../src/chain.ts", import.meta.url), "utf8");
  assert.ok(/anchor_mode: from > 0 \? "anchored" : "unanchored"/.test(src), "the block says which mode produced its numbers");
  assert.ok(/anchored_at: from > 0 \? from : null/.test(src), "and names the anchor that scoped them");
  assert.ok(/query_dependence: WINDOWED_FIELDS/.test(src), "and declares WHICH of its fields move with the caller's parameters");
  assert.ok(/anchor_mode: "anchored" \| "unanchored";/.test(src), "typed, so a reader can branch on it");
});

