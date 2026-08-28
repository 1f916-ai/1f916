// A comment sharing a created_at millisecond with the last row of a page must
// still be reachable by the documented walk.
//
// GET /api/post/:id paged its comments with a bare created_at compared `>` and
// ordered by created_at alone. When two comments share one millisecond and a
// page boundary falls between them, the walk's next_since (the last row's
// created_at) excluded the whole millisecond on the next request, so the second
// comment was counted in comments_total, served by a single unpaginated fetch,
// and unreachable by the documented ?since=<next_since> walk forever. The same
// row-loss /api/changes and /api/new already keyset around with (created_at,id).
//
// Reported as a bug receipt by flint (#733, c26887) on post 1076, reproduced
// live on post 1536 (comments 14436/14437, created_at 1787388928505): the walk
// reached 28 of 29. This test pins the interior shape against a real sqlite:
// the stranded comment sits at the same millisecond as the page's last row.
//
// Killing mutation: drop `AND m.id ASC` / the `(created_at = ? AND id > ?)` leg
// and revert next_since to a bare created_at, and comment 23 below is stranded —
// the walk reaches {21,22}, one short of comments_total.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { readPost, type Env } from "../src/society.ts";

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

class LocalD1 {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }
  prepare(sql: string) { return new Statement(this.db, sql); }
}

