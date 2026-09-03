// `/api/front` must disclose the denominator behind its ranked window, and
// `/api/new` must be a real whole-board walk rather than page one wearing every
// paging parameter. These tests run the production SQL against schema.sql via
// node:sqlite, including the insert races a string-matching mock cannot model.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.ts";
import { frontPage, newestPage, type Env, type NewFeedCursor } from "../src/society.ts";

class D1Statement {
  private args: unknown[] = [];
  private readonly db: DatabaseSync;
  private readonly sql: string;
  private readonly afterRead: (sql: string) => void;

  constructor(db: DatabaseSync, sql: string, afterRead: (sql: string) => void) {
    this.db = db;
    this.sql = sql;
    this.afterRead = afterRead;
  }

  bind(...args: unknown[]) {
    this.args = args;
    return this;
  }

  async first<T>(): Promise<T | null> {
    const row = (this.db.prepare(this.sql).get(...this.args) as T | undefined) ?? null;
    this.afterRead(this.sql);
    return row;
  }

  async all<T>(): Promise<{ results: T[] }> {
    const results = this.db.prepare(this.sql).all(...this.args) as T[];
    this.afterRead(this.sql);
    return { results };
  }

  async run() {
    const result = this.db.prepare(this.sql).run(...this.args);
    return { meta: { changes: Number(result.changes) } };
  }

  execute() {
    if (/^\s*(?:SELECT|WITH)\b/i.test(this.sql)) {
      const results = this.db.prepare(this.sql).all(...this.args);
      this.afterRead(this.sql);
      return { results, meta: { changes: 0 } };
    }
    const result = this.db.prepare(this.sql).run(...this.args);
    return { results: [], meta: { changes: Number(result.changes) } };
  }
}

class LocalD1 {
  private readonly db: DatabaseSync;
  private readonly afterRead: (sql: string) => void;

  constructor(db: DatabaseSync, afterRead: (sql: string) => void = () => {}) {
    this.db = db;
    this.afterRead = afterRead;
  }

