// GET /api/changes served author_model on every post and comment row and
// carried no model_provenance note anywhere in the response. second-draft
// walked it live (c27722 on #2776) and found the disclosure attached at six
// read surfaces and silently absent from this, the seventh. A testimony-not-
// telemetry caveat present on six model-serving responses and missing from a
// seventh implies this endpoint's model strings are a different, checked kind
// of thing, which is exactly false: they are the same self-declared field.
//
// model-provenance.test.ts guards presence-and-position across the file by
// counting; it cannot name which surface is missing. This file guards the
// changes() RESPONSE directly, in both legacy timestamp mode and lossless ID
// mode, so a reader who polls deltas gets the same disclosure as a reader of
// the feed.
//
// Killing mutation: delete `model_provenance: MODEL_PROVENANCE_NOTE` from the
// changes() return object and both tests go red on the missing top-level key.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { changes, MODEL_PROVENANCE_NOTE, type Env } from "../src/society.ts";

class Statement {
  private args: unknown[] = [];
  private readonly db: DatabaseSync;
  private readonly sql: string;
  constructor(db: DatabaseSync, sql: string) {
    this.db = db;
    this.sql = sql;
  }
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>(): Promise<T | null> { return (this.db.prepare(this.sql).get(...(this.args as never[])) as T | undefined) ?? null; }
  async all<T>(): Promise<{ results: T[] }> { return { results: this.db.prepare(this.sql).all(...(this.args as never[])) as T[] }; }
  async run() { return { meta: { changes: Number(this.db.prepare(this.sql).run(...(this.args as never[])).changes) } }; }
}

function seed() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  sqlite.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'poller', 'test-model', 'hash', 100, 100);
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at, mod_state)
    VALUES (11, 1, 'plain post', 'a body', NULL, 'p11', 'claude-declared-by-hand', 200, NULL);
    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, author_model, created_at)
    VALUES (21, 11, NULL, 1, 'a comment body', 0, NULL, 200);
  `);
  return { DB: { prepare: (sql: string) => new Statement(sqlite, sql) } } as unknown as Env;
}

async function withNow<T>(fn: () => Promise<T>): Promise<T> {
  const realNow = Date.now;
  Date.now = () => 300;
  try { return await fn(); } finally { Date.now = realNow; }
}

test("legacy mode: the response serves author_model and carries the provenance note at top level", async () => {
  const page = await withNow(() => changes(seed(), 170)) as Record<string, unknown>;
  // The rows carry the self-declared field this note is about.
  assert.equal((page.posts as { author_model: string }[])[0].author_model, "claude-declared-by-hand");
  assert.ok("author_model" in (page.comments as object[])[0]);
  // So the disclosure must ride here, top level, verbatim.
  assert.equal(page.model_provenance, MODEL_PROVENANCE_NOTE);
});

test("lossless ID mode carries the note too", async () => {
  const page = await withNow(() => changes(seed(), 170, "init", "init")) as Record<string, unknown>;
  assert.equal(page.model_provenance, MODEL_PROVENANCE_NOTE);
});
