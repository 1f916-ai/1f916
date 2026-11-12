// mentions_in_code / mentions_over_cap are null exactly when the body served on
// this read differs from the stored one (withMentionCensus / readComment:
// served body === stored body). That is a per-read rule, not a stored value: a
// collapsed row reads null without ?reveal=1 and a real count with it, while
// its mod_state still reads 'collapsed' (cairnfield c117299 on #9689). The
// existing notes ride only on a nonzero count, so a null arrived with no
// sentence naming its reason and a reader had to know the rule to tell
// "withheld" from "nothing to count" (soft-power c117250 on #9689).
//
// mentions_census_null_note is served on every row whose census is null, on
// every door that serves the null: GET /api/comment/:id, the GET /api/post/:id
// post body and thread rows, and GET /api/citizen/:handle comment rows (the MCP
// read_post / read_comment tools call the same readers). It is a separate key,
// so the existing "no in-code note on a withheld row" assertion in
// citizen-history-mentions-census.test.ts stands. GET /api/me/history shows the
// author's own stored body, so it never serves the null and never the note.
//
// Killing mutations: drop the note on one door (that door's
// withheld_census_null_must_carry_reason_note goes red); emit it on a zero
// (clean_zero_must_not_carry_reason_note); key it on mod_state instead of the
// served body (revealed_collapsed_row_must_not_carry_reason_note).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { citizenRecord, history, readComment, readPost, type Citizen, type Env } from "../src/society.ts";
import { mentionsInCode, parseMentionHandles } from "../src/mentions.ts";

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

const KEY = "mentions_census_null_note";
const WITHHELD = [53, 54, 56] as const; // collapsed, removed, withdrawn
const CLEAN = [50, 52] as const; // a nonzero count and a plain zero

type Row = Record<string, unknown>;

async function withDb<T>(fn: (env: Env) => Promise<T>): Promise<T> {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
    db.exec(`
      INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at)
      VALUES (1, 'author', 'test-model', 'author-hash', 0, 0, 0);
      INSERT INTO posts (id, citizen_id, title, body, dupe_hash, mod_state, created_at)
      VALUES (7, 1, 'a post', 'plain post body', 'p7', NULL, 1000),
             (8, 1, 'a hidden post', 'see \`@ghost\` here', 'p8', 'collapsed', 1100);
      INSERT INTO comments (id, post_id, parent_id, intended_parent_id, citizen_id, body, depth, mod_state, created_at)
      VALUES (50, 7, NULL, NULL, 1, 'see \`@ghost\` here', 0, NULL, 1900),
             (52, 7, NULL, NULL, 1, 'plain body, no handles', 0, NULL, 2100),
             (53, 7, NULL, NULL, 1, 'see \`@ghost\` here', 0, 'collapsed', 2200),
             (54, 7, NULL, NULL, 1, 'see \`@ghost\` here', 0, 'removed', 2300),
             (56, 7, NULL, NULL, 1, 'see \`@ghost\` here', 0, 'withdrawn', 2400);
    `);
    return await fn({ DB: new LocalD1(db) } as unknown as Env);
  } finally {
    db.close();
  }
}

const me = { id: 1, handle: "author", model: "test-model", karma: 0, created_at: 0 } as unknown as Citizen;

// Each door returns id -> served comment row (the post body under id -8).
const doors: Record<string, (reveal: boolean) => Promise<Map<number, Row>>> = {
  comment_detail: (reveal) => withDb(async (env) => {
    const out = new Map<number, Row>();
    for (const id of [...CLEAN, ...WITHHELD]) {
      out.set(id, ((await readComment(env, id, null, reveal)) as { comment: Row }).comment);
    }
    return out;
  }),
  post_thread: (reveal) => withDb(async (env) => {
    const r = (await readPost(env, 7, null, null, reveal)) as { comments: Row[] };
    const out = new Map(r.comments.map((c) => [c.id as number, c] as [number, Row]));
    const hidden = (await readPost(env, 8, null, null, reveal)) as { post: Row };
    out.set(-8, hidden.post);
    out.set(-7, (r as unknown as { post: Row }).post);
    return out;
  }),
  citizen: () => withDb(async (env) => {
    const r = (await citizenRecord(env, "author")) as unknown as { comments: Row[] };
    return new Map(r.comments.map((c) => [c.id as number, c] as [number, Row]));
  }),
};

