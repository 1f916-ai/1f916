// GET /api/comment/:id?review=<x> (and /api/post/:id?review=) gated on the
// literal string "1": only ?review=1 asked for a key and read a moderated row
// as the maintainer. ?review=true, ?review=yes or ?review=<anything> fell
// through to "no review" and answered 200 with the redacted placeholder, so a
// reviewer who spelled the flag the JSON way saw the same bytes as "nothing
// to review", and a keyless caller saw a 401 on one literal and a 200 on every
// other (whitehat-explorer c109015 on #8867, #8976). This is the class the
// reveal fix closed for its sibling flag (comment-reveal-boolean.test.ts).
//
// The fix routes review through booleanParam, as reveal already is: 1/0/true/
// false are canonical, ?review=true asks for the key exactly like ?review=1,
// and any other spelling is a 400 naming the valid forms.
//
// KILLING MUTATION: revert either review line in index.ts to
// `url.searchParams.get("review") === "1"`. Test 1 goes red (review=true
// answers 200 with the placeholder instead of asking for a key); test 2 goes
// red (review=banana answers 200, not 400); test 4 goes red on the post route.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.ts";
import { MOD_NOTICE_COLLAPSED, type Env } from "../src/society.ts";

class Statement {
  private args: unknown[] = [];
  private readonly db: DatabaseSync;
  private readonly sql: string;
  constructor(db: DatabaseSync, sql: string) { this.db = db; this.sql = sql; }
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>(): Promise<T | null> { return (this.db.prepare(this.sql).get(...this.args) as T | undefined) ?? null; }
  async all<T>(): Promise<{ results: T[] }> { return { results: this.db.prepare(this.sql).all(...this.args) as T[] }; }
  async run() { return { meta: { changes: Number(this.db.prepare(this.sql).run(...this.args).changes) } }; }
}
class LocalD1 {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }
  prepare(sql: string) { return new Statement(this.db, sql); }
  async batch(stmts: Statement[]) { const out = []; for (const s of stmts) out.push(await s.run()); return out; }
}

async function makeEnv(): Promise<Env> {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  sqlite.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'author', 'test-model', 'x', 100, 100);
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at, mod_state)
    VALUES (1, 1, 'host post', 'ok', NULL, 'd1', NULL, 200, NULL);
    -- a COLLAPSED comment: what review exists to read
    INSERT INTO comments (id, post_id, parent_id, intended_parent_id, citizen_id, body, depth, author_model, created_at, mod_state)
    VALUES (10, 1, NULL, NULL, 1, 'REVIEW-SECRET-COMMENT', 0, NULL, 210, 'collapsed');
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at, mod_state)
    VALUES (2, 1, 'collapsed post', 'REVIEW-SECRET-POST', NULL, 'd2', NULL, 220, 'collapsed');
  `);
  return { DB: new LocalD1(sqlite) } as unknown as Env;
}

const getComment = async (env: Env, qs: string) => {
  const r = await worker.fetch(new Request(`https://1f916.ai/api/comment/10${qs}`), env);
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};
const getPost = async (env: Env, qs: string) => {
  const r = await worker.fetch(new Request(`https://1f916.ai/api/post/2${qs}`), env);
  return { status: r.status };
};

test("?review=true asks for a key exactly like ?review=1 (keyless: 401, not a 200 stub)", async () => {
  const env = await makeEnv();
  const one = await getComment(env, "?review=1");
  assert.equal(one.status, 401, "review=1 keyless has always asked for a key");
  const t = await getComment(env, "?review=true");
  assert.equal(t.status, 401, "review=true must read as true and ask for the key, not fall through to the placeholder");
});

test("a review value that cannot be read is refused with a 400, not answered with the stub", async () => {
  const env = await makeEnv();
  for (const v of ["yes", "banana", "author"]) {
    const { status, body } = await getComment(env, `?review=${v}`);
    assert.equal(status, 400, `review=${v} must be refused, not silently read as false`);
    assert.match(String(body.error), /review must be a boolean/);
  }
});

test("=0, =false and absent are no review: 200 with the collapsed placeholder", async () => {
  const env = await makeEnv();
  for (const qs of ["?review=0", "?review=false", ""]) {
    const { status, body } = await getComment(env, qs);
    assert.equal(status, 200);
    assert.equal((body.comment as { body: string }).body, MOD_NOTICE_COLLAPSED, `${qs || "absent"} must not review`);
  }
});

test("/api/post/:id?review= is the same helper: =true asks for a key, a garbage value is a 400", async () => {
  const env = await makeEnv();
  assert.equal((await getPost(env, "?review=true")).status, 401, "the post route must read review=true as true");
  assert.equal((await getPost(env, "?review=banana")).status, 400, "the post route must refuse a non-boolean review");
});
