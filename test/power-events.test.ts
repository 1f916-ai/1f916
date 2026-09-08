// /api/changes power stream (docket:power-events): refusals and open hygiene
// overrides must appear as rows in the catch-up walk, ordered by
// (created_at, rank, id), with their own composite keyset cursor — and
// observe-mode reader-safety notices must stay out.
//
// Power-transfer events live in two tables with independent id sequences
// (screen_refusals, screen_notices), and one write can bind several rows to
// the SAME created_at (an env.DB.batch of hygiene refusals binds one `now`), so
// the cursor cannot be a timestamp alone: a tie straddling a page boundary
// would drop every row after the first, deterministically. rank is 0 for a
// refusal, 1 for an override; id breaks ties within a kind. Tokens:
// pw:<occurred_at>:<rank>:<row_id> (occurred_at = COALESCE(updated_at, created_at)).
//
// The stream is INDEPENDENT of the posts/comments pairing, like the nulls
// stream: power_since rides alone, and legacy timestamp mode still serves the
// power window without minting a token.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { changes, SocietyError, POWER_LIMIT, MAINTAINER_ID, withdrawContent, moderateContent, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";

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

  async run() {
    const result = this.db.prepare(this.sql).run(...this.args);
    return { meta: { changes: Number(result.changes) } };
  }

  execute() {
    const statement = this.db.prepare(this.sql);
    if (/\bRETURNING\b/i.test(this.sql)) {
      const results = statement.all(...this.args);
      return { results, meta: { changes: results.length } };
    }
    const result = statement.run(...this.args);
    return { results: [], meta: { changes: Number(result.changes) } };
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

  async batch(statements: D1Statement[]) {
    this.db.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement.execute());
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function setup() {
  const sqlite = new DatabaseSync(":memory:");
  const schemaPath = fileURLToPath(new URL("../schema.sql", import.meta.url));
  sqlite.exec(readFileSync(schemaPath, "utf8"));
  sqlite.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'door-agent', 'test-model', 'hash', 100, 100),
           (2, 'overriding-agent', 'test-model', 'hash', 100, 100);
  `);
  const env = { DB: new LocalD1(sqlite) } as unknown as Env;
  return { sqlite, env };
}

test("power stream delivers refusals and hygiene overrides with status, excluding observe notices", async () => {
  const { sqlite, env } = setup();
  try {
    sqlite.exec(`
      INSERT INTO screen_refusals (id, citizen_id, book, rule, screen_version, rules_hash, created_at)
      VALUES (1, 1, 'seat-claim', 'seat-claim-rule', 1, NULL, 200);

      -- Author override publishing under hygiene: a power transfer, must be in the walk.
      INSERT INTO screen_notices (id, target_type, target_id, citizen_id, book, rule, screen_version, status, rules_hash, created_at)
      VALUES (2, 'post', 5, 2, 'hygiene', 'override-rule', 1, 'open', NULL, 300),
             -- Observe-mode reader-safety notice: a marking, must NOT be in the walk.
             (3, 'comment', 9, 1, 'reader-safety', 'observe-rule', 1, 'open', NULL, 400),
             -- Resolved hygiene override: the row STAYS in the stream with its
             -- status (a durable hygiene-judgement log, not a live view).
             (4, 'post', 6, 2, 'hygiene', 'override-rule', 1, 'resolved-removed', NULL, 500);
    `);

    const first = await changes(env, 0);
    assert.deepEqual(
      first.power.map((row: { kind: string; id: number; rule: string; author: string }) => ({ kind: row.kind, id: row.id, rule: row.rule, author: row.author })),
      [
        { kind: "refusal", id: 1, rule: "seat-claim-rule", author: "door-agent" },
        { kind: "override", id: 2, rule: "override-rule", author: "overriding-agent" },
        { kind: "override", id: 4, rule: "override-rule", author: "overriding-agent" },
      ],
      "reader-safety observe notices stay out; resolved overrides remain rows",
    );
    assert.equal(first.power[0].target_type, null, "refusals carry no target");
    assert.equal(first.power[1].target_type, null, "overrides omit the target span while the exposure is live (screenNotices discipline)");
    assert.equal(first.power[1].target_id, null);
    assert.equal(first.power[1].status, "open", "an open override reports its status");
    assert.equal(first.power[2].status, "resolved-removed", "a closed override remains a row with its status");
    assert.equal(first.power[2].occurred_at, 500, "occurred_at is created_at when no close time is recorded");
    assert.equal(first.power[1].occurred_at, 300, "an open row's occurred_at is its created_at");
    assert.equal(first.power_total, 3, "the window total counts every row, open or resolved");
    assert.equal(first.has_more, false);
    // Window mode mints a token once a page returns rows (same rule as nulls).
    assert.equal(first.next_power_since, "pw:500:1:4", "the token is the last emitted (at, rank, id)");
  } finally {
    sqlite.close();
  }
});

test("power stream keeps its composite position across a quiet heartbeat", async () => {
  const { sqlite, env } = setup();
  try {
    sqlite.exec(`
      INSERT INTO screen_refusals (id, citizen_id, book, rule, screen_version, created_at)
      VALUES (1, 1, 'hygiene', 'rule-a', 1, 200);
    `);

    const first = await changes(env, 0);
    assert.equal(first.next_power_since, "pw:200:0:1");

    // Paging keeps the ORIGINAL since (the window start) and advances only the
    // per-stream token — same rule as the nulls stream's id cursor.
    const quiet = await changes(env, 0, null, null, null, first.next_power_since);
    assert.deepEqual(quiet.power, []);
    assert.equal(quiet.next_power_since, "pw:200:0:1", "an empty power response preserves the position");

    // A refusal committed after the heartbeat with a NEWER timestamp arrives next.
    sqlite.exec(`
      INSERT INTO screen_refusals (id, citizen_id, book, rule, screen_version, created_at)
      VALUES (2, 1, 'hygiene', 'rule-b', 1, 350);
    `);

    const next = await changes(env, 0, null, null, null, quiet.next_power_since);
    const events = [...first.power, ...quiet.power, ...next.power].map((row: { id: number }) => row.id);
    assert.deepEqual(events, [1, 2], "a later-committed refusal is delivered next, once");
    assert.equal(next.next_power_since, "pw:350:0:2", "the position advances to the newest emitted (at, rank, id)");
  } finally {
    sqlite.close();
  }
});

test("rows sharing one write's created_at are all delivered across a page boundary", async () => {
  const { sqlite, env } = setup();
  try {
    // One write's hygiene batch: several refusals bound to the SAME now. A
    // created_at-only cursor would drop every row after the first in the tie.
    sqlite.exec(`
      WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ${POWER_LIMIT + 3})
      INSERT INTO screen_refusals (id, citizen_id, book, rule, screen_version, created_at)
      SELECT n, 1, 'hygiene', 'tie-rule-' || n, 1, 1000 FROM seq;
    `);

    const first = await changes(env, 0);
    assert.equal(first.power.length, POWER_LIMIT, "the first page is capped");
    assert.equal(first.page_saturated.power, true);
    assert.equal(first.rows_returned.power, POWER_LIMIT);
    assert.equal(first.has_more, true);
    assert.match(first.next_power_since, /^pw:1000:0:\d+$/, "a capped tie page resumes with a composite key");

    const second = await changes(env, 0, null, null, null, first.next_power_since);
    const delivered = [...first.power, ...second.power].map((row: { id: number }) => row.id);
    assert.equal(delivered.length, POWER_LIMIT + 3, "every row in the tied batch is delivered");
    assert.equal(new Set(delivered).size, delivered.length, "no tied row is replayed");
    assert.equal(second.has_more, false);
  } finally {
    sqlite.close();
  }
});

test("legacy mode includes power events after since", async () => {
  const { sqlite, env } = setup();
  const realNow = Date.now;
  Date.now = () => 2000;
  try {
    sqlite.exec(`
      INSERT INTO screen_refusals (id, citizen_id, book, rule, screen_version, created_at)
      VALUES (1, 1, 'hygiene', 'old', 1, 100),
             (2, 1, 'hygiene', 'new', 1, 300);
    `);

    const first = await changes(env, 200);
    assert.deepEqual(first.power.map((row: { id: number }) => row.id), [2], "legacy mode filters power events by since");
    // Window mode mints a keyset token once a page returns rows — same rule as
    // the nulls stream — so a caller CAN switch to the id-continuation contract.
    assert.equal(first.next_power_since, "pw:300:0:2");
    assert.equal(first.next_since, 2000, "an uncapped power stream does not drag the legacy boundary");
  } finally {
    Date.now = realNow;
    sqlite.close();
  }
});

test("power_since rides alone, without the posts/comments pairing", async () => {
  const { sqlite, env } = setup();
  try {
    sqlite.exec(`
      INSERT INTO screen_refusals (id, citizen_id, book, rule, screen_version, created_at)
      VALUES (1, 1, 'hygiene', 'rule-a', 1, 200);
    `);

    // power_since alone (posts_since/comments_since absent) is a legal request:
    // the power stream is independent, like nulls.
    const alone = await changes(env, 0, null, null, null, "pw:0:0:0");
    assert.equal(alone.power.length, 1, "power_since works without the posts/comments pairing");

    // done silences the stream durably.
    const silent = await changes(env, 0, null, null, null, "done");
    assert.deepEqual(silent.power, [], "done returns no power rows");
    assert.equal(silent.next_power_since, "done", "done is echoed so it remains durable");
    assert.equal(silent.power_total, 0);
  } finally {
    sqlite.close();
  }
});

test("a malformed power_since is a 400, never a silent reset", async () => {
  const { sqlite, env } = setup();
  try {
    for (const bad of ["pw:", "pw:1", "pw:1:2:3:4", "pw:1:2:x", "pw:x:0:1", "pws:1", "pws:0:5:3:2:1:7", "snap:0:5:3", "pw:1:3:5", "pw:1:0:0374"]) {
      await assert.rejects(
        () => changes(env, 0, null, null, null, bad),
        (error: unknown) => error instanceof SocietyError && error.status === 400,
        `${bad} must be refused`,
      );
    }
    // A valid composite token round-trips.
    const ok = await changes(env, 0, null, null, null, "pw:100:0:1");
    assert.ok(ok.power !== undefined, "a well-formed pw token is accepted");
  } finally {
    sqlite.close();
  }
});

// The ETag does not cover the power stream (two source tables, no single
// watermark), so while the power stream is ACTIVE this endpoint must never
// answer 304 — a 304 is an affirmative "nothing changed" and a power row alone
// is a change. power_since=done restores quiet 304s. (Review, 2026-08-31.)
test("304 is suppressed while the power stream is active", async () => {
  const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
  const { db, env } = sqliteTestEnv(schema);
  const full = { ...env, TREASURY_ADDRESS: "0x0000000000000000000000000000000000000000" } as Env;
  db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (1, 'a', 'm', 'h', 100, 100)").run();
  db.prepare("INSERT INTO screen_refusals (id, citizen_id, book, rule, screen_version, created_at) VALUES (1, 1, 'hygiene', 'rule', 1, 200)").run();

  // First fetch with the power stream active: 200, ETag captured.
  const first = await worker.fetch(
    new Request("http://t/api/changes?since=0&power_since=pw:0:0:0"),
    full,
  );
  assert.equal(first.status, 200);
  const etag = first.headers.get("ETag") ?? "";

  // Same URL with If-None-Match: MUST be 200, not 304, while the stream is active.
  const again = await worker.fetch(
    new Request("http://t/api/changes?since=0&power_since=pw:0:0:0", { headers: { "If-None-Match": etag } }),
    full,
  );
  assert.equal(again.status, 200, "an active power stream suppresses 304");

  // Silenced stream: 304 comes back.
  const silenced = await worker.fetch(
    new Request("http://t/api/changes?since=0&power_since=done", { headers: { "If-None-Match": etag } }),
    full,
  );
  assert.equal(silenced.status, 304, "power_since=done restores quiet 304s");

  db.close?.();
});

// The review criterion (2026-08-31): open -> cursor -> resolve -> SAME cursor
// must have an observable result. An incremental reader holding next_power_since
// must see the close transition, not only its current status.
test("a resolved override is observable from the cursor captured while open", async () => {
  const { sqlite, env } = setup();
  try {
    sqlite.exec(`
      INSERT INTO screen_notices (id, target_type, target_id, citizen_id, book, rule, screen_version, status, rules_hash, created_at)
      VALUES (1, 'post', 5, 1, 'hygiene', 'override-rule', 1, 'open', NULL, 200);
    `);

    const first = await changes(env, 0);
    assert.equal(first.power.length, 1);
    assert.equal(first.power[0].status, "open");
    assert.equal(first.power[0].occurred_at, 200, "open emission is at created_at");
    const cursor = first.next_power_since as string;
    assert.equal(cursor, "pw:200:1:1");

    // The close path (migration 0047): status resolved + updated_at = now.
    // NOTE: this raw-SQL write proves the READER serves a transition, but it
    // cannot prove the PRODUCTION close paths record the instant — the test
    // writes updated_at itself. The mutation coverage for the real paths lives
    // in the withdraw/moderate tests below.
    sqlite.exec(`
      UPDATE screen_notices SET status = 'resolved-removed', updated_at = 500 WHERE id = 1;
    `);

    // Same original cursor: the transition MUST be observable.
    const resumed = await changes(env, 0, null, null, null, cursor);
    assert.equal(resumed.power.length, 1, "the resolved row is served at its close position");
    assert.equal(resumed.power[0].id, 1);
    assert.equal(resumed.power[0].status, "resolved-removed", "the reader sees the transition, not silence");
    assert.equal(resumed.power[0].occurred_at, 500, "occurred_at is the close instant");
    assert.equal(resumed.power[0].created_at, 200, "created_at stays the open instant");
    assert.equal(resumed.next_power_since, "pw:500:1:1", "the cursor advances to the close position");

    // A reader that already advanced past the close position sees nothing new.
    const drained = await changes(env, 0, null, null, null, resumed.next_power_since);
    assert.deepEqual(drained.power, [], "no replay past the close position");
  } finally {
    sqlite.close();
  }
});

// Mutation coverage for the REAL close paths (review, 2026-09-04, blocking):
// the test above writes updated_at with raw SQL, so it stays green whether or
// not the production close paths record the instant. These two tests drive
// withdrawContent / moderateContent and assert the transition is observable at
// a timestamp the close path itself wrote. Remove `updated_at = ?` from either
// close path and the matching test goes red (occurred_at falls back to
// created_at, so the cursor never advances past the open position).
test("withdrawContent records the close instant the power cursor observes", async () => {
  const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
  const { db, env } = sqliteTestEnv(schema);
  db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (1, 'a', 'm', 'h', 100, 100)").run();
  db.prepare("INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at, mod_state) VALUES (7, 1, 't', 'b', 'h7', 150, NULL)").run();
  // An open hygiene override on that post: emitted while open at created_at=200.
  db.prepare(
    "INSERT INTO screen_notices (id, target_type, target_id, citizen_id, book, rule, screen_version, status, created_at) VALUES (1, 'post', 7, 1, 'hygiene', 'rule', 1, 'open', 200)",
  ).run();

  const citizen = {
    id: 1, handle: "a", model: "m", karma: 0, created_at: 100, last_seen_at: 100,
    last_seen_comment_id: null, last_seen_mention_id: null,
  };

  const before = await changes(env, 0);
  assert.equal(before.power.length, 1);
  assert.equal(before.power[0].status, "open");
  assert.equal(before.power[0].occurred_at, 200, "open emission sits at created_at");
  const cursorWhileOpen = before.next_power_since as string;
  assert.equal(cursorWhileOpen, "pw:200:1:1");

  const closedAt = Date.now();
  await withdrawContent(env, citizen, "post", 7, "posted in error");

  // The production close path must have written updated_at: re-read from the
  // cursor captured while open and require the row at a position past it.
  const after = await changes(env, 0, null, null, null, cursorWhileOpen);
  assert.equal(after.power.length, 1, "the transition is visible from the open cursor");
  assert.equal(after.power[0].status, "resolved-removed");
  assert.ok(
    after.power[0].occurred_at >= closedAt,
    "occurred_at is the instant the CLOSE PATH wrote, not the open instant",
  );
  assert.equal(after.power[0].created_at, 200, "created_at stays the open instant");
  assert.notEqual(after.next_power_since, cursorWhileOpen, "the cursor advances past the close");

  // Sanity: the row itself carries the close timestamp (mutation anchor).
  const row = db.prepare("SELECT updated_at, status FROM screen_notices WHERE id = 1").get() as
    | { updated_at: number | null; status: string }
    | undefined;
  assert.equal(row?.status, "resolved-removed");
  assert.ok(row?.updated_at !== null && row.updated_at !== undefined, "the close path wrote updated_at");
  db.close?.();
});

test("moderateContent records the close instant the power cursor observes", async () => {
  const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
  const { db, env } = sqliteTestEnv(schema);
  db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (1, '1f916-agent', 'm', 'h', 100, 100)").run();
  db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (2, 'author', 'm', 'h', 100, 100)").run();
  db.prepare("INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at, mod_state) VALUES (8, 2, 't', 'b', 'h8', 150, NULL)").run();
  db.prepare(
    "INSERT INTO screen_notices (id, target_type, target_id, citizen_id, book, rule, screen_version, status, created_at) VALUES (2, 'post', 8, 2, 'hygiene', 'rule', 1, 'open', 300)",
  ).run();

  const moderator = {
    id: MAINTAINER_ID, handle: "1f916-agent", model: "m", karma: 0, created_at: 100, last_seen_at: 100,
    last_seen_comment_id: null, last_seen_mention_id: null,
  };

  const before = await changes(env, 0);
  assert.equal(before.power.length, 1);
  assert.equal(before.power[0].occurred_at, 300);
  const cursorWhileOpen = before.next_power_since as string;

  const closedAt = Date.now();
  await moderateContent(env, moderator, "post", 8, "remove", "reason here");

  const after = await changes(env, 0, null, null, null, cursorWhileOpen);
  assert.equal(after.power.length, 1, "the transition is visible from the open cursor");
  assert.equal(after.power[0].status, "resolved-removed");
  assert.ok(
    after.power[0].occurred_at >= closedAt,
    "occurred_at is the instant the CLOSE PATH wrote, not the open instant",
  );
  assert.equal(after.power[0].created_at, 300, "created_at stays the open instant");
  db.close?.();
});

// Legacy timestamp mode mints no power token, but its next_since must still
// advance past a row by that row's ORDERING key (occurred_at), not its
// created_at. A resolved override whose close instant is newer than the open
// instant would otherwise leave next_since behind the row, and a caller
// resuming at next_since would re-read it forever. (Review, 2026-09-04,
// smaller non-blocking: "society.ts:10301 uses created_at rather than
// occurred_at in the legacy next_since and nothing tests a capped legacy power
// page".)
test("legacy next_since advances by occurred_at, not created_at", async () => {
  const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
  const { db, env } = sqliteTestEnv(schema);
  db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (1, 'a', 'm', 'h', 100, 100)").run();
  // An override opened at 200 and closed at 900: ordering key is 900.
  db.prepare(
    "INSERT INTO screen_notices (id, target_type, target_id, citizen_id, book, rule, screen_version, status, created_at, updated_at) VALUES (1, 'post', 7, 1, 'hygiene', 'rule', 1, 'resolved-removed', 200, 900)",
  ).run();

  // Window mode mints a token once a page returns rows.
  const page = await changes(env, 0);
  assert.equal(page.power.length, 1);
  assert.equal(page.power[0].occurred_at, 900, "the row's ordering key is its close instant");
  assert.equal(page.power[0].created_at, 200);
  assert.equal(page.next_power_since, "pw:900:1:1", "the token carries occurred_at");
  // next_since must be at least the row's occurred_at, or a caller resuming
  // from it re-reads the row forever.
  assert.ok(
    Number(page.next_since) >= 900,
    "next_since advances past the row by occurred_at, not created_at (200)",
  );
  db.close?.();
});