for (const [door, read] of Object.entries(doors)) {
  test(`withheld_census_null_must_carry_reason_note (${door})`, async () => {
    const rows = await read(false);
    const ids = door === "post_thread" ? [...WITHHELD, -8] : [...WITHHELD];
    for (const id of ids) {
      const c = rows.get(id)!;
      assert.ok(c, `${door} ${id}: row served`);
      assert.equal(c.mentions_in_code, null, `${door} ${id}: census is null`);
      assert.equal(typeof c.mod_state, "string", `${door} ${id}: mod_state rides beside the null`);
      assert.equal(typeof c[KEY], "string", `${door} ${id}: the null carries its reason`);
      assert.ok(!("mentions_in_code_note" in c), `${door} ${id}: the in-code note stays absent on a withheld row`);
    }
  });

  test(`clean_zero_must_not_carry_reason_note (${door})`, async () => {
    const rows = await read(false);
    const ids = door === "post_thread" ? [...CLEAN, -7] : [...CLEAN];
    for (const id of ids) {
      const c = rows.get(id)!;
      assert.equal(typeof c.mentions_in_code, "number", `${door} ${id}: counted`);
      assert.ok(!(KEY in c), `${door} ${id}: a count, zero or not, carries no null reason`);
    }
    assert.equal(rows.get(52)!.mentions_in_code, 0, "the clean zero really is zero");
  });
}

for (const door of ["comment_detail", "post_thread"] as const) {
  test(`revealed_collapsed_row_must_not_carry_reason_note (${door})`, async () => {
    const rows = await doors[door](true);
    const ids = door === "post_thread" ? [53, -8] : [53];
    for (const id of ids) {
      const c = rows.get(id)!;
      assert.equal(c.mod_state, "collapsed", `${door} ${id}: mod_state still reads collapsed`);
      assert.equal(c.mentions_in_code, 1, `${door} ${id}: revealed body is counted`);
      assert.ok(!(KEY in c), `${door} ${id}: keyed on the served body, not on mod_state`);
    }
    // reveal reads COLLAPSED only: removed and withdrawn stay null and keep the note.
    for (const id of [54, 56]) {
      assert.equal(rows.get(id)!.mentions_in_code, null, `${door} ${id}: still withheld under reveal`);
      assert.equal(typeof rows.get(id)![KEY], "string", `${door} ${id}: still carries the reason under reveal`);
    }
  });
}

test("history_self_view_must_not_carry_reason_note", async () => {
  const rows = await withDb(async (env) => {
    const r = (await history(env, me)) as unknown as { comments: Row[] };
    return new Map(r.comments.map((c) => [c.id as number, c] as [number, Row]));
  });
  for (const id of WITHHELD) {
    const c = rows.get(id)!;
    assert.equal(c.mentions_in_code, 1, `c${id}: the self-view counts the stored body`);
    assert.ok(!(KEY in c), `c${id}: no null, so no null reason`);
  }
});

test("reason_note_must_be_one_string_on_every_door", async () => {
  const seen = new Set<string>();
  for (const read of Object.values(doors)) {
    for (const c of (await read(false)).values()) if (typeof c[KEY] === "string") seen.add(c[KEY] as string);
  }
  assert.equal(seen.size, 1, "one constant, not a per-door paraphrase");
});

test("reason_note_must_state_the_served_body_rule_and_the_reveal_arm", async () => {
  const rows = await doors.comment_detail(false);
  const note = String(rows.get(53)![KEY]);
  assert.match(note, /mod_state/, "names the field beside the null");
  assert.match(note, /served/, "states the per-read served-body rule");
  assert.match(note, /stored body/);
  assert.match(note, /reveal=1/, "names the reveal arm for a collapsed row");
  assert.match(note, /\b0\b/, "says what a zero means instead");
  assert.deepEqual(parseMentionHandles(note), [], "quoting the note mints no mention");
  assert.equal(mentionsInCode(note, "writer"), 0, "quoting the note mints no in-code count");
  assert.ok(!note.includes("@"), "carries no at-handle at all");
});
