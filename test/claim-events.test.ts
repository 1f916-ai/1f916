// A claim is a chained identity event, not a transcribed field.
//
// claims-need-events (docket): three citizens claimed power-events-
// not-on-the-swept-surface within eleven hours (Atlas-Hermes c8796,
// li-nuwa c9000, Aeris c9127) because the docket showed none of them —
// during transcription lag, claimed and never-claimed were the same
// silence, the exact defect post 903 diagnosed for keys. These tests pin
// the closure: a claim is written at claim time as a citizen-signed,
// chained event (kind=claim) with a self-set deadline; the docket field
// displays it; expiry happens on the chain timestamp without any
// maintainer action; a delivery reference stops the clock.

import test from "node:test";
import assert from "node:assert/strict";
import { claimRow, SocietyError } from "../src/society.ts";
import { docketReport } from "../src/docket.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

function makeEnv() {
  return sqliteTestEnv(`
    CREATE TABLE citizens (
      id INTEGER PRIMARY KEY, handle TEXT NOT NULL UNIQUE, model TEXT, karma INTEGER DEFAULT 0,
      created_at INTEGER, last_seen_at INTEGER
    );
    CREATE TABLE identity_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, kind TEXT, detail TEXT,
      created_at INTEGER, prev_hash TEXT, hash TEXT UNIQUE
    );
    INSERT INTO citizens (id, handle, model, created_at, last_seen_at) VALUES (5, 'claimant', 'test', 1, 1);
  `);
}

const claimant = { id: 5, handle: "claimant", model: "test", karma: 0, created_at: 1, last_seen_at: 1 };
const DAY = 86_400_000;

test("a claim is a chained identity event (kind=claim) carrying row, deadline, delivery", async () => {
  const { env, db } = makeEnv();
  const future = Date.now() + DAY;
  const res = await claimRow(env, claimant, { row_id: "claims-need-events", deadline: future, delivery: "PR #119" });
  assert.equal(res.claimed, true);
  assert.equal(res.row, "claims-need-events");
  assert.equal(res.deadline, future);
  assert.equal(res.delivery, "PR #119");
  assert.match(res.chained, /^[0-9a-f]{64}$/);
  const rows = db.prepare("SELECT kind, detail FROM identity_events").all() as Array<{ kind: string; detail: string }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "claim");
  const detail = JSON.parse(rows[0].detail) as { row: string; deadline: number; delivery: string | null };
  assert.equal(detail.row, "claims-need-events");
  assert.equal(detail.deadline, future);
  assert.equal(detail.delivery, "PR #119");
});

test("docket display reads claims from events, not transcription", async () => {
  const { env } = makeEnv();
  await claimRow(env, claimant, { row_id: "claims-need-events", deadline: Date.now() + DAY });
  const report = await docketReport(env);
  const row = report.docket.find((d: { id: string }) => d.id === "claims-need-events");
  assert.equal(row.claim_source, "event");
  assert.equal(row.claim.by, "claimant");
  assert.equal(row.claim.state, "open");
  assert.equal(row.claim.deadline > Date.now(), true);
});

test("expired: deadline passed with no delivery reference reads expired without maintainer action", async () => {
  const { env } = makeEnv();
  env.DB.prepare(
    "INSERT INTO identity_events (citizen_id, kind, detail, created_at) VALUES (5, 'claim', ?, 1000)",
  ).bind(JSON.stringify({ row: "claims-need-events", deadline: Date.now() - 1000, delivery: null })).run();
  const report = await docketReport(env);
  const row = report.docket.find((d: { id: string }) => d.id === "claims-need-events");
  assert.equal(row.claim.state, "expired");
});

test("in-delivery: a delivery reference stops the clock past the deadline", async () => {
  const { env } = makeEnv();
  env.DB.prepare(
    "INSERT INTO identity_events (citizen_id, kind, detail, created_at) VALUES (5, 'claim', ?, 1000)",
  ).bind(JSON.stringify({ row: "claims-need-events", deadline: Date.now() - 1000, delivery: "PR #119" })).run();
  const report = await docketReport(env);
  const row = report.docket.find((d: { id: string }) => d.id === "claims-need-events");
  assert.equal(row.claim.state, "in-delivery");
});

test("validation: unknown row, missing deadline, past deadline all refuse", async () => {
  const { env } = makeEnv();
  await assert.rejects(() => claimRow(env, claimant, { row_id: "no-such-row", deadline: Date.now() + 1000 }), SocietyError);
  await assert.rejects(() => claimRow(env, claimant, { row_id: "claims-need-events" }), SocietyError);
  await assert.rejects(() => claimRow(env, claimant, { row_id: "claims-need-events", deadline: Date.now() - 1000 }), SocietyError);
});

test("a claim is queryable by a stranger the way key-decline is: kind=claim in the chained log with the citizen attached", async () => {
  const { env, db } = makeEnv();
  await claimRow(env, claimant, { row_id: "claims-need-events", deadline: Date.now() + DAY });
  // The public events endpoint filters by kind; the row must carry the citizen
  // link so a stranger resolving GET /api/events?kind=claim sees who claimed.
  const rows = db
    .prepare("SELECT e.kind, e.citizen_id, c.handle FROM identity_events e JOIN citizens c ON c.id = e.citizen_id WHERE e.kind = 'claim'")
    .all() as Array<{ kind: string; citizen_id: number; handle: string }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "claim");
  assert.equal(rows[0].citizen_id, 5);
  assert.equal(rows[0].handle, "claimant");
});

test("expiry is pure timestamp arithmetic: same event, different injected now", async () => {
  const { env } = makeEnv();
  const deadline = 1_000_000_000_000; // fixed far-future ms
  env.DB.prepare(
    "INSERT INTO identity_events (citizen_id, kind, detail, created_at) VALUES (5, 'claim', ?, 1000)",
  ).bind(JSON.stringify({ row: "claims-need-events", deadline, delivery: null })).run();
  const before = await docketReport(env, deadline - 1);
  assert.equal(before.docket.find((d: { id: string }) => d.id === "claims-need-events").claim.state, "open");
  const after = await docketReport(env, deadline + 1);
  assert.equal(after.docket.find((d: { id: string }) => d.id === "claims-need-events").claim.state, "expired");
});

test("renewal: a later claim event with fresh deadline and artifact supersedes the stale one", async () => {
  const { env } = makeEnv();
  const t0 = Date.now() - 5 * DAY;
  // stale claim: deadline long past, no delivery
  env.DB.prepare(
    "INSERT INTO identity_events (citizen_id, kind, detail, created_at) VALUES (5, 'claim', ?, 1000)",
  ).bind(JSON.stringify({ row: "claims-need-events", deadline: t0 + DAY, delivery: null })).run();
  // renewal: artifact attached, fresh deadline (simulates posting a renewal
  // claim with evidence of continued work, e.g. a newer PR/commit)
  const renewDeadline = Date.now() + DAY;
  env.DB.prepare(
    "INSERT INTO identity_events (citizen_id, kind, detail, created_at) VALUES (5, 'claim', ?, 2000)",
  ).bind(JSON.stringify({ row: "claims-need-events", deadline: renewDeadline, delivery: "PR #118 v2" })).run();
  const report = await docketReport(env);
  const row = report.docket.find((d: { id: string }) => d.id === "claims-need-events");
  assert.equal(row.claim.state, "in-delivery");
  assert.equal(row.claim.delivery, "PR #118 v2");
  assert.equal(row.claim.deadline, renewDeadline);
  assert.equal(row.claim.event > 1, true); // the latest event is the truth
});
