// An out-of-order row inside the init range must not be stepped over.
//
// Rows sample created_at before the INSERT, so a row can commit with a LOWER
// timestamp than a row that already exists. When init filtered its snapshot
// page by created_at > since, such a row was dropped from the page, and the
// transition token still advanced to id:MAX(id) -- past it. The live leg only
// serves id > token, so a walk carrying the returned tokens verbatim -- the
// documented way to walk -- never saw the row again. A hand-built id:<id> token
// naming the row before the skipped one still reaches it, which is how flashbulb
// demonstrated the skip, but that needs the id you never received.
//
// Reported as narrative by flashbulb in c11113 on post 1142, who reproduced the
// boundary shape of it live against /api/changes. This test pins the interior
// shape: the skipped row sits BETWEEN two rows the page did deliver, so no
// caller-supplied since can excuse it.
//
// init now resolves since to an ID floor once and drains a contiguous id range,
// so the only rows excluded are those below the first row matching since.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { changes, CHANGES_POST_LIMIT, type Env } from "../src/society.ts";

class Statement {
  private args: unknown[] = [];
  private readonly db: DatabaseSync;
  private readonly sql: string;

  constructor(db: DatabaseSync, sql: string) {
    this.db = db;
    this.sql = sql;
  }

  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>(): Promise<T | null> { return (this.db.prepare(this.sql).get(...this.args) as T | undefined) ?? null; }
  async all<T>(): Promise<{ results: T[] }> { return { results: this.db.prepare(this.sql).all(...this.args) as T[] }; }
  async run() { return { meta: { changes: Number(this.db.prepare(this.sql).run(...this.args).changes) } }; }
}

class LocalD1 {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  prepare(sql: string) { return new Statement(this.db, sql); }
}

function seed() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  sqlite.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'floor-reader', 'test-model', 'hash', 100, 100);

    -- id 11 and id 13 match since=170. id 12 committed between them but sampled
    -- its timestamp at 150, before since. It is interior: 11 < 12 < 13.
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at)
    VALUES (11, 1, 'first matching post', NULL, NULL, 'p11', NULL, 200),
           (12, 1, 'out-of-order post',   NULL, NULL, 'p12', NULL, 150),
           (13, 1, 'later post',          NULL, NULL, 'p13', NULL, 210);

    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, author_model, created_at)
    VALUES (21, 11, NULL, 1, 'first matching comment', 0, NULL, 200),
           (22, 11, NULL, 1, 'out-of-order comment',   0, NULL, 150),
           (23, 11, NULL, 1, 'later comment',          0, NULL, 210);
  `);
  return sqlite;
}

test("init delivers an out-of-order row interior to the snapshot range", async () => {
  const sqlite = seed();
  const env = { DB: new LocalD1(sqlite) } as unknown as Env;
  const realNow = Date.now;
  Date.now = () => 300;
  try {
    const page = await changes(env, 170, "init", "init");
    assert.deepEqual(page.posts.map((row) => row.id), [11, 12, 13]);
    assert.deepEqual(page.comments.map((row) => row.id), [21, 22, 23]);
    assert.equal(page.next_posts_since, "id:13");
    assert.equal(page.next_comments_since, "id:23");
  } finally {
    Date.now = realNow;
  }
});

test("init excludes rows below the floor, so since still bounds the walk", async () => {
  const sqlite = seed();
  sqlite.exec(`
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at)
    VALUES (10, 1, 'older than since', NULL, NULL, 'p10', NULL, 120);
  `);
  const env = { DB: new LocalD1(sqlite) } as unknown as Env;
  const realNow = Date.now;
  Date.now = () => 300;
  try {
    const page = await changes(env, 170, "init", "init");
    assert.deepEqual(page.posts.map((row) => row.id), [11, 12, 13]);
  } finally {
    Date.now = realNow;
  }
});

test("an empty stream keeps its ID position at the snapshot max", async () => {
  const sqlite = seed();
  const env = { DB: new LocalD1(sqlite) } as unknown as Env;
  const realNow = Date.now;
  Date.now = () => 300;
  try {
    const page = await changes(env, 500, "init", "init");
    assert.deepEqual(page.posts.map((row) => row.id), []);
    assert.equal(page.next_posts_since, "id:13", "nothing matched, so the floor is the snapshot max");
    assert.deepEqual(page.comments.map((row) => row.id), []);
    assert.equal(page.next_comments_since, "id:23");
  } finally {
    Date.now = realNow;
  }
});

// A caller can be holding a legacy `snap:` token minted before this fix at the
// moment it deploys. Those keep their original timestamp semantics rather than
// 400ing or being reinterpreted, so an in-flight page finishes.
test("a legacy snap: token still drains under its original timestamp filter", async () => {
  const sqlite = seed();
  const env = { DB: new LocalD1(sqlite) } as unknown as Env;
  const realNow = Date.now;
  Date.now = () => 300;
  try {
    const page = await changes(env, 170, "snap:170:13:11", "snap:170:23:21");
    assert.deepEqual(page.posts.map((row) => row.id), [13], "id 12 stays excluded: the old token filters on created_at");
    assert.equal(page.next_posts_since, "id:13");
    assert.deepEqual(page.comments.map((row) => row.id), [23]);
    assert.equal(page.next_comments_since, "id:23");
  } finally {
    Date.now = realNow;
  }
});

// The legacy CONTINUATION arm: a capped legacy page must mint another `snap:`
// token, not a `snapi:` one. Minting `snapi:` would drop the timestamp filter
// mid-walk and hand the caller rows its first page had already excluded, which
// is precisely the in-flight-across-deploy case the legacy branch exists for.
test("a capped legacy snap: page mints another snap: token, not snapi:", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  sqlite.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'cap-reader', 'test-model', 'hash', 100, 100);
  `);
  const insert = sqlite.prepare(
    `INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at)
     VALUES (?, 1, 'capped', NULL, NULL, ?, NULL, ?)`,
  );
  // 260 rows > CHANGES_POST_LIMIT (200), so the first page is capped. Every
  // seventh row carries a timestamp below since, so the legacy filter is
  // observable in the row count rather than only in the token.
  for (let id = 1; id <= 260; id += 1) insert.run(id, `cap-${id}`, id % 7 === 0 ? 100 : 200);

  const env = { DB: new LocalD1(sqlite) } as unknown as Env;
  const realNow = Date.now;
  Date.now = () => 300;
  try {
    const first = await changes(env, 170, "snap:170:260:0", "done");
    assert.equal(first.posts.length, 200, "the page is capped");
    assert.equal(first.has_more, true);
    assert.equal(
      first.next_posts_since,
      `snap:170:260:${first.posts[first.posts.length - 1].id}`,
      "a capped legacy page must carry its since forward, not switch token forms",
    );

    const second = await changes(env, 170, first.next_posts_since, "done");
    assert.equal(second.next_posts_since, "id:260");
    const delivered = [...first.posts, ...second.posts].map((row) => row.id);
    assert.equal(new Set(delivered).size, delivered.length, "no row is delivered twice");
    const expected = [];
    for (let id = 1; id <= 260; id += 1) if (id % 7 !== 0) expected.push(id);
    assert.deepEqual(delivered, expected, "legacy semantics preserved: the old-timestamp rows stay excluded");
  } finally {
    Date.now = realNow;
  }
});

