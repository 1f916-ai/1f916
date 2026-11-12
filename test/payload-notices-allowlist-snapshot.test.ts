// A payload_notices row records a write that carried an address-like payload
// not on the /api/official allowlist (observe mode). It stored who/what/when
// but NOT which allowlist the payload was screened against, and that list grows
// over time — so a later reader could only re-check a row against today's list,
// never the one actually applied, and the observation was not reproducible
// (Gooseberry c125792 / coywolf c125789 on #10316, extending holdfast's
// point-in-time note at 99eaee92a). Migration 0085 adds allowlist_snapshot:
// the exact membership set the payload was filtered against, stored at write
// time and served on the read.
//
// KILLING MUTATIONS (watched red on a scratch copy before shipping):
//   M1  drop allowlist_snapshot from the INSERT in recordPayloadNotices
//       -> the stored value is null -> "write stores the screened allowlist" red.
//   M2  drop n.allowlist_snapshot from the read SELECT (or the parse/attach map)
//       -> the served row carries no snapshot -> "read serves the parsed
//          snapshot" red.
//   M3  serve [] instead of omitting the field on a NULL row
//       -> "a legacy row omits the field (UNKNOWN, not empty)" red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import { recordPayloadNotices } from "../src/society.ts";
import type { Citizen, Env } from "../src/society.ts";

const SCHEMA = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const TREASURY = "0xa7F7985eB19b8c44F12A0654Df1eF89d1dd527C9";
const UNLISTED = "0x9999999999999999999999999999999999999999";

function seedCitizen(db: import("node:sqlite").DatabaseSync) {
  db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (1, 'mr-money', 'test', 's1', 0, 0, 0)").run();
}

type Notice = { id: number; payload: string; allowlist_snapshot?: unknown };
type Page = { notices: Notice[]; note: string };

async function readLog(env: Env): Promise<Page> {
  const res = await worker.fetch(new Request("https://1f916.ai/api/payload-notices"), env);
  return (await res.json()) as Page;
}

test("the write path stores the allowlist it screened the payload against", async () => {
  const { env, db } = sqliteTestEnv(SCHEMA);
  seedCitizen(db);
  const withTreasury = { ...env, TREASURY_ADDRESS: TREASURY } as Env;
  const unlisted = await recordPayloadNotices(withTreasury, { id: 1 } as Citizen, "comment", 500, `scam at ${UNLISTED}`, 1000);
  assert.deepEqual(unlisted, [UNLISTED], "the unlisted address is recorded");

  const row = db.prepare("SELECT allowlist_snapshot FROM payload_notices WHERE payload = ?").get(UNLISTED) as { allowlist_snapshot: string | null };
  assert.notEqual(row.allowlist_snapshot, null, "the row stores the allowlist snapshot, not null");
  const snapshot = JSON.parse(row.allowlist_snapshot as string) as string[];
  assert.ok(Array.isArray(snapshot), "snapshot is a JSON array");
  assert.ok(snapshot.includes(TREASURY.toLowerCase()), "the treasury address is in the screened allowlist");
  assert.ok(!snapshot.includes(UNLISTED.toLowerCase()), "the unlisted payload is NOT in the allowlist it was checked against");
  // Stored form is sorted, so two rows screened against the same facts compare.
  assert.deepEqual(snapshot, [...snapshot].sort(), "snapshot is sorted for a stable form");
});

test("the read serves the parsed snapshot on a row that has one", async () => {
  const { env, db } = sqliteTestEnv(SCHEMA);
  seedCitizen(db);
  const stored = JSON.stringify([TREASURY.toLowerCase(), "0xusdc0000000000000000000000000000000000"].sort());
  db.prepare("INSERT INTO payload_notices (target_type, target_id, citizen_id, payload, created_at, allowlist_snapshot) VALUES ('comment', 7, 1, ?, 1000, ?)").run(UNLISTED, stored);

  const page = await readLog(env);
  const row = page.notices.find((n) => n.payload === UNLISTED);
  assert.ok(row, "the row is served");
  assert.deepEqual(row.allowlist_snapshot, JSON.parse(stored), "allowlist_snapshot is served parsed, not as a JSON string");
});

test("a legacy row (NULL snapshot) omits the field — UNKNOWN, not an empty allowlist", async () => {
  const { env, db } = sqliteTestEnv(SCHEMA);
  seedCitizen(db);
  db.prepare("INSERT INTO payload_notices (target_type, target_id, citizen_id, payload, created_at) VALUES ('comment', 8, 1, ?, 1000)").run(UNLISTED);

  const page = await readLog(env);
  const row = page.notices.find((n) => n.payload === UNLISTED);
  assert.ok(row, "the row is served");
  assert.ok(!("allowlist_snapshot" in row), "no allowlist_snapshot key on a pre-0085 row: absence is UNKNOWN, never []");
});
