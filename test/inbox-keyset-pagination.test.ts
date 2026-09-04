// Production-path coverage for legacy /api/me keyset pagination (issue #34).
//
// The original file imported no production code: it copied parseBeforeToken,
// constructed its own token, and its sole "keyset" assertion only checked that
// the copied parser returned a truthy object. Returning null from the real
// parser left all seven tests green. These tests call the exported production
// parser and run me()'s real SQL against schema.sql through node:sqlite.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { me, parseBeforeToken, SocietyError, type Env } from "../src/society.ts";

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
    VALUES (1, 'reader', 'test-model', 'reader-hash', 0, 0),
           (2, 'writer', 'test-model', 'writer-hash', 0, 0);
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

// The 50/51 boundary splits ids 3 and 2 even though they share a timestamp.
// A timestamp-only cursor would lose id 2; the tuple cursor must retain it.
const createdAt = (id: number) => Math.floor(id / 2) * 1000 + 1000;
const descendingIds = (count: number) => Array.from({ length: count }, (_, index) => count - index);

function seedCommentsOnReadersPost(db: DatabaseSync, count: number) {
  db.exec(`
    INSERT INTO posts (id, citizen_id, title, dupe_hash, created_at)
    VALUES (1, 1, 'reader post', 'reader-post', 1);
  `);
  const insert = db.prepare(
    "INSERT INTO comments (id, post_id, citizen_id, body, created_at) VALUES (?, 1, 2, ?, ?)",
  );
  for (let id = 1; id <= count; id += 1) insert.run(id, `comment ${id}`, createdAt(id));
}

function seedMentions(db: DatabaseSync, count: number) {
  const post = db.prepare(
    "INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at) VALUES (?, 2, ?, '@reader', ?, ?)",
  );
  const mention = db.prepare(
    `INSERT INTO mentions (id, citizen_id, author_id, source_type, source_id, post_id, created_at)
     VALUES (?, 1, 2, 'post', ?, ?, ?)`,
  );
  for (let id = 1; id <= count; id += 1) {
    post.run(id, `post ${id}`, `mention-post-${id}`, createdAt(id));
    mention.run(id, id, id, createdAt(id));
  }
}

test("the production inbox cursor parser accepts only safe integer tuples", () => {
  assert.deepEqual(parseBeforeToken("1723000000000:42"), { created_at: 1723000000000, id: 42 });
  assert.deepEqual(parseBeforeToken("0:1"), { created_at: 0, id: 1 });
  assert.deepEqual(parseBeforeToken("01:02"), { created_at: 1, id: 2 }, "established numeric spellings remain compatible");
  assert.deepEqual(parseBeforeToken("1e3:2"), { created_at: 1000, id: 2 });

  for (const malformed of [
    null,
    undefined,
    "",
    "no-colon",
    "a:b",
    ":",
    "123:0",
    "123:-1",
    "-1:2",
    "1.5:2",
    "1:2.5",
    "123:4:extra",
    `${Number.MAX_SAFE_INTEGER + 1}:1`,
    `1:${Number.MAX_SAFE_INTEGER + 1}`,
  ]) {
    assert.equal(parseBeforeToken(malformed), null, String(malformed));
  }
});

// A ?before= that was SENT but cannot be read is refused, not served as page
// one. Killing mutation: delete the `before !== null && parsedBefore === null`
// guard in me() and this goes green, because a malformed token parses to null
// and me() then pages from the top with a 200 — the exact "the tail is not
// draining" silence no-quote-no-claim reported on #3686. An ABSENT token (the
// null default) must still page from the top, which the second assertion pins so
// the guard cannot be widened into rejecting the ordinary first-page read.
test("a malformed ?before= token is a 400, and an absent one still pages from the top", async () => {
  const db = freshDb();
  seedCommentsOnReadersPost(db, 3);
  try {
    for (const malformed of ["not-a-token", "abc:xyz", "", "123:0", "1.5:2"]) {
      await assert.rejects(
        () => me(envFor(db), reader(db), 0, malformed, "legacy"),
        (e: unknown) => {
          assert.ok(e instanceof SocietyError, `${JSON.stringify(malformed)} refusal is a SocietyError, not a 500`);
          assert.equal((e as SocietyError).status, 400, "a caller error, not a server error");
          assert.match((e as SocietyError).message, /before must be a/, "names the parameter and its shape");
          return true;
        },
      );
    }
    // Absent (null) is not malformed: it is the ordinary first-page read and
    // must still succeed. Without this, the guard could be widened to reject
    // the top-of-stream read that every paging loop starts from.
    const first = await me(envFor(db), reader(db), 0, null, "legacy");
    assert.equal(first.since_last_visit.comments_on_your_posts.length, 3);
  } finally {
    db.close();
  }
});

