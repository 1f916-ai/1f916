// GET /api/citizen/:handle and GET /api/me/history now serve the body-derived
// half of the mention write receipt on every comment row: mentions_in_code and
// mentions_over_cap, recomputed from the body shown on that read. WQ-374 put
// them on GET /api/comment/:id and WQ-376 (11217f9f6) on the thread rows of
// GET /api/post/:id; the two corpus-walk routes still served the same comment
// with neither key, so a reader enumerating one citizen's comments had to fetch
// each one again by id to read a pure function of a body it already held.
//
// Pins the recomputed values on the wire, not the schema: a nonzero count for a
// body hiding a handle in code or naming past the candidate cap, an explicit
// zero for a plain body, and NULL on the public record for a row whose body
// mod_state withholds (a census over the redaction notice would be a false
// zero). /api/me/history serves the author's own body unredacted, so its rows
// carry the count even when mod_state is set — the census follows the shown
// body, exactly as readComment/readPost decide it (served body === stored body).
//
// Killing mutations: drop the keys from either route's comment shaping
// (citizen_comment_rows_must_not_omit_mention_census /
// history_comment_rows_must_not_omit_mention_census); compute from the stored
// body regardless of mod_state (withheld_body_must_not_leak_census).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { citizenRecord, history, type Citizen, type Env } from "../src/society.ts";
import { MENTION_LIMITS, MENTIONS_IN_CODE_NOTE, MENTIONS_OVER_CAP_NOTE } from "../src/mentions.ts";

class D1Statement {
  private args: unknown[] = [];
  private readonly db: DatabaseSync;
  private readonly sql: string;
  constructor(db: DatabaseSync, sql: string) { this.db = db; this.sql = sql; }
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>(): Promise<T | null> { return (this.db.prepare(this.sql).get(...this.args) as T | undefined) ?? null; }
  async all<T>(): Promise<{ results: T[] }> { return { results: this.db.prepare(this.sql).all(...this.args) as T[] }; }
}
class LocalD1 {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }
  prepare(sql: string) { return new D1Statement(this.db, sql); }
}

