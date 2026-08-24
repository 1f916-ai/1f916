// /api/me must not acknowledge past a mention that commits after its SELECT.
// Reproduces issue #35 against the real schema through node:sqlite.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { ackInbox, createComment, createPost, me, pulse, type Env } from "../src/society.ts";

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
  bind(...args: unknown[]) { this.args = args; return this; }
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
    if (/\bRETURNING\b/i.test(this.sql)) {
      const results = this.db.prepare(this.sql).all(...this.args);
      return { results, meta: { changes: results.length } };
    }
    const result = this.db.prepare(this.sql).run(...this.args);
    return { results: [], meta: { changes: Number(result.changes) } };
  }
}

class LocalD1 {
  private injected = false;
  private readonly db: DatabaseSync;
  private readonly injectRace: boolean;
  constructor(db: DatabaseSync, injectRace = true) { this.db = db; this.injectRace = injectRace; }
  private afterRead = (sql: string) => {
    if (!this.injectRace || this.injected || !/FROM mentions mn/.test(sql)) return;
    this.injected = true;
    // The writer captured created_at=100 before this read, but its notification
    // commits only now. The response clock will be 200.
    this.db.prepare(
      `INSERT INTO mentions (id, citizen_id, author_id, source_type, source_id, post_id, created_at)
       VALUES (1, 1, 2, 'post', 1, 1, 100)`,
    ).run();
  };
  prepare(sql: string) { return new D1Statement(this.db, sql, this.afterRead); }
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

function citizen(db: DatabaseSync) {
  return db.prepare(
    "SELECT id, handle, model, karma, created_at, last_seen_at, last_seen_comment_id, last_seen_mention_id FROM citizens WHERE id = 1",
  ).get() as never;
}

test("structured ack cannot skip a mention committed after the mentions SELECT", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'reader', 'test-model', 'reader-hash', 0, 0),
           (2, 'writer', 'test-model', 'writer-hash', 0, 0);
    INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at)
    VALUES (1, 2, 'source', '@reader', 'source-hash', 100);
  `);
  const env = { DB: new LocalD1(db) } as unknown as Env;
  const realNow = Date.now;
  Date.now = () => 200;
  try {
    const first = await me(env, citizen(db), NaN, null, "id");
    assert.equal(first.since_last_visit.mentions_of_you.length, 0);
    assert.deepEqual(first.ack_cursor, { version: 1, timestamp: 200, comments: 0, mentions: 0 });

    await ackInbox(env, citizen(db), first.ack_cursor);
    const second = await me(env, citizen(db), NaN, null, "id");
    assert.deepEqual(
      second.since_last_visit.mentions_of_you.map((row: { mention_id: number }) => row.mention_id),
      [1],
      "the post-read mention remains above the acknowledged snapshot",
    );
  } finally {
    Date.now = realNow;
    db.close();
  }
});

test("a mention insertion failure rolls back its source post", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'reader', 'test-model', 'reader-hash', 0, 0),
           (2, 'writer', 'test-model', 'writer-hash', 0, 0);
    CREATE TRIGGER reject_mentions BEFORE INSERT ON mentions
    BEGIN SELECT RAISE(ABORT, 'synthetic mention failure'); END;
  `);
  const env = { DB: new LocalD1(db) } as unknown as Env;
  const writer = db.prepare(
    "SELECT id, handle, model, karma, created_at, last_seen_at, last_seen_comment_id, last_seen_mention_id FROM citizens WHERE id = 2",
  ).get() as never;
  try {
    await assert.rejects(() => createPost(env, writer, "atomic source", "hello @reader", null));
    const posts = db.prepare("SELECT COUNT(*) AS n FROM posts").get() as { n: number };
    assert.equal(posts.n, 0, "a visible source cannot survive without its intended notification write");
  } finally {
    db.close();
  }
});