  prepare(sql: string) {
    return new D1Statement(this.db, sql, this.afterRead);
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

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  const schemaPath = fileURLToPath(new URL("../schema.sql", import.meta.url));
  db.exec(readFileSync(schemaPath, "utf8"));
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'feed-reader', 'test-model', 'hash', 0, 0);
  `);
  return db;
}

function envFor(db: DatabaseSync, afterRead: (sql: string) => void = () => {}): Env {
  return { DB: new LocalD1(db, afterRead) } as unknown as Env;
}

function parseBefore(token: string): NewFeedCursor {
  const [createdAt, id] = token.split(":").map(Number);
  assert.ok(Number.isSafeInteger(createdAt));
  assert.ok(Number.isSafeInteger(id));
  return { created_at: createdAt, id };
}

function seedPosts(db: DatabaseSync, count: number, opts: { moderated?: number; pins?: number[] } = {}) {
  const pins = new Set(opts.pins ?? []);
  const insert = db.prepare(
    `INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, pinned, mod_state, author_model, created_at)
     VALUES (?, 1, ?, ?, NULL, ?, ?, ?, 'write-time-model', ?)`,
  );
  db.exec("BEGIN");
  try {
    for (let id = 1; id <= count; id += 1) {
      // Pairs share a timestamp so page boundaries exercise the id tiebreaker.
      const createdAt = Math.floor((id + 1) / 2) * 1000;
      insert.run(
        id,
        `post ${id}`,
        `body ${id}`,
        `feed-${id}`,
        pins.has(id) ? 1 : 0,
        id === opts.moderated ? "removed" : null,
        createdAt,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

test("front discloses the archive denominator and the exact ranked fraction", async () => {
  const db = freshDb();
  seedPosts(db, 301, { moderated: 1 }); // exactly 300 eligible rows
  try {
    const exact = await frontPage(envFor(db), "new", 5);
    assert.equal(exact.board_total, 301, "moderated records remain part of the board/archive denominator");
    assert.equal(exact.ranked_window, 300);
    assert.equal(exact.ranked_count, 300);
    assert.equal(exact.ranked_fraction, 300 / 301);
    assert.equal(exact.window_capped, false, "exactly 300 eligible rows do not imply an unseen 301st row");
    assert.equal(exact.returned, 5);
    assert.ok(exact.posts.every((post) => !("board_total" in post)), "query-only count columns do not leak into posts");

    db.prepare(
      `INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at)
       VALUES (302, 1, 'post 302', 'body 302', 'feed-302', 999999)`,
    ).run();
    const capped = await frontPage(envFor(db), "new", 5);
    assert.equal(capped.board_total, 302);
    assert.equal(capped.ranked_count, 300);
    assert.equal(capped.ranked_fraction, 300 / 302);
    assert.equal(capped.window_capped, true, "the LIMIT+1 sentinel proves an eligible row is outside the window");
  } finally {
    db.close();
  }
});

test("an empty front reports a null fraction rather than inventing a zero denominator ratio", async () => {
  const db = freshDb();
  try {
    const response = await frontPage(envFor(db));
    assert.equal(response.board_total, 0);
    assert.equal(response.ranked_count, 0);
    assert.equal(response.ranked_fraction, null);
    assert.equal(response.window_capped, false);
  } finally {
    db.close();
  }
});

test("newest pages drain a >300-row snapshot exactly once across ties and concurrent inserts", async () => {
  const db = freshDb();
  seedPosts(db, 307, { moderated: 100, pins: [2, 307] });
  try {
    const filters = { tag: [] as string[], exclude: [] as string[] };
    let page = await newestPage(envFor(db), 37, filters);
    const snapshotId = page.snapshot_id;
    const pinSnapshot = page.pin_snapshot;
    assert.equal(snapshotId, 307);
    assert.equal(page.board_total, 307);
    assert.equal(page.pinned_extra, 2);
    assert.deepEqual(page.posts.slice(0, 2).map((post) => post.id), [307, 2], "new and old pins are page-one extras");

    // Both commits happen after page one. The second is deliberately backdated
    // below the continuation boundary: a timestamp-only snapshot would leak it
    // into this walk even though the newer insert happened to stay above it.
    db.prepare(
      `INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at)
       VALUES (308, 1, 'new concurrent post', 'body 308', 'feed-308', 9999999)`,
    ).run();
    db.prepare(
      `INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at)
       VALUES (309, 1, 'backdated concurrent post', 'body 309', 'feed-309', 500)`,
    ).run();

    const delivered = page.posts.map((post) => post.id);
    const deliveredUnpinned = page.posts.filter((post) => !post.pinned).map((post) => post.id);
    let pages = 1;
    while (page.has_more) {
      assert.ok(page.next_before, "every non-final page carries a continuation");
      page = await newestPage(envFor(db), 37, filters, parseBefore(page.next_before), snapshotId, pinSnapshot);
      pages += 1;
      assert.ok(pages < 20, "the walk terminates");
      assert.equal(page.snapshot_id, snapshotId);
      assert.equal(page.board_total, 307, "the denominator belongs to the fixed snapshot, not the moving board");
      assert.equal(page.pinned_extra, 0, "pins never replay on continuation pages");
      delivered.push(...page.posts.map((post) => post.id));
      deliveredUnpinned.push(...page.posts.filter((post) => !post.pinned).map((post) => post.id));
    }
    assert.equal("next_before" in page, false, "the final page does not advertise a phantom continuation");

    const expected = Array.from({ length: 307 }, (_, i) => i + 1).filter((id) => id !== 100);
    assert.equal(delivered.length, expected.length);
    assert.equal(new Set(delivered).size, expected.length, "no row or page-one pin is replayed");
    assert.deepEqual([...delivered].sort((a, b) => a - b), expected, "every initially eligible id is delivered");
    assert.ok(!delivered.includes(308) && !delivered.includes(309), "post-snapshot commits do not leak into the walk");

    const expectedUnpinned = expected
      .filter((id) => id !== 2 && id !== 307)
      .sort((a, b) => {
        const at = Math.floor((a + 1) / 2) * 1000;
        const bt = Math.floor((b + 1) / 2) * 1000;
        return bt - at || b - a;
      });
    assert.deepEqual(deliveredUnpinned, expectedUnpinned, "the predicate and ORDER BY share the same (created_at,id) boundary");

    // A new walk takes a new ID snapshot and can reach both concurrent rows,
    // including the higher-id row carrying the oldest timestamp.
    let fresh = await newestPage(envFor(db), 100, filters);
    const freshIds = fresh.posts.map((post) => post.id);
    const freshSnapshot = fresh.snapshot_id;
    const freshPinSnapshot = fresh.pin_snapshot;
    assert.equal(freshSnapshot, 309);
    assert.equal(fresh.board_total, 309);
    while (fresh.has_more) {
      assert.ok(fresh.next_before);
      fresh = await newestPage(envFor(db), 100, filters, parseBefore(fresh.next_before), freshSnapshot, freshPinSnapshot);
      freshIds.push(...fresh.posts.map((post) => post.id));
    }
    assert.equal(freshIds.filter((id) => id === 308).length, 1);
    assert.equal(freshIds.filter((id) => id === 309).length, 1);
  } finally {
    db.close();
  }
});

test("the frozen page-one pin set survives pin and unpin changes between pages", async () => {
  const db = freshDb();
  seedPosts(db, 6, { pins: [1, 6] });
  try {
    const first = await newestPage(envFor(db), 2);
    assert.deepEqual(first.posts.map((post) => post.id), [6, 1, 5, 4]);
    assert.equal(first.pin_snapshot, "1,6");
    assert.ok(first.next_before);

    // Row 1 was already floated and must not replay after it is unpinned. Row 2
    // was not yet read and must remain in the chronological stream after it is
    // pinned. Continuations therefore exclude the frozen ids, never live state.
    db.exec("UPDATE posts SET pinned = 0 WHERE id = 1; UPDATE posts SET pinned = 1 WHERE id = 2;");
    const second = await newestPage(
      envFor(db),
      2,
      { tag: [], exclude: [] },
      parseBefore(first.next_before),
      first.snapshot_id,
      first.pin_snapshot,
    );
    assert.deepEqual(second.posts.map((post) => post.id), [3, 2]);
    assert.equal(second.pinned_extra, 0);
    assert.equal(second.posts.find((post) => post.id === 2)?.pinned, 1, "live decoration may change without changing membership");
    const ids = [...first.posts, ...second.posts].map((post) => post.id);
    assert.deepEqual([...ids].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
    assert.equal(new Set(ids).size, 6);
  } finally {
    db.close();
  }
});

test("the ID snapshot is taken before the first page SELECT", async () => {
  const db = freshDb();
  seedPosts(db, 5);
  let injected = false;
  const hooked = envFor(db, (sql) => {
    if (injected || !sql.includes("COALESCE(MAX(id), 0) AS snapshot_id")) return;
    injected = true;
    db.prepare(
      `INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at)
       VALUES (6, 1, 'committed after MAX', 'body 6', 'feed-6', 500)`,
    ).run();
  });
  try {
    const first = await newestPage(hooked, 100);
    assert.equal(first.snapshot_id, 5);
    assert.equal(first.board_total, 5);
    assert.deepEqual(first.posts.map((post) => post.id).sort((a, b) => a - b), [1, 2, 3, 4, 5]);
    assert.ok(!first.posts.some((post) => post.id === 6));

    const fresh = await newestPage(envFor(db), 100);
    assert.equal(fresh.snapshot_id, 6);
    assert.ok(fresh.posts.some((post) => post.id === 6));
  } finally {
    db.close();
  }
});

test("whole-board filters reach old matches and preserve the asymmetric pin rules", async () => {
  const db = freshDb();
  seedPosts(db, 305, { pins: [2, 305] });
  db.exec(`
    INSERT INTO tags (post_id, tag, citizen_id, created_at) VALUES
      (1, 'needle', 1, 1),
      (2, 'needle', 1, 1),
      (3, 'blocked', 1, 1),
      (305, 'blocked', 1, 1);
  `);
  try {
    const allow = await newestPage(envFor(db), 1, { tag: ["needle"], exclude: [] });
    assert.deepEqual(allow.posts.map((post) => post.id), [2, 1], "the old matching pin and row remain reachable beyond 300");
    assert.equal(allow.pinned_extra, 1, "an unrelated pin does not impersonate an allowlist match");
    assert.equal(allow.has_more, false);

    let excluded = await newestPage(envFor(db), 100, { tag: [], exclude: ["blocked"] });
    const ids = excluded.posts.map((post) => post.id);
    const snapshotId = excluded.snapshot_id;
    const pinSnapshot = excluded.pin_snapshot;
    assert.equal(excluded.has_more, true, "305 rows cannot fit in the first 100-row filtered page");
    assert.equal(ids[0], 305, "a blocked-tag pin remains the disclosed exclude-direction exemption");
    // Freeze that classification: a later pin cannot grant the still-unread
    // blocked row 3 an exemption, and unpinning 305 cannot replay it.
    db.exec("UPDATE posts SET pinned = 1 WHERE id = 3; UPDATE posts SET pinned = 0 WHERE id = 305;");
    while (excluded.has_more) {
      assert.ok(excluded.next_before);
      excluded = await newestPage(
        envFor(db),
        100,
        { tag: [], exclude: ["blocked"] },
        parseBefore(excluded.next_before),
        snapshotId,
        pinSnapshot,
      );
      ids.push(...excluded.posts.map((post) => post.id));
    }
    assert.equal(ids.filter((id) => id === 305).length, 1);
    assert.ok(!ids.includes(3), "the same excluded tag removes an ordinary row");
    assert.ok(ids.includes(1), "the walk must actually reach an old allowed row");
    assert.deepEqual(
      [...ids].sort((a, b) => a - b),
      Array.from({ length: 305 }, (_, index) => index + 1).filter((id) => id !== 3),
      "every allowed row in the filtered snapshot is delivered exactly once",
    );
    assert.equal(new Set(ids).size, ids.length);
  } finally {
    db.close();
  }
});

test("the HTTP /api/new route carries its advertised continuation", async () => {
  const db = freshDb();
  seedPosts(db, 5, { pins: [1] });
  db.prepare("UPDATE posts SET body = NULL WHERE id = 2").run();
  try {
    const env = envFor(db);
    const firstResponse = await worker.fetch(new Request("https://1f916.ai/api/new?limit=2"), env);
    assert.equal(firstResponse.status, 200);
    const first = (await firstResponse.json()) as {
      now: number;
      posts: Array<{ id: number; body: string | null }>;
      snapshot_id: number;
      pin_snapshot: string;
      next_before: string;
      has_more: boolean;
      pinned_extra: number;
    };
    assert.equal(first.has_more, true);
    assert.equal(first.pinned_extra, 1);
    assert.ok(Number.isSafeInteger(first.now));

    const secondUrl = new URL("https://1f916.ai/api/new");
    secondUrl.searchParams.set("limit", "2");
    secondUrl.searchParams.set("snapshot_id", String(first.snapshot_id));
    secondUrl.searchParams.set("pin_snapshot", first.pin_snapshot);
    secondUrl.searchParams.set("before", first.next_before);
    const secondResponse = await worker.fetch(new Request(secondUrl), env);
    assert.equal(secondResponse.status, 200);
    const second = (await secondResponse.json()) as {
      posts: Array<{ id: number; body: string | null }>;
      snapshot_id: number;
      pin_snapshot: string;
      has_more: boolean;
      pinned_extra: number;
    };
    assert.equal(second.snapshot_id, first.snapshot_id);
    assert.equal(second.pin_snapshot, first.pin_snapshot);
    assert.equal(second.pinned_extra, 0);
    const walkedPosts = [...first.posts, ...second.posts];
    assert.equal(new Set(walkedPosts.map((post) => post.id)).size, 5);
    assert.equal(walkedPosts.find((post) => post.id === 2)?.body, null, "bodyless posts remain valid feed rows");
    assert.equal(second.has_more, false);

    const legacyLimit = await worker.fetch(new Request("https://1f916.ai/api/front?limit=2.0"), env);
    assert.equal(legacyLimit.status, 200, "established positive-integer spellings stay compatible");
    assert.equal(((await legacyLimit.json()) as { limit: number }).limit, 2);

    const clampedResponse = await worker.fetch(new Request("https://1f916.ai/api/new?limit=200"), env);
    assert.equal(clampedResponse.status, 200);
    assert.equal(((await clampedResponse.json()) as { limit: number }).limit, 100, "the disclosed maximum remains backward compatible");

    const future = await worker.fetch(new Request("https://1f916.ai/api/new?snapshot_id=6"), env);
    assert.equal(future.status, 400, "a caller cannot manufacture a snapshot that admits future inserts");
    assert.match(((await future.json()) as { error: string }).error, /beyond the current board/);
  } finally {
    db.close();
  }
});

test("new/front reject ignored or ambiguous query parameters before D1 is touched", async () => {
  const env = Object.defineProperty({}, "DB", {
    get() {
      throw new Error("invalid query reached D1");
    },
  }) as Env;

  const cases: Array<[string, RegExp[]]> = [
    ["/api/new?offset=30&zzz=nonsense", [/offset/, /zzz/, /Supported:/]],
    ["/api/new?page=2", [/page/, /does not support/]],
    ["/api/new?limit=5&limit=6", [/limit/, /repeated/]],
    ["/api/new?before=600", [/before must be '<created_at>:<id>'/]],
    ["/api/new?before=1000:4", [/before requires the/, /snapshot_id/, /pin_snapshot/]],
    ["/api/new?before=1000:4&snapshot_id=4", [/before requires the pin_snapshot/]],
    ["/api/new?pin_snapshot=2,1", [/pin_snapshot/, /ascending/]],
    ["/api/new?pin_snapshot=1%29%20OR%201%3D1--", [/pin_snapshot/, /comma-separated/]],
    ["/api/new?snapshot_id=01", [/snapshot_id/, /canonical/]],
    ["/api/front?before=1000:4", [/\/api\/front/, /before/]],
  ];

  for (const [path, expected] of cases) {
    const response = await worker.fetch(new Request(`https://1f916.ai${path}`), env);
    assert.equal(response.status, 400, path);
    const payload = (await response.json()) as { error: string };
    for (const pattern of expected) assert.match(payload.error, pattern, path);
  }
});
