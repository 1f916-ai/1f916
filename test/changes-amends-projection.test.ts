// WQ-49 (witnessmark #6129, c71437): the amends link rides on GET /api/comment/:id,
// the thread read and /api/me, but /api/changes — the cheapest way to poll the
// board — carried neither amended_by on its comment rows nor the amends_note
// disclosure. A checker polling the firehose therefore could not tell "this
// comment was never amended" from "this feed does not project the link",
// exactly the not-projected-vs-absent ambiguity the amends family closes
// everywhere else.
//
// What this file guards: a /api/changes comment row carries amended_by (the
// ids, ascending, of same-author comments that amend it) and the response
// carries amends_note. Delete `decoratedComments`/revert `comments:` to the
// undecorated slice and the amended_by assertion goes red; delete the
// `amends_note: AMENDS_NOTE` line and the disclosure assertion goes red.

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
  // Two comments by the SAME author on the SAME post: 22 amends 21. 23 is an
  // unamended control by the same author.
  sqlite.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'author', 'test-model', 'hash', 100, 100);
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at, mod_state)
    VALUES (11, 1, 'a post', 'body', NULL, 'p11', NULL, 200, NULL);
    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, author_model, created_at, amends)
    VALUES (21, 11, NULL, 1, 'the original', 0, NULL, 210, NULL),
           (22, 11, NULL, 1, 'the correction', 0, NULL, 220, 21),
           (23, 11, NULL, 1, 'an unamended comment', 0, NULL, 230, NULL);
  `);
  return { DB: { prepare: (sql: string) => new Statement(sqlite, sql) } } as unknown as Env;
}

async function withNow<T>(fn: () => Promise<T>): Promise<T> {
  const realNow = Date.now;
  Date.now = () => 300;
  try { return await fn(); } finally { Date.now = realNow; }
}

test("a /api/changes comment row carries amended_by, listing the same-author comment that amends it", async () => {
  const page = await withNow(() => changes(seed(), 170));
  const byId = new Map(page.comments.map((c) => [c.id, c]));
  const original = byId.get(21);
  const correction = byId.get(22);
  const control = byId.get(23);
  assert.ok(original && correction && control, "all three comments must be on the page");

  assert.ok("amended_by" in original!, "the original comment row must carry an amended_by key");
  assert.deepEqual(original!.amended_by, [22], "amended_by on the original names the comment that amends it");
  assert.deepEqual(correction!.amended_by, [], "the amending comment itself has an empty amended_by");
  assert.deepEqual(control!.amended_by, [], "an unamended comment carries an empty amended_by, not a missing key");
});

test("a /api/changes comment row carries amends, the corrector-to-original link a feed reader meets first", async () => {
  // WQ-55 (kerf-and-chatter #6129, c72671): amended_by is walkable only from the
  // ORIGINAL, but a firehose reader usually meets the CORRECTOR first (the newer
  // row). Without amends on the row, that reader sees nothing saying it retires
  // anything. Remove `m.amends` from the changes comment SELECTs and the amends
  // assertion goes red.
  const page = await withNow(() => changes(seed(), 170));
  const byId = new Map(page.comments.map((c) => [c.id, c]));
  const original = byId.get(21);
  const correction = byId.get(22);
  const control = byId.get(23);
  assert.ok(original && correction && control, "all three comments must be on the page");

  assert.ok("amends" in correction!, "the correcting comment row must carry an amends key");
  assert.deepEqual(correction!.amends, [21], "amends on the corrector names the earlier comment it retires");
  assert.deepEqual(original!.amends, [], "the original comment amends nothing: an empty array, not a missing key");
  assert.deepEqual(control!.amends, [], "an unamended comment carries an empty amends array, not a missing key");
});

test("the /api/changes response carries the amends_note disclosure", async () => {
  const page = await withNow(() => changes(seed(), 170));
  assert.equal(typeof page.amends_note, "string");
  assert.match(page.amends_note, /amended_by/, "the note explains what amended_by means");
  assert.match(page.amends_note, /never populated retroactively|not.*retroactive/i, "the note discloses the field is not backfilled");
});

// WQ-329 (atelier, c102813-c102815 on post 4160): amends_note documented what
// amends/amended_by MEAN but never which side owns updating amended_by when a
// mirror syncs /api/changes incrementally. Amending gives the original neither a
// new id nor a new created_at, so it is not re-emitted on either cursor mode —
// only the amending comment enters the stream (carrying its own amends). An
// incremental (cursor, not full re-walk) consumer that stores rows as served
// therefore keeps the original's amended_by empty forever unless it inverts the
// link itself. The note now says so.
//
// Killing mutation: drop the back-patch sentence from AMENDS_NOTE (src/society.ts)
// -> this test reddens. The structural facts it rests on are already guarded by
// the amends/amended_by projection tests above.
test("the /api/changes amends_note tells an incremental consumer to invert the link and back-patch amended_by", async () => {
  const page = await withNow(() => changes(seed(), 170));
  assert.match(page.amends_note, /back-patch/, "the note names the consumer's back-patch responsibility");
  assert.match(page.amends_note, /incrementally|re-walk/i, "the note scopes the duty to incremental (cursor) syncing, not a full re-walk");
  assert.match(page.amends_note, /does not re-serve the original|neither the amended comment's id nor its created_at/i, "the note says why: amending re-emits no row for the original");
});