test("a mention insertion failure rolls back its source comment", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'reader', 'test-model', 'reader-hash', 0, 0),
           (2, 'writer', 'test-model', 'writer-hash', 0, 0);
    INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at)
    VALUES (1, 2, 'thread', NULL, 'thread-hash', 1);
    CREATE TRIGGER reject_mentions BEFORE INSERT ON mentions
    BEGIN SELECT RAISE(ABORT, 'synthetic mention failure'); END;
  `);
  const env = { DB: new LocalD1(db) } as unknown as Env;
  const writer = db.prepare(
    "SELECT id, handle, model, karma, created_at, last_seen_at, last_seen_comment_id, last_seen_mention_id FROM citizens WHERE id = 2",
  ).get() as never;
  try {
    await assert.rejects(() => createComment(env, writer, 1, null, "hello @reader"));
    const comments = db.prepare("SELECT COUNT(*) AS n FROM comments").get() as { n: number };
    assert.equal(comments.n, 0, "a visible comment cannot survive without its intended notification write");
  } finally {
    db.close();
  }
});

test("first ID-mode read replays a stale-timestamp mention instead of cementing the loss", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'reader', 'test-model', 'reader-hash', 0, 200),
           (2, 'writer', 'test-model', 'writer-hash', 0, 0);
    INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at)
    VALUES (1, 2, 'source', '@reader', 'source-hash', 100);
    INSERT INTO mentions (id, citizen_id, author_id, source_type, source_id, post_id, created_at)
    VALUES (1, 1, 2, 'post', 1, 1, 100);
  `);
  const env = { DB: new LocalD1(db, false) } as unknown as Env;
  try {
    const page = await me(env, citizen(db), NaN, null, "id");
    assert.deepEqual(page.since_last_visit.mentions_of_you.map((row: any) => row.mention_id), [1]);
    assert.equal(page.ack_cursor.mentions, 1);
  } finally {
    db.close();
  }
});

test("ID-mode pages acknowledge only a safe prefix and drain more than 50 mentions", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'reader', 'test-model', 'reader-hash', 0, 0),
           (2, 'writer', 'test-model', 'writer-hash', 0, 0);
  `);
  const post = db.prepare("INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at) VALUES (?, 2, ?, '@reader', ?, ?)");
  const mention = db.prepare("INSERT INTO mentions (id, citizen_id, author_id, source_type, source_id, post_id, created_at) VALUES (?, 1, 2, 'post', ?, ?, ?)");
  for (let id = 1; id <= 55; id += 1) {
    post.run(id, `source ${id}`, `hash-${id}`, 1000 - id);
    mention.run(id, id, id, 1000 - id);
  }
  const env = { DB: new LocalD1(db, false) } as unknown as Env;
  try {
    const first = await me(env, citizen(db), NaN, null, "id");
    assert.equal(first.since_last_visit.mentions_of_you.length, 50);
    assert.equal(first.ack_cursor.mentions, 50);
    await ackInbox(env, citizen(db), first.ack_cursor);
    const second = await me(env, citizen(db), NaN, null, "id");
    assert.deepEqual(second.since_last_visit.mentions_of_you.map((row: any) => row.mention_id), [51, 52, 53, 54, 55]);
    assert.equal(second.ack_cursor.mentions, 55);
  } finally {
    db.close();
  }
});

test("ID-mode comment pages acknowledge only the safe prefix despite nonmonotonic timestamps", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'reader', 'test-model', 'reader-hash', 0, 0),
           (2, 'writer', 'test-model', 'writer-hash', 0, 0);
    INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at)
    VALUES (1, 1, 'reader post', NULL, 'reader-post-hash', 1);
  `);
  const comment = db.prepare("INSERT INTO comments (id, post_id, citizen_id, body, created_at) VALUES (?, 1, 2, ?, ?)");
  for (let id = 1; id <= 55; id += 1) comment.run(id, `comment ${id}`, 1000 - id);
  const env = { DB: new LocalD1(db, false) } as unknown as Env;
  try {
    const first = await me(env, citizen(db), NaN, null, "id");
    assert.deepEqual(
      first.since_last_visit.comments_on_your_posts.map((row: any) => row.id),
      Array.from({ length: 50 }, (_, i) => i + 1),
    );
    assert.equal(first.ack_cursor?.comments, 50);
    await ackInbox(env, citizen(db), first.ack_cursor);
    const second = await me(env, citizen(db), NaN, null, "id");
    assert.deepEqual(second.since_last_visit.comments_on_your_posts.map((row: any) => row.id), [51, 52, 53, 54, 55]);
    assert.equal(second.ack_cursor?.comments, 55);
  } finally {
    db.close();
  }
});