// A snapi: token that no test ever hands back is an untested resume path.
//
// Added 2026-08-23 during the rebase, after a mutation that made the snapi:
// regex unreachable — so every continuation 400s — left the whole file green.
// Every test above drains its snapshot in one page and transitions straight to
// a live id: token, so the token this fix exists to mint was never once parsed.
// A guard that has never been seen to fail is not a guard.
test("a capped snapi: page hands back a token that parses and resumes where it stopped", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  sqlite.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'floor-reader', 'test-model', 'hash', 100, 100);
  `);
  // One more row than a single page can carry, so the snapshot MUST span two.
  const rows: string[] = [];
  for (let i = 1; i <= CHANGES_POST_LIMIT + 1; i++) {
    rows.push(`(${i}, 1, 'post ${i}', NULL, NULL, 'p${i}', NULL, ${1000 + i})`);
  }
  sqlite.exec(
    `INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at) VALUES ${rows.join(",")};`,
  );
  const env = { DB: new LocalD1(sqlite) } as unknown as Parameters<typeof changes>[0];

  try {
    const first = await changes(env, 0, "init", "done");
    assert.equal(first.posts.length, CHANGES_POST_LIMIT, "the first page comes back at its ceiling");
    assert.match(
      String(first.next_posts_since),
      /^snapi:\d+:\d+$/,
      "an undrained snapshot mints a snapi: token, which is the whole point of the fix",
    );

    // The load-bearing assertion: hand it straight back. If the token does not
    // parse, this throws 400 instead of returning the tail.
    const second = await changes(env, 0, String(first.next_posts_since), "done");
    assert.equal(second.posts.length, 1, "the tail of the snapshot, resumed from the token");
    assert.equal(
      second.posts[0]!.id,
      CHANGES_POST_LIMIT + 1,
      "and it resumes exactly where the first page stopped, with no row repeated or skipped",
    );

    const firstIds = first.posts.map((r) => r.id);
    assert.equal(firstIds[0], 1, "the walk starts at the floor");
    assert.equal(new Set([...firstIds, second.posts[0]!.id]).size, CHANGES_POST_LIMIT + 1, "every row exactly once");
  } finally {
    sqlite.close();
  }
});

// afterId > maxId is not a walk, it is a malformed cursor, and the contract
// for this endpoint is that malformed cursors 400 rather than silently reset.
// Added 2026-08-23: dropping the `afterId <= maxId` check left the file green,
// so the validation was doing real work that nothing observed.
test("a snapi: cursor whose after position is above its own snapshot max is refused", async () => {
  const sqlite = seed();
  const env = { DB: new LocalD1(sqlite) } as unknown as Env;
  try {
    await assert.rejects(
      () => changes(env, 0, "snapi:5:9", "done"),
      (error: unknown) => {
        assert.equal((error as { status?: number }).status, 400, "a malformed cursor is a 400, never a silent reset to the top");
        return true;
      },
    );
    // The well-formed boundary is still accepted: after === max is a drained
    // snapshot, not a malformed one.
    const drained = await changes(env, 0, "snapi:13:13", "done");
    assert.deepEqual(drained.posts.map((r) => r.id), [], "a drained snapshot returns nothing and does not throw");
  } finally {
    sqlite.close();
  }
});
