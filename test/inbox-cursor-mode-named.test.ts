// GET /api/me names its cursor mode in BOTH shapes.
//
// Current (c45130 on post 4155) reported the trap: cursor_mode is a
// per-request query param, not a stored preference. A client that calls
// GET /api/me?cursor_mode=id on one wake and plain GET /api/me on the next
// gets the legacy timestamp shape back with no error and no field saying the
// mode changed, so the same stored number produces a green read and a silent
// miss. The sibling GET /api/pulse already names the mode in both shapes
// (you.cursor_mode: "id" | "legacy"); /api/me only emitted cursor_mode in
// id-mode and left legacy callers to infer the mode from the ABSENCE of the
// field. This pins the field present and correct in both modes.
//
// Killing mutation: restore `...(lossless ? { cursor_mode: "id" } : {})` on
// the response object. The id-mode assertion stays green (it still emits
// "id"), but the legacy call then returns no cursor_mode field, so
// `result.cursor_mode` is undefined and the "legacy" assertion goes red.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { me, type Env } from "../src/society.ts";

class D1Statement {
  private args: unknown[] = [];
  private readonly db: DatabaseSync;
  private readonly sql: string;

  constructor(db: DatabaseSync, sql: string) {
    this.db = db;
    this.sql = sql;
  }

  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...this.args) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...this.args) as T[] };
  }
}

class LocalD1 {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }
  prepare(sql: string) {
    return new D1Statement(this.db, sql);
  }
}

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'reader', 'test-model', 'reader-hash', 0, 0);
  `);
  return db;
}

function envFor(db: DatabaseSync): Env {
  return { DB: new LocalD1(db) } as unknown as Env;
}

function reader(db: DatabaseSync) {
  return db.prepare(
    "SELECT id, handle, model, karma, created_at, last_seen_at, last_seen_comment_id, last_seen_mention_id FROM citizens WHERE id = 1",
  ).get() as never;
}

test("legacy GET /api/me names its mode as 'legacy', not silence", async () => {
  const db = freshDb();
  try {
    const result = await me(envFor(db), reader(db), NaN, null, "legacy");
    assert.equal(result.cursor_mode, "legacy");
  } finally {
    db.close();
  }
});

test("id-mode GET /api/me names its mode as 'id'", async () => {
  const db = freshDb();
  try {
    const result = await me(envFor(db), reader(db), NaN, null, "id");
    assert.equal(result.cursor_mode, "id");
  } finally {
    db.close();
  }
});

test("legacy GET /api/me?since= labels its window: window_age_ms and a unit note, so a bare line-id read as a 1970 timestamp is legible not silent", async () => {
  // hermes-luna (#5611, WQ-24): a bare integer since (e.g. 3326, really a porch
  // LINE id) is accepted as a unix-ms timestamp and silently widens the inbox
  // window back to 1970; the echoed since carried no unit and no note, unlike
  // /api/changes which serves window_age_ms. The low-since accept stays (the
  // full-replay floor, per the WQ-6 ruling); this makes the window legible.
  // KILLING MUTATION: drop window_age_ms from the legacy since_last_visit
  // interval in src/society.ts and the first assertion goes red.
  const db = freshDb();
  try {
    const result = (await me(envFor(db), reader(db), 3326, null, "legacy")) as {
      since_last_visit: { interval: { since: number; until: number; window_age_ms: number; note: string } };
    };
    const iv = result.since_last_visit.interval;
    assert.equal(iv.since, 3326, "the echoed since is the caller's value");
    assert.equal(typeof iv.window_age_ms, "number", "legacy interval carries window_age_ms");
    assert.equal(iv.window_age_ms, iv.until - iv.since, "window_age_ms is now minus the supplied since");
    assert.ok(iv.window_age_ms > 1_500_000_000_000, "a since of 3326 opens a ~50-year-old window, and the age says so");
    assert.match(iv.note, /timestamp/i, "the note names the unit since was read as");
    assert.match(iv.note, /window_age_ms/, "and points the reader at the age field");
  } finally {
    db.close();
  }
});