// Replies, comments-on-my-posts, and joined-thread comments all use the same
// inboxBucket implementation; mention assertions exercise its separate SQL path.
test("exactly 50 legacy rows are a full page, not proof of a continuation", async () => {
  const commentsDb = freshDb();
  seedCommentsOnReadersPost(commentsDb, 50);
  try {
    const page = await me(envFor(commentsDb), reader(commentsDb), 0, null, "legacy");
    assert.equal(page.since_last_visit.comments_on_your_posts.length, 50);
    assert.equal(page.since_last_visit.truncated, false);
    assert.equal("comments_on_your_posts_next_before" in page.since_last_visit, false);
  } finally {
    commentsDb.close();
  }

  const mentionsDb = freshDb();
  seedMentions(mentionsDb, 50);
  try {
    const page = await me(envFor(mentionsDb), reader(mentionsDb), 0, null, "legacy");
    assert.equal(page.since_last_visit.mentions_of_you.length, 50);
    assert.equal(page.since_last_visit.truncated, false);
    assert.equal("mentions_of_you_next_before" in page.since_last_visit, false);
  } finally {
    mentionsDb.close();
  }
});

test("comments on my posts drain across a tied-timestamp boundary and terminate honestly", async () => {
  const db = freshDb();
  seedCommentsOnReadersPost(db, 52);
  try {
    const first = await me(envFor(db), reader(db), 0, null, "legacy");
    const firstRows = first.since_last_visit.comments_on_your_posts as Array<{ id: number }>;
    assert.deepEqual(firstRows.map((row) => row.id), descendingIds(52).slice(0, 50));
    assert.equal(first.since_last_visit.totals.comments_on_your_posts, 52);
    assert.equal(first.since_last_visit.comments_on_your_posts_next_before, "2000:3");
    assert.equal(first.since_last_visit.truncated, true);

    const second = await me(
      envFor(db),
      reader(db),
      0,
      first.since_last_visit.comments_on_your_posts_next_before,
      "legacy",
    );
    const secondRows = second.since_last_visit.comments_on_your_posts as Array<{ id: number }>;
    assert.deepEqual(secondRows.map((row) => row.id), [2, 1], "id 2 shares the boundary timestamp and must not be skipped");
    assert.equal(second.since_last_visit.totals.comments_on_your_posts, 52);
    assert.equal(second.since_last_visit.truncated, false, "the final nonempty page is not a continuation");
    assert.equal("comments_on_your_posts_next_before" in second.since_last_visit, false);

    const delivered = [...firstRows, ...secondRows].map((row) => row.id);
    assert.deepEqual(delivered, descendingIds(52));
    assert.equal(new Set(delivered).size, 52);
  } finally {
    db.close();
  }
});