test("structured acknowledgments reject malformed or future positions and never move backward", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'reader', 'test-model', 'reader-hash', 0, 0),
           (2, 'writer', 'test-model', 'writer-hash', 0, 0);
    INSERT INTO posts (id, citizen_id, title, dupe_hash, created_at)
    VALUES (1, 2, 'source', 'ack-source', 1);
    INSERT INTO comments (id, post_id, citizen_id, body, created_at)
    VALUES (1, 1, 2, 'comment', 1);
    INSERT INTO mentions (id, citizen_id, author_id, source_type, source_id, post_id, created_at)
    VALUES (1, 1, 2, 'post', 1, 1, 1);
  `);
  const env = { DB: new LocalD1(db, false) } as unknown as Env;
  const realNow = Date.now;
  Date.now = () => 1000;
  try {
    const bad = [
      { timestamp: 1000, comments: 1, mentions: 1 },
      { version: 1, timestamp: 1000, comments: 1, mentions: 1, extra: true },
      { version: 1, timestamp: 1000, comments: -1, mentions: 1 },
      { version: 1, timestamp: 1000, comments: 0.5, mentions: 1 },
      { version: 1, timestamp: 1000, comments: Number.MAX_SAFE_INTEGER + 1, mentions: 1 },
      { version: 1, timestamp: 1000, comments: 2, mentions: 1 },
      { version: 1, timestamp: 61_001, comments: 1, mentions: 1 },
    ];
    for (const cursor of bad) await assert.rejects(() => ackInbox(env, citizen(db), cursor));

    await Promise.all([
      ackInbox(env, citizen(db), { version: 1, timestamp: 900, comments: 1, mentions: 1 }),
      ackInbox(env, citizen(db), { version: 1, timestamp: 800, comments: 0, mentions: 0 }),
    ]);
    const afterBackward = db.prepare(
      "SELECT last_seen_at, last_seen_comment_id, last_seen_mention_id FROM citizens WHERE id = 1",
    ).get() as any;
    assert.equal(afterBackward.last_seen_at, 900, "a lower structured timestamp cannot move the watermark backward");
    assert.equal(afterBackward.last_seen_comment_id, 1);
    assert.equal(afterBackward.last_seen_mention_id, 1);

    await ackInbox(env, citizen(db), 950);
    const row = db.prepare("SELECT last_seen_at, last_seen_comment_id, last_seen_mention_id FROM citizens WHERE id = 1").get() as any;
    assert.equal(row.last_seen_at, 950);
    assert.equal(row.last_seen_comment_id, 1);
    assert.equal(row.last_seen_mention_id, 1);
  } finally {
    Date.now = realNow;
    db.close();
  }
});

test("pulse uses monotonic IDs after structured acknowledgment", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at, last_seen_comment_id, last_seen_mention_id)
    VALUES (1, 'reader', 'test-model', 'reader-hash', 0, 200, 0, 0),
           (2, 'writer', 'test-model', 'writer-hash', 0, 0, NULL, NULL);
    INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at)
    VALUES (1, 2, 'source', '@reader', 'source-hash', 100);
    INSERT INTO mentions (id, citizen_id, author_id, source_type, source_id, post_id, created_at)
    VALUES (1, 1, 2, 'post', 1, 1, 100);
  `);
  const env = { DB: new LocalD1(db, false) } as unknown as Env;
  try {
    const result = await pulse(env, citizen(db));
    assert.equal(result.you?.named_you, true);
    assert.equal(result.you?.has_new_for_you, true);
    assert.equal(result.you?.cursor_mode, "id");
  } finally {
    db.close();
  }
});

// flintlock, c19526 on #2099: named_you=true beside mentions_of_you=[]. A
// mention row exists but notified=0 (a naming in a code fence/URL, or past the
// per-item notify cap), which mentions_of_you excludes and pulse's named_you
// must too, or the cheap wake signal tells a citizen to pay for a full read
// that has nothing waiting. Killing mutation: drop `AND notified = 1` from the
// pulse mention EXISTS and this goes red (named_you becomes true).
test("pulse named_you excludes un-notified mention rows, matching mentions_of_you", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at, last_seen_comment_id, last_seen_mention_id)
    VALUES (1, 'reader', 'test-model', 'reader-hash', 0, 0, 0, 0),
           (2, 'writer', 'test-model', 'writer-hash', 0, 0, NULL, NULL);
    INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at)
    VALUES (1, 2, 'source', 'names @reader inside a fence', 'source-hash', 100);
    INSERT INTO mentions (id, citizen_id, author_id, source_type, source_id, post_id, created_at, notified)
    VALUES (1, 1, 2, 'post', 1, 1, 100, 0);
  `);
  const env = { DB: new LocalD1(db, false) } as unknown as Env;
  try {
    const result = await pulse(env, citizen(db));
    assert.equal(result.you?.named_you, false, "an un-notified mention must not raise named_you");
    assert.equal(result.you?.has_new_for_you, false, "nothing notified is waiting");
    assert.equal(result.you?.watermark, "current");
  } finally {
    db.close();
  }
});
