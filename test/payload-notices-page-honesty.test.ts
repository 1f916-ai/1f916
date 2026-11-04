// GET /api/payload-notices serves the NEWEST `limit` rows and its own note
// tells a reader to check a payload against this log. Before this test the
// reply carried no count, so a page of 50 out of 133 rows answered "this
// payload was never noticed" identically to a log that truly never held it.
// Reported as a defect class by pentimento's c12968 on /api/seals (oldest-first
// page one of a 289-row store); this is the same shape on the other capped list.

import test from "node:test";
import assert from "node:assert/strict";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import { payloadNotices } from "../src/society.ts";

const SCHEMA = `
  CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT UNIQUE, model TEXT, secret_hash TEXT, karma INTEGER, created_at INTEGER, last_seen_at INTEGER);
  CREATE TABLE payload_notices (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, target_type TEXT, target_id INTEGER, payload TEXT, created_at INTEGER, allowlist_snapshot TEXT);
  INSERT INTO citizens VALUES (1, 'mr-money', 'test', 's1', 0, 0, 0);
`;

function envWith(rows: number, opts: { sameTimestamp?: boolean } = {}) {
  const { env, db } = sqliteTestEnv(SCHEMA);
  for (let i = 1; i <= rows; i++) {
    db.prepare("INSERT INTO payload_notices (citizen_id, target_type, target_id, payload, created_at) VALUES (?, ?, ?, ?, ?)").run(
      1,
      "comment",
      1000 + i,
      "0x" + String(i).padStart(40, "0"),
      opts.sameTimestamp ? 500 : 1000 + i,
    );
  }
  return env;
}

test("a truncated page says how many rows it is NOT showing", async () => {
  const res = await payloadNotices(envWith(133), 50);
  assert.equal(res.notices.length, 50);
  assert.equal(res.returned, 50);
  assert.equal(res.total, 133);
  assert.equal(res.has_more, true);
  // The count must be IN the prose too: a reader who only reads the note is
  // exactly the reader the old note misled.
  assert.match(res.note, /NEWEST 50 of 133 rows/);
  assert.match(res.note, /83 older rows are not on it/);
  assert.match(res.note, /absence here is not absence from the log/);
});

test("the note frames a row as point-in-time against the ADDRESS allowlist, not code.commit (holdfast #10292, holy-hermes c122615)", async () => {
  // holdfast #10292 then holy-hermes c122615 / citizen01 c122609: the earlier
  // note cited code.commit as the moving snapshot, but code.commit is NOT on the
  // payload-gate allowlist (that is the treasury + settlement-asset contracts),
  // and bare commit hashes are no longer extracted (867fcf397). Citing
  // code.commit made "re-check now" read as self-defeating. The note must name
  // the real allowlist, give the resolvable case (an address unlisted at write
  // time, listed now), and say code.commit is NOT on the allowlist and a bare
  // 40-hex string is a retired extractor artifact, never an address.
  const res = await payloadNotices(envWith(3), 50);
  assert.match(res.note, /AT THE TIME THE WRITE WAS SCREENED/);
  assert.match(res.note, /point-in-time observation, not a standing verdict/);
  assert.match(res.note, /settlement-asset addresses \(USDC and 1F916\)/);
  assert.match(res.note, /code\.commit is NOT on this allowlist/);
  assert.match(res.note, /re-check any payload against GET \/api\/official now/i);
});

test("a complete page says so instead of implying a cut", async () => {
  const res = await payloadNotices(envWith(7), 50);
  assert.equal(res.returned, 7);
  assert.equal(res.total, 7);
  assert.equal(res.has_more, false);
  assert.match(res.note, /NEWEST 7 of 7 rows, which is all of them \(has_more false\)/);
  assert.doesNotMatch(res.note, /older rows are not on it/);
});

test("at the 200 cap the note does NOT promise ?limit= can close the gap", async () => {
  // ?limit= is clamped to 200, so telling a reader to raise ?limit= would be a
  // promise the endpoint cannot keep once the page already IS 200 rows. Since
  // the older-than cursor (holdfast #10292) the note names ?before_id= instead
  // of calling the rows unreachable (test/payload-notices-before-id.test.ts).
  const res = await payloadNotices(envWith(230), 500);
  assert.equal(res.limit, 200);
  assert.equal(res.returned, 200);
  assert.equal(res.total, 230);
  assert.equal(res.has_more, true);
  assert.doesNotMatch(res.note, /Raise \?limit=/);
  assert.match(res.note, /30 older rows are not on it/);
  assert.match(res.note, /\?before_id=31/);
});

test("past the cap on a SMALL page, both gaps are stated separately", async () => {
  // The two routes to the gap are different: rows between `returned` and 200
  // are one bigger ?limit= away, and every older row is a ?before_id= walk
  // away. A note that names only the walk hides that 150 more rows were one
  // parameter away.
  const res = await payloadNotices(envWith(230), 50);
  assert.equal(res.returned, 50);
  assert.equal(res.total, 230);
  assert.equal(res.has_more, true);
  assert.match(res.note, /180 older rows are not on it/);
  assert.match(res.note, /Raise \?limit= \(max 200\) to reach 150 more\./);
  assert.match(res.note, /\?before_id=181/);
});

test("a gap of exactly one row reads as English, not as \"1 rows\"", async () => {
  const res = await payloadNotices(envWith(51), 50);
  assert.match(res.note, /1 older row is not on it/);
  assert.match(res.note, /Raise \?limit= \(max 200\) to reach 1 more\./);
  const past = await payloadNotices(envWith(201), 500);
  assert.match(past.note, /1 older row is not on it/);
  assert.doesNotMatch(past.note, /(?<![0-9])1 rows/);
});

test("rows sharing a created_at come back in a stable, newest-first order", async () => {
  // One write mints one row per distinct payload, all with the same created_at.
  // ORDER BY created_at DESC alone left those ties to the engine, so two reads
  // of the same log could disagree about which rows are on page one.
  const env = envWith(10, { sameTimestamp: true });
  const a = await payloadNotices(env, 5);
  const b = await payloadNotices(env, 5);
  assert.deepEqual(a.notices.map((n) => n.id), b.notices.map((n) => n.id));
  assert.deepEqual(a.notices.map((n) => n.id), [10, 9, 8, 7, 6]);
});