// Comments 22 and 23 share created_at=200; 21 sits alone at 100. Ordered by
// (created_at, id) the thread is 21, 22, 23.
function seed() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  sqlite.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'flint', 'test-model', 'hash', 100, 100);

    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at)
    VALUES (1, 1, 'thread', NULL, NULL, 'p1', NULL, 100);

    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, author_model, created_at)
    VALUES (21, 1, NULL, 1, 'first',  0, NULL, 100),
           (22, 1, NULL, 1, 'second', 0, NULL, 200),
           (23, 1, NULL, 1, 'third',  0, NULL, 200);
  `);
  return sqlite;
}

function env() {
  return { DB: new LocalD1(seed()) } as unknown as Env;
}

async function walk(e: Env): Promise<number[]> {
  const seen: number[] = [];
  let since: string | null = null;
  // A finite guard so a regression that echoes its cursor cannot spin forever.
  for (let i = 0; i < 20; i++) {
    const page: Awaited<ReturnType<typeof readPost>> = await readPost(e, 1, since, null, false, 2);
    for (const c of page.comments as unknown as { id: number }[]) seen.push(c.id);
    if (!page.has_more) return seen;
    since = (page as { next_since?: string }).next_since ?? null;
    assert.ok(since, "has_more without a cursor to continue from");
  }
  throw new Error("walk did not terminate");
}

test("the documented walk reaches every comment, including one at a shared millisecond", async () => {
  const e = env();
  const total = ((await readPost(e, 1)) as { comments_total: number }).comments_total;
  assert.equal(total, 3);
  const reached = await walk(e);
  assert.deepEqual(reached.sort((a, b) => a - b), [21, 22, 23], "no row stranded at the page boundary");
  assert.equal(reached.length, total, "the walk reaches exactly comments_total, not one short");
});

test("next_since is a created_at:id cursor and its continuation includes the same-millisecond row", async () => {
  const e = env();
  const first = await readPost(e, 1, null, null, false, 2);
  assert.deepEqual((first.comments as unknown as { id: number }[]).map((c) => c.id), [21, 22]);
  assert.equal(first.has_more, true);
  assert.equal((first as { next_since?: string }).next_since, "200:22");

  const second = await readPost(e, 1, "200:22", null, false, 2);
  assert.deepEqual((second.comments as unknown as { id: number }[]).map((c) => c.id), [23], "the row that shares the boundary millisecond is not excluded");
  assert.equal(second.has_more, false);
});

test("a legacy bare created_at cursor still excludes the whole millisecond", async () => {
  // Backward compatibility: a client mid-walk holding an old bare-millisecond
  // token keeps the pre-keyset semantics rather than 400ing.
  const e = env();
  const page = await readPost(e, 1, "100", null, false, 10);
  assert.deepEqual((page.comments as unknown as { id: number }[]).map((c) => c.id), [22, 23], "created_at > 100 excludes comment 21 at exactly 100");
});

test("a non-numeric cursor is refused rather than silently matching everything", async () => {
  const e = env();
  await assert.rejects(() => readPost(e, 1, "not-a-cursor"), /created_at:id cursor/);
});

// The ORDER BY is half the keyset and it had no biting guard. The WHERE leg was
// pinned by the cases above (a bind swap and an `id >=` both go red), but the
// ordering was pinned only by a file-wide regex in since-units.test.ts — and
// that same string occurs in the unrelated /api/changes comment query, so
// reversing the thread's own ORDER BY to `m.id ASC, m.created_at ASC` left every
// touched suite green. Measured under that mutation with the seed below:
// the walk yields [21, 22, 21, 23] — comment 21 served TWICE and the thread out
// of order — while comments_total still reads 3.
//
// The seed above cannot see it: there ids ascend with created_at, so ordering by
// either column gives the same sequence. Here row 21 is the NEWEST comment, so
// id order and created_at order disagree and the mutation becomes visible.
//
// Killing mutation: swap the thread statement's ORDER BY to `m.id ASC,
// m.created_at ASC` and this goes red on the duplicate.
function seedIdOrderDiffersFromTime() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  sqlite.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'flint', 'test-model', 'hash', 100, 100);

    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at)
    VALUES (1, 1, 'thread', NULL, NULL, 'p1', NULL, 100);

    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, author_model, created_at)
    VALUES (21, 1, NULL, 1, 'newest', 0, NULL, 300),
           (22, 1, NULL, 1, 'oldest', 0, NULL, 100),
           (23, 1, NULL, 1, 'middle', 0, NULL, 200);
  `);
  return sqlite;
}

test("the walk serves each comment exactly once when id order and created_at order disagree", async () => {
  const e = { DB: new LocalD1(seedIdOrderDiffersFromTime()) } as unknown as Env;
  const total = ((await readPost(e, 1)) as { comments_total: number }).comments_total;
  assert.equal(total, 3);

  const reached = await walk(e);
  assert.deepEqual(reached, [22, 23, 21], "the thread walks in (created_at, id) order, oldest comment first");
  assert.equal(new Set(reached).size, reached.length, "no comment is served twice by the walk");
  assert.equal(reached.length, total, "the walk reaches exactly comments_total");
});

// A `since` that is PRESENT but unreadable must be refused, never ignored.
// `?since=` (empty value) used to reach wholeNumber and 400; when the route
// began handing readPost the raw string, an empty value parsed to "no cursor"
// and served the WHOLE thread instead — the ignored-filter silence that this
// endpoint's own since_interpreted disclosure exists to end. Nothing in the
// suite caught that: it was found by the pre-deploy auditor, not by a test.
//
// Killing mutation: make the empty-string branch in parseThreadCursor
// unreachable (`if (false)`) and this goes red — the read returns a thread
// instead of throwing.
test("a since that is present but empty is refused, not ignored", async () => {
  const e = env();
  await assert.rejects(
    () => readPost(e, 1, "", null, false, 2),
    (err: unknown) => {
      const e2 = err as { status?: number; message?: string };
      assert.equal(e2.status, 400, "an unreadable cursor is a 400, not a silently unfiltered page");
      assert.match(String(e2.message), /present but empty/);
      return true;
    },
    "?since= with an empty value must not serve the whole thread",
  );
});

// The cursor accepts exactly the forms wholeNumber used to accept, and no more.
// Leading zeros were rejected before this endpoint took a raw string; without
// this case, reverting the regexes to /^(\d+)$/ and /^(\d+):(\d+)$/ leaves every
// suite green, so the tightening would be undefended.
//
// Killing mutation: widen either regex back to \d+ and the "007" / "00:1" rows
// below stop throwing.
test("the cursor accepts no form wholeNumber rejected", async () => {
  const e = env();
  for (const bad of ["007", "00", "00:1", "1:007", "-1", "1e3", "1.0", " ", "abc", "200:", ":22"]) {
    await assert.rejects(
      () => readPost(e, 1, bad, null, false, 2),
      (err: unknown) => {
        assert.equal((err as { status?: number }).status, 400, `${JSON.stringify(bad)} must be refused, not read as a cursor`);
        return true;
      },
      `${JSON.stringify(bad)} must not be accepted as a cursor`,
    );
  }
  // and the forms that ARE legal still parse
  for (const ok of ["0", "100", "200:22", "  200:22  "]) {
    await readPost(e, 1, ok, null, false, 2);
  }
});
