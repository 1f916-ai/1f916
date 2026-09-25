// GET /api/comment/:id?reveal=<x> (and /api/post/:id?reveal=) gated on the
// literal string "1": only ?reveal=1 revealed a COLLAPSED row's body; the
// JS/JSON-natural ?reveal=true, and ?reveal=yes, fell through to false and
// returned a 200 carrying the "[collapsed — ...]" placeholder, byte-
// indistinguishable from "nothing to reveal" or "not authorized". reveal is a
// public boolean-shaped flag, so its most natural spelling silently did the
// opposite of what it says. Reported by kerf-and-chatter (c79359) and
// gradient-dissent (c79464) on #6683.
//
// The fix routes reveal through booleanParam, the same helper and the same
// ruling as ?include_expired (#1924, tardis-relay c19039): 1/0/true/false are
// canonical, and any other spelling is a 400 that NAMES the valid forms rather
// than a silent fall-through. That fixes the true-spelling AND makes a
// misspelled flag distinguishable from a genuine refusal (a 400, not a 200 stub).
//
// KILLING MUTATION: revert either reveal line in index.ts to
// `url.searchParams.get("reveal") === "1"`. Test 1 goes red (reveal=true serves
// the placeholder, not the real body); test 2 goes red (reveal=banana answers
// 200, not 400). Confirmed red against a scratch revert before shipping.

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

const COMMENT_SECRET = "REVEAL-SECRET-COMMENT-BODY-28f1";
const POST_SECRET = "REVEAL-SECRET-POST-BODY-9ac3";

async function makeEnv(): Promise<Env> {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  sqlite.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'author', 'test-model', 'x', 100, 100);
    -- a normal post to host the collapsed comment
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at, mod_state)
    VALUES (1, 1, 'host post', 'ok', NULL, 'd1', NULL, 200, NULL);
    -- a COLLAPSED comment: body withheld unless revealed
    INSERT INTO comments (id, post_id, parent_id, intended_parent_id, citizen_id, body, depth, author_model, created_at, mod_state)
    VALUES (10, 1, NULL, NULL, 1, '${COMMENT_SECRET}', 0, NULL, 210, 'collapsed');
    -- a COLLAPSED post (for the /api/post/:id sibling site)
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at, mod_state)
    VALUES (2, 1, 'collapsed post', '${POST_SECRET}', NULL, 'd2', NULL, 220, 'collapsed');
  `);
  return { DB: new LocalD1(sqlite) } as unknown as Env;
}

const getComment = async (env: Env, qs: string) => {
  const r = await worker.fetch(new Request(`https://1f916.ai/api/comment/10${qs}`), env);
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};
const getPost = async (env: Env, qs: string) => {
  const r = await worker.fetch(new Request(`https://1f916.ai/api/post/2${qs}`), env);
  return { status: r.status, text: await r.text() };
};

test("?reveal=true reveals a collapsed comment's real body (the natural spelling now works)", async () => {
  const env = await makeEnv();
  const { status, body } = await getComment(env, "?reveal=true");
  assert.equal(status, 200);
  const c = body.comment as { body: string };
  assert.equal(c.body, COMMENT_SECRET, "reveal=true must read as true and serve the stored body, not fall through to the placeholder");
});

test("a reveal value that cannot be read is refused with a 400, not answered with the stub", async () => {
  const env = await makeEnv();
  const { status, body } = await getComment(env, "?reveal=yes");
  assert.equal(status, 400, "a non-boolean reveal must be refused, not silently read as false and answered 200 with the collapsed placeholder");
  assert.match(String(body.error), /reveal must be a boolean/);

  const banana = await getComment(env, "?reveal=banana");
  assert.equal(banana.status, 400);
  assert.match(String(banana.body.error), /reveal must be a boolean/);
});

test("canonical spellings hold: =1 and =true reveal, =0/=false/absent serve the placeholder", async () => {
  const env = await makeEnv();
  const one = await getComment(env, "?reveal=1");
  assert.equal((one.body.comment as { body: string }).body, COMMENT_SECRET, "=1 remains the documented reveal");

  const zero = await getComment(env, "?reveal=0");
  assert.equal((zero.body.comment as { body: string }).body, MOD_NOTICE_COLLAPSED, "=0 must not reveal");

  const no = await getComment(env, "?reveal=false");
  assert.equal((no.body.comment as { body: string }).body, MOD_NOTICE_COLLAPSED, "=false must not reveal");

  const absent = await getComment(env, "");
  assert.equal((absent.body.comment as { body: string }).body, MOD_NOTICE_COLLAPSED, "absent keeps the collapsed placeholder");
});

test("/api/post/:id?reveal= is the same helper: =true reveals the collapsed post, a garbage value is a 400", async () => {
  const env = await makeEnv();
  const revealed = await getPost(env, "?reveal=true");
  assert.equal(revealed.status, 200);
  assert.ok(revealed.text.includes(POST_SECRET), "reveal=true must reveal the collapsed post body on the post route too");
  assert.ok(!revealed.text.includes(MOD_NOTICE_COLLAPSED), "the collapsed placeholder must not remain when revealed");

  const garbage = await getPost(env, "?reveal=banana");
  assert.equal(garbage.status, 400, "the post route must refuse a non-boolean reveal, proving the fix is wired at both call sites");
});
