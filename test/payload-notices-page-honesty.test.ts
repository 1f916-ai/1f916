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
  CREATE TABLE payload_notices (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, target_type TEXT, target_id INTEGER, payload TEXT, created_at INTEGER);
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

test("a complete page says so instead of implying a cut", async () => {
  const res = await payloadNotices(envWith(7), 50);
  assert.equal(res.returned, 7);
  assert.equal(res.total, 7);
  assert.equal(res.has_more, false);
  assert.match(res.note, /NEWEST 7 of 7 rows, which is all of them \(has_more false\)/);
  assert.doesNotMatch(res.note, /older rows are not on it/);
});

test("at the 200 cap the note does NOT promise ?limit= can close the gap", async () => {
  // ?limit= is clamped to 200 and there is no older-than cursor, so telling a
  // reader to raise ?limit= would be a promise the endpoint cannot keep once
  // the page already IS 200 rows. Say the rows are unreachable here instead.
  const res = await payloadNotices(envWith(230), 500);
  assert.equal(res.limit, 200);
  assert.equal(res.returned, 200);
  assert.equal(res.total, 230);
  assert.equal(res.has_more, true);
  assert.doesNotMatch(res.note, /Raise \?limit=/);
  assert.match(res.note, /30 rows past that cap cannot be read here at all/);
});

test("past the cap on a SMALL page, both gaps are stated separately", async () => {
  // The two gaps are different: rows between `returned` and 200 are one bigger
  // ?limit= away, rows past 200 are unreachable at any limit. A note that
  // reports only the second tells a reader nothing is worth trying when 150
  // more rows were one parameter away.
  const res = await payloadNotices(envWith(230), 50);
  assert.equal(res.returned, 50);
  assert.equal(res.total, 230);
  assert.equal(res.has_more, true);
  assert.match(res.note, /180 older rows are not on it/);
  assert.match(res.note, /Raise \?limit= \(max 200\) to reach 150 more\./);
  assert.match(res.note, /30 rows past that cap cannot be read here at all/);
});

test("a gap of exactly one row reads as English, not as \"1 rows\"", async () => {
  const res = await payloadNotices(envWith(51), 50);
  assert.match(res.note, /1 older row is not on it/);
  assert.match(res.note, /Raise \?limit= \(max 200\) to reach 1 more\./);
  const past = await payloadNotices(envWith(201), 500);
  assert.match(past.note, /the 1 row past that cap cannot be read here at all/);
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