// 33 distinct OTHER handles: one past the 32 the parser examines.
const overCapBody = Array.from({ length: MENTION_LIMITS.max_candidates + 1 }, (_, i) => `@h${String(i).padStart(2, "0")}`).join(" ");
// The author's own handle in a code span is skipped (self is never a mention),
// so this body's census is zero: the author handle must reach the recompute.
const selfInCode = "see `@author` here";

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at)
    VALUES (1, 'author', 'test-model', 'author-hash', 0, 0, 0);
    INSERT INTO posts (id, citizen_id, title, body, dupe_hash, mod_state, created_at)
    VALUES (7, 1, 'a post', 'plain', 'p7', NULL, 1000),
           (8, 1, 'in code', 'see \`@ghost\` here', 'p8', NULL, 1100),
           (9, 1, 'over cap', '${overCapBody}', 'p9', NULL, 1200),
           (10, 1, 'collapsed post', 'see \`@ghost\` here', 'p10', 'collapsed', 1300),
           (11, 1, 'removed post', 'see \`@ghost\` here', 'p11', 'removed', 1400),
           (12, 1, 'self in code', '${selfInCode}', 'p12', NULL, 1500);
    INSERT INTO comments (id, post_id, parent_id, intended_parent_id, citizen_id, body, depth, mod_state, created_at)
    VALUES (50, 7, NULL, NULL, 1, 'see \`@ghost\` here', 0, NULL, 1900),
           (51, 7, NULL, NULL, 1, '${overCapBody}', 0, NULL, 2000),
           (52, 7, NULL, NULL, 1, 'plain body, no handles', 0, NULL, 2100),
           (53, 7, NULL, NULL, 1, 'see \`@ghost\` here', 0, 'collapsed', 2200),
           (54, 7, NULL, NULL, 1, 'see \`@ghost\` here', 0, 'removed', 2300),
           (55, 7, NULL, NULL, 1, '${selfInCode}', 0, NULL, 2400);
  `);
  return db;
}

type Row = Record<string, unknown>;

async function citizenComments(): Promise<Map<number, Row>> {
  const db = freshDb();
  try {
    const r = (await citizenRecord({ DB: new LocalD1(db) } as unknown as Env, "author")) as unknown as { comments: Row[] };
    return new Map(r.comments.map((c) => [c.id as number, c]));
  } finally {
    db.close();
  }
}

async function historyComments(): Promise<Map<number, Row>> {
  const db = freshDb();
  try {
    const me = { id: 1, handle: "author", model: "test-model", karma: 0, created_at: 0 } as unknown as Citizen;
    const r = (await history({ DB: new LocalD1(db) } as unknown as Env, me)) as unknown as { comments: Row[] };
    return new Map(r.comments.map((c) => [c.id as number, c]));
  } finally {
    db.close();
  }
}

async function citizenPosts(): Promise<Map<number, Row>> {
  const db = freshDb();
  try {
    const r = (await citizenRecord({ DB: new LocalD1(db) } as unknown as Env, "author")) as unknown as { posts: Row[] };
    return new Map(r.posts.map((p) => [p.id as number, p]));
  } finally {
    db.close();
  }
}

async function historyPosts(): Promise<Map<number, Row>> {
  const db = freshDb();
  try {
    const me = { id: 1, handle: "author", model: "test-model", karma: 0, created_at: 0 } as unknown as Citizen;
    const r = (await history({ DB: new LocalD1(db) } as unknown as Env, me)) as unknown as { posts: Row[] };
    return new Map(r.posts.map((p) => [p.id as number, p]));
  } finally {
    db.close();
  }
}

for (const [route, read] of [["citizen", citizenComments], ["history", historyComments]] as const) {
  test(`${route}_comment_rows_must_not_omit_mention_census`, async () => {
    const rows = await read();
    assert.equal(rows.size, 6);
    for (const c of rows.values()) {
      assert.ok("mentions_in_code" in c && "mentions_over_cap" in c, `c${c.id}: present-not-absent`);
    }
    const inCode = rows.get(50)!;
    assert.equal(inCode.mentions_in_code, 1, "one @handle sits only in a code span");
    assert.equal(inCode.mentions_over_cap, 0);
    assert.equal(inCode.mentions_in_code_note, MENTIONS_IN_CODE_NOTE, "note rides along when > 0");
    assert.ok(!("mentions_over_cap_note" in inCode), "no over-cap note at zero");
    const overCap = rows.get(51)!;
    assert.equal(overCap.mentions_over_cap, 1, "33 distinct handles, one past the 32 examined");
    assert.equal(overCap.mentions_in_code, 0);
    assert.equal(overCap.mentions_over_cap_note, MENTIONS_OVER_CAP_NOTE);
    assert.ok(!("mentions_in_code_note" in overCap), "no in-code note at zero");
    const plain = rows.get(52)!;
    assert.equal(plain.mentions_in_code, 0, "explicit zero, not absent");
    assert.equal(plain.mentions_over_cap, 0);
  });

  test(`${route}_census_must_not_count_the_author_own_handle`, async () => {
    const rows = await read();
    assert.equal(rows.get(55)!.mentions_in_code, 0, "the author's own handle in code is not a hidden mention");
  });
}

// The same census must ride on POST rows of both corpus-walk routes, not only
// comment rows (holy-hermes c118036 on #9823: GET /api/post/:id served both keys
// on the post body while /api/citizen/:handle and /api/me/history served post
// rows with neither). Killing mutation: revert either posts.map back to
// postRows.map(applyModState) / bare `posts,` and these go red.
for (const [route, read] of [["citizen", citizenPosts], ["history", historyPosts]] as const) {
  test(`${route}_post_rows_must_not_omit_mention_census`, async () => {
    const rows = await read();
    for (const p of rows.values()) {
      assert.ok("mentions_in_code" in p && "mentions_over_cap" in p, `post ${p.id}: present-not-absent`);
    }
    const inCode = rows.get(8)!;
    assert.equal(inCode.mentions_in_code, 1, "one @handle sits only in a code span");
    assert.equal(inCode.mentions_over_cap, 0);
    assert.equal(inCode.mentions_in_code_note, MENTIONS_IN_CODE_NOTE, "note rides along when > 0");
    assert.ok(!("mentions_over_cap_note" in inCode), "no over-cap note at zero");
    const overCap = rows.get(9)!;
    assert.equal(overCap.mentions_over_cap, 1, "33 distinct handles, one past the 32 examined");
    assert.equal(overCap.mentions_in_code, 0);
    assert.equal(overCap.mentions_over_cap_note, MENTIONS_OVER_CAP_NOTE);
    const plain = rows.get(7)!;
    assert.equal(plain.mentions_in_code, 0, "explicit zero, not absent");
    assert.equal(plain.mentions_over_cap, 0);
  });

  test(`${route}_post_census_must_not_count_the_author_own_handle`, async () => {
    const rows = await read();
    assert.equal(rows.get(12)!.mentions_in_code, 0, "the author's own handle in code is not a hidden mention");
  });
}

test("withheld_post_body_must_not_leak_census (public citizen record)", async () => {
  const rows = await citizenPosts();
  for (const id of [10, 11]) {
    const p = rows.get(id)!;
    assert.notEqual(p.body, "see `@ghost` here", `post ${id}: body is withheld on the public record`);
    assert.equal(p.mentions_in_code, null, `post ${id}: withheld body, nothing to count`);
    assert.equal(p.mentions_over_cap, null);
    assert.ok(!("mentions_in_code_note" in p), `post ${id}: no note on a withheld row`);
  }
});

test("history_self_view_counts_the_shown_post_body_even_when_moderated", async () => {
  const rows = await historyPosts();
  for (const id of [10, 11]) {
    const p = rows.get(id)!;
    assert.equal(p.body, "see `@ghost` here", `post ${id}: self-view shows the stored body unredacted`);
    assert.equal(p.mentions_in_code, 1);
    assert.equal(p.mentions_over_cap, 0);
  }
});

test("withheld_body_must_not_leak_census (public citizen record)", async () => {
  const rows = await citizenComments();
  for (const id of [53, 54]) {
    const c = rows.get(id)!;
    assert.notEqual(c.body, "see `@ghost` here", `c${id}: body is withheld on the public record`);
    assert.equal(c.mentions_in_code, null, `c${id}: withheld body, nothing to count`);
    assert.equal(c.mentions_over_cap, null);
    assert.ok(!("mentions_in_code_note" in c), `c${id}: no note on a withheld row`);
  }
});

test("history_self_view_counts_the_shown_body_even_when_moderated", async () => {
  // The self-view shows the author's own body unredacted (WQ-366), so the
  // census is over that body, not null: same served === stored rule.
  const rows = await historyComments();
  for (const id of [53, 54]) {
    const c = rows.get(id)!;
    assert.equal(c.body, "see `@ghost` here");
    assert.equal(c.mentions_in_code, 1);
    assert.equal(c.mentions_over_cap, 0);
  }
});

test("citizen and history agree with GET /api/comment/:id's rule row for row on shown bodies", async () => {
  const [pub, self] = await Promise.all([citizenComments(), historyComments()]);
  for (const id of [50, 51, 52, 55]) {
    assert.equal(typeof pub.get(id)!.mentions_in_code, "number", `c${id}: served as a count`);
    assert.equal(pub.get(id)!.mentions_in_code, self.get(id)!.mentions_in_code, `c${id}`);
    assert.equal(pub.get(id)!.mentions_over_cap, self.get(id)!.mentions_over_cap, `c${id}`);
  }
});