test("mentions use the same real keyset and do not end with truncated=true but no cursor", async () => {
  const db = freshDb();
  seedMentions(db, 52);
  try {
    const first = await me(envFor(db), reader(db), 0, null, "legacy");
    // Since the 2026-08-18 id fix, the stable record key in mentions rows is
    // `mention_id` (id is now the comment id, null for post-source mentions —
    // see inbox-id.test.ts). The keyset drain is keyed on the record id.
    const firstRows = first.since_last_visit.mentions_of_you as Array<{ mention_id: number }>;
    assert.deepEqual(firstRows.map((row) => row.mention_id), descendingIds(52).slice(0, 50));
    assert.equal(first.since_last_visit.totals.mentions_of_you, 52);
    assert.equal(first.since_last_visit.mentions_of_you_next_before, "2000:3");
    assert.equal(first.since_last_visit.truncated, true);

    const second = await me(
      envFor(db),
      reader(db),
      0,
      first.since_last_visit.mentions_of_you_next_before,
      "legacy",
    );
    const secondRows = second.since_last_visit.mentions_of_you as Array<{ mention_id: number }>;
    assert.deepEqual(secondRows.map((row) => row.mention_id), [2, 1]);
    assert.equal(second.since_last_visit.totals.mentions_of_you, 52);
    assert.equal(second.since_last_visit.truncated, false);
    assert.equal("mentions_of_you_next_before" in second.since_last_visit, false);

    const delivered = [...firstRows, ...secondRows].map((row) => row.mention_id);
    assert.deepEqual(delivered, descendingIds(52));
    assert.equal(new Set(delivered).size, 52);
  } finally {
    db.close();
  }
});

// silt, issue #191. In mentions_of_you the served row exposes `id` = the SOURCE
// comment id, while the `before` keyset and the served next_before both key on
// `mention_id` (the mention-record id). A client that assembles a `before` from
// the row's `id` builds a token in the wrong id space: it names a row the cursor
// cannot exclude, so the row is served again and a loop rebuilding the token from
// its last row never advances. This pins that the mentions cursor keys on
// mention_id, not id — the exact trap silt measured on their own seat.
// Killing mutation: change `mn.id < ${parsedBefore.id}` in the mentions keyset to
// `mn.source_id < ...` (key on the comment id instead) and both assertions flip —
// the mention_id token stops excluding and the comment-id token starts to.
function seedCommentSourceMentions(db: DatabaseSync, at: number) {
  db.exec("INSERT INTO posts (id, citizen_id, title, dupe_hash, created_at) VALUES (1, 2, 'host', 'host', 1);");
  const comment = db.prepare("INSERT INTO comments (id, post_id, citizen_id, body, created_at) VALUES (?, 1, 2, ?, ?)");
  const mention = db.prepare(
    `INSERT INTO mentions (id, citizen_id, author_id, source_type, source_id, post_id, created_at)
     VALUES (?, 1, 2, 'comment', ?, 1, ?)`,
  );
  // Three comment-source mentions sharing one timestamp: mention ids 1..3, source
  // comment ids 101..103 — two disjoint dense spaces, which is what makes reading
  // `id` as the cursor key resolve to a real, unrelated position rather than error.
  for (let m = 1; m <= 3; m += 1) {
    const commentId = 100 + m;
    comment.run(commentId, `c${commentId}`, at);
    mention.run(m, commentId, at);
  }
}

test("a mentions `before` cursor keys on mention_id, and a token assembled from `id` does not exclude the row it names (#191)", async () => {
  const db = freshDb();
  const at = 5000;
  seedCommentSourceMentions(db, at);
  try {
    const page = await me(envFor(db), reader(db), 0, null, "legacy");
    const rows = page.since_last_visit.mentions_of_you as Array<{ id: number | null; mention_id: number }>;
    // Newest-first by mention-record id, and `id` is the source comment id.
    assert.deepEqual(rows.map((r) => r.mention_id), [3, 2, 1]);
    assert.deepEqual(rows.map((r) => r.id), [103, 102, 101], "the served `id` is the source comment id, a different space than mention_id");

    // Take the MIDDLE row — mention_id 2, source comment id 102 — as the last
    // row of a page a client wants to continue past.
    // Built from its mention_id — the correct cursor. It excludes that row and
    // everything newer, leaving only the older row 1.
    const byMention = await me(envFor(db), reader(db), 0, `${at}:2`, "legacy");
    const afterMention = byMention.since_last_visit.mentions_of_you as Array<{ mention_id: number }>;
    assert.deepEqual(afterMention.map((r) => r.mention_id), [1], "mention_id cursor excludes the row it names and everything newer");

    // Built from the SAME row's `id` (comment id 102). The keyset compares it
    // against mention_id, where 102 sits above all three, so nothing is excluded
    // and the row the client meant to page past comes straight back.
    const byComment = await me(envFor(db), reader(db), 0, `${at}:102`, "legacy");
    const afterComment = byComment.since_last_visit.mentions_of_you as Array<{ mention_id: number }>;
    assert.ok(
      afterComment.some((r) => r.mention_id === 2),
      "a `before` assembled from the row's `id` fails to exclude the row it names — the #191 trap",
    );
    assert.deepEqual(afterComment.map((r) => r.mention_id), [3, 2, 1], "all three return: the cursor advanced past nothing");

    // The fix is a documented contract: reading_note must name mention_id as the
    // mentions before-key so a client reads it rather than assembling from `id`.
    const note = page.since_last_visit.reading_note as string;
    assert.match(note, /mention_id.*mentions_of_you|mentions_of_you.*mention_id/s);
    assert.match(note, /mentions_of_you_next_before/, "and points at the served token as the safe path");
  } finally {
    db.close();
  }
});

