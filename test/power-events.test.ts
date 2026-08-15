// /api/changes power stream: refusals and author overrides must appear as rows
// in the catch-up walk, ordered by created_at, with their own created_at-anchored
// cursor — and observe-mode reader-safety notices must stay out.
//
// Power-transfer events live in two tables with independent id sequences
// (screen_refusals, screen_notices), so the stream orders by time and the token
// is the last emitted created_at, unlike the id-anchored posts/comments tokens.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { changes, SocietyError, CHANGES_POWER_LIMIT, type Env } from "../src/society.ts";

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

test("power stream delivers refusals and open hygiene overrides, excluding observe notices", async () => {
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
             -- Resolved hygiene override: no longer a live power transfer.
             (4, 'post', 6, 2, 'hygiene', 'override-rule', 1, 'resolved-removed', NULL, 500);
    `);

    const first = await changes(env, 0, "init", "init", "init");
    assert.deepEqual(
      first.power_events.map((row: { kind: string; id: number; rule: string; author: string }) => ({ kind: row.kind, id: row.id, rule: row.rule, author: row.author })),
      [
        { kind: "refusal", id: 1, rule: "seat-claim-rule", author: "door-agent" },
        { kind: "override", id: 2, rule: "override-rule", author: "overriding-agent" },
      ],
      "reader-safety observe notices and resolved overrides stay out of the power stream",
    );
    assert.equal(first.power_events[0].target_type, null, "refusals carry no target");
    assert.equal(first.power_events[1].target_type, "post", "overrides carry their target");
    assert.equal(first.power_events[1].target_id, 5);
    assert.equal(first.next_power_since, "id:300", "the token is the last emitted created_at");
    assert.equal(first.has_more, false);
  } finally {
    sqlite.close();
  }
});

test("power stream keeps its created_at position across a quiet heartbeat", async () => {
  const { sqlite, env } = setup();
  try {
    sqlite.exec(`
      INSERT INTO screen_refusals (id, citizen_id, book, rule, screen_version, created_at)
      VALUES (1, 1, 'hygiene', 'rule-a', 1, 200);
    `);

    const first = await changes(env, 0, "init", "init", "init");
    assert.equal(first.next_power_since, "id:200");

    const quiet = await changes(env, first.next_since, first.next_posts_since, first.next_comments_since, first.next_power_since);
    assert.deepEqual(quiet.power_events, []);
    assert.equal(quiet.next_power_since, "id:200", "an empty power response preserves the position");

    // A refusal committed after the heartbeat with a NEWER timestamp arrives next.
    sqlite.exec(`
      INSERT INTO screen_refusals (id, citizen_id, book, rule, screen_version, created_at)
      VALUES (2, 1, 'hygiene', 'rule-b', 1, 350);
    `);

    const next = await changes(env, quiet.next_since, quiet.next_posts_since, quiet.next_comments_since, quiet.next_power_since);
    const events = [...first.power_events, ...quiet.power_events, ...next.power_events].map((row: { id: number }) => row.id);
    assert.deepEqual(events, [1, 2], "a later-committed refusal is delivered next, once");
    assert.equal(next.next_power_since, "id:350", "the position advances to the newest emitted created_at");
  } finally {
    sqlite.close();
  }
});

test("power stream page cap reports has_more and resumes with a snapshot token", async () => {
  const { sqlite, env } = setup();
  try {
    sqlite.exec(`
      WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ${CHANGES_POWER_LIMIT + 5})
      INSERT INTO screen_refusals (id, citizen_id, book, rule, screen_version, created_at)
      SELECT n, 1, 'hygiene', 'rule-' || n, 1, 1000 + n FROM seq;
    `);

    const first = await changes(env, 0, "init", "init", "init");
    assert.equal(first.power_events.length, CHANGES_POWER_LIMIT);
    assert.equal(first.has_more, true, "a capped power page reports has_more");
    assert.match(first.next_power_since, /^snap:0:1\d\d\d:\d+$/, "capped power pages carry a snapshot token");

    const second = await changes(env, first.next_since, first.next_posts_since, first.next_comments_since, first.next_power_since);
    const delivered = [...first.power_events, ...second.power_events].map((row: { id: number }) => row.id);
    assert.equal(delivered.length, CHANGES_POWER_LIMIT + 5, "every power event is delivered across pages");
    assert.equal(new Set(delivered).size, delivered.length, "no power event is replayed");
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
    assert.deepEqual(first.power_events.map((row: { id: number }) => row.id), [2], "legacy mode filters power events by since");
    assert.equal(first.next_power_since, null, "legacy mode emits no power cursor");
    assert.equal(first.next_since, 2000, "an uncapped power stream does not drag the legacy boundary");
  } finally {
    Date.now = realNow;
    sqlite.close();
  }
});

test("power_since joins the lossless contract only with posts_since and comments_since", async () => {
  const { sqlite, env } = setup();
  try {
    // posts/comments pairing is unchanged; a legacy power_since is rejected.
    await assert.rejects(
      () => changes(env, 0, null, null, "init"),
      (error: unknown) =>
        error instanceof SocietyError
        && error.status === 400
        && /power_since must be omitted in legacy mode/.test(error.message),
    );

    // Lossless posts/comments without power_since keeps the old contract and
    // returns a timestamp-ordered power view with no power cursor.
    const losslessOnly = await changes(env, 0, "init", "init");
    assert.equal(losslessOnly.next_power_since, null, "no power cursor without power_since");
    assert.ok(Array.isArray(losslessOnly.power_events));

    // A lossless contract with power_since=init gains the power cursor.
    const full = await changes(env, 0, "init", "init", "init");
    assert.ok(full.next_power_since, "power_since=init enters the lossless power contract");
  } finally {
    sqlite.close();
  }
});
