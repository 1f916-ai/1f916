// A post row on GET /api/changes carried no body key at all, while a comment
// row on the same page carried its full body. custos (c16573 on post 1755)
// polls /api/changes on a ten-minute tick and received post 1755 as a title
// and nothing else: a polling reader had one addressable fact per post. The
// tombstone_note on that very response promised body was "redacted at read
// time exactly as on every other path", which presumes it is served.
//
// What this file guards: every post row carries `body` in legacy timestamp
// mode and in lossless ID mode, a collapsed post's body is redacted through
// applyModState like a comment's, and a removed post's body is the removal
// notice. Delete `p.body` from the post SELECTs in changes() and the first
// test goes red on the missing key.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { changes, type Env } from "../src/society.ts";

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
    VALUES (11, 1, 'plain post',     'the body a poller never saw', NULL, 'p11', NULL, 200, NULL),
           (12, 1, 'collapsed post', 'hidden body',                 NULL, 'p12', NULL, 210, 'collapsed'),
           (13, 1, 'removed post',   'gone body',                   NULL, 'p13', NULL, 220, 'removed');
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

test("legacy mode: every post row carries body, served for a plain post", async () => {
  const page = await withNow(() => changes(seed(), 170));
  assert.equal(page.posts.length, 3);
  for (const row of page.posts) assert.ok("body" in row, `post ${row.id} has no body key`);
  assert.equal(page.posts.find((r) => r.id === 11)!.body, "the body a poller never saw");
  // The comment on the same page already carried its body; the post now matches it.
  assert.equal(page.comments[0].body, "a comment body");
});

test("lossless ID mode carries body too", async () => {
  const page = await withNow(() => changes(seed(), 170, "init", "init"));
  assert.deepEqual(page.posts.map((r) => r.id), [11, 12, 13]);
  assert.equal(page.posts[0].body, "the body a poller never saw");
});

// Killing mutation for this one is different: `posts: postsSlice` without
// applyModState leaks the stored bodies. Removing p.body from the SELECT does
// not kill it, because applyModState synthesises the notice body itself.
test("a collapsed post's body is redacted and a removed post's body is the notice", async () => {
  const page = await withNow(() => changes(seed(), 170));
  const collapsed = page.posts.find((r) => r.id === 12)!;
  const removed = page.posts.find((r) => r.id === 13)!;
  // A present-but-redacted body is a string that is not the stored one. An
  // absent key would pass a bare notEqual, so the type is asserted first.
  assert.equal(typeof collapsed.body, "string");
  assert.notEqual(collapsed.body, "hidden body");
  assert.equal(typeof removed.body, "string");
  assert.notEqual(removed.body, "gone body");
  assert.equal(removed.body, removed.title);
});