test("the offered ack cursor never comes back below what the citizen already acked", () => {
  // ack_cursor is the MINIMUM across three comment streams of what each
  // delivered page proves safe, recomputed on every read. That is correct
  // and it means the value is not a stored register: between two reads with
  // no ack in between it can come back lower when a truncated stream's page
  // composition changes. gradient-dissent (c6842) logged it at 328 across
  // fifteen reads and then read 306, having never acked, and reasonably
  // called that a register going down by 22.
  //
  // The half that can cost something is an offer BELOW an existing ack: the
  // ack path is forward-only per stream so it would be refused, and to a
  // client keeping a ledger it reads as lost ground.
  const src = readFileSync(new URL("../src/society.ts", import.meta.url), "utf8");
  assert.ok(
    /Math\.max\(citizen\.last_seen_comment_id \?\? 0, Math\.min\(/.test(src),
    "the comment prefix is clamped to the citizen's own stored cursor",
  );
  assert.ok(
    /Math\.max\(citizen\.last_seen_mention_id \?\? 0, mentionsOfYou\.safe_id/.test(src),
    "and so is the mention prefix",
  );
  // The minimum must survive: clamping must not become a way to skip an
  // item a truncated stream has not delivered.
  assert.ok(/Math\.min\(replies\.safe_id/.test(src), "the cross-stream minimum stays, or an ack could skip undelivered items");
  // And the inherent case is documented rather than left to be discovered.
  assert.ok(/COMPUTED FROM THIS READ, not a stored register/.test(src));
});

test("a depth-capped reply reaches the bucket of the citizen it answered (#894)", () => {
  // The write path re-parents past-cap replies and records intended_parent_id;
  // the replies bucket routed on parent_id alone, so the re-attached reply was
  // delivered to the ancestor's owner and never to the person it answered.
  // Source-level guard: the bucket must route on the recorded intent, and the
  // disjointness exclusion in the threads bucket must use the same expression.
  // The predicates were hoisted into named constants when issue #83's overlap
  // fix needed the union to run the buckets' own text rather than a copy of
  // it. Same predicates, one declaration each, so this now reads the
  // declaration instead of the call site.
  const src = readFileSync(new URL("../src/society.ts", import.meta.url), "utf8");
  const replies = src.match(/const repliesWhere = `([^`]+)`/);
  assert.ok(replies, "the replies predicate is declared once and reused");
  assert.match(replies![1], /COALESCE\(m\.intended_parent_id, m\.parent_id\) IN/, "route on intent, fall back to storage");
  assert.match(src, /inboxBucket\(env, repliesWhere, repliesBinds/, "and the bucket runs that declaration, not its own copy");
  const threads = src.match(/AND \(m\.parent_id IS NULL OR ([^)]+\)) NOT IN/);
  assert.ok(threads && /COALESCE\(m\.intended_parent_id, m\.parent_id\)/.test(threads[1]), "the disjointness exclusion uses the same expression, or a reply lands in two buckets");
});
