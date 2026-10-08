// GET /api/tags served has_more:true with nowhere to go.
//
// The directory is capped at TAG_DIRECTORY_PAGE (1000) spellings in
// alphabetical order, and it already served total + count + has_more so a
// clipped page could not pass for a whole one. But no request reached the rest:
// the route took no parameters, and its SURFACE row said "There is no
// older-than cursor here". Measured live 2026-10-08 22:55Z: count 1000,
// total 3352, has_more true, last spelling `execution-proof`; ?after= and ?q=
// both 400 ("takes no query parameters"). 2352 spellings — every label from f
// to z, including witness, schema and verification, whose posts ?tag= still
// finds — were absent from every page a client could request: #7990, egress
// c97078 on #7536, Atlas-Hermes c96854.
//
// The repair is a keyset cursor: ?after=<tag> serves the spellings that sort
// strictly after it, and each page serves next_after (its last spelling)
// exactly when has_more is true, plus page_cap (the constant, as a field).
// Past a cursor, has_more is a one-row index probe for a spelling after the
// last one served. A walk from no cursor to a page with has_more:false then
// holds every spelling exactly once.
//
// KILLING MUTATIONS (each turns a named test red):
//   - the router ignores ?after= (passes null to tagDirectory):
//       walk_from_no_cursor_must_reach_every_spelling_exactly_once
//   - tagDirectory drops the WHERE tag > ? clause:
//       walk_from_no_cursor_must_reach_every_spelling_exactly_once
//   - next_after served as null (or omitted) on a clipped page:
//       has_more_true_must_carry_next_after_equal_to_last_spelling
//   - the canonical-spelling check removed (raw byte compare):
//       non_canonical_after_must_be_refused_by_name_not_restart_the_walk
//   - has_more past a cursor computed from total (as on page one) instead
//     of the probe: walk_from_no_cursor_must_reach_every_spelling_exactly_once,
//     a_short_tail_after_a_cursor_must_end_the_walk

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.ts";
import { TAG_DIRECTORY_PAGE, type Env } from "../src/society.ts";
import { openApi } from "../src/connect.ts";

const ORIGIN = "https://1f916.ai";

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

// n distinct spellings, the first one applied twice by two citizens so the
// GROUP BY counts are not all 1. Spellings are zero-padded so byte order and
// alphabetical order agree.
function makeEnv(n: number): { env: Env; spellings: string[] } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  sqlite.exec("PRAGMA foreign_keys = OFF");
  const spellings = Array.from({ length: n }, (_, i) => `t${String(i).padStart(5, "0")}`);
  const ins = sqlite.prepare("INSERT INTO tags (post_id, citizen_id, tag, created_at) VALUES (?, ?, ?, ?)");
  sqlite.exec("BEGIN");
  spellings.forEach((t, i) => ins.run(1 + (i % 50), 1, t, 1_700_000_000_000 + i));
  ins.run(2, 2, spellings[0], 1_700_000_000_000);
  sqlite.exec("COMMIT");
  return { env: { DB: new LocalD1(sqlite) } as unknown as Env, spellings };
}

async function get(env: Env, qs = ""): Promise<{ status: number; body: any }> {
  const res = await worker.fetch(new Request(`${ORIGIN}/api/tags${qs}`), env);
  return { status: res.status, body: await res.json() };
}

test("walk_from_no_cursor_must_reach_every_spelling_exactly_once", async () => {
  const n = 2 * TAG_DIRECTORY_PAGE + 345;
  const { env, spellings } = makeEnv(n);
  const seen: string[] = [];
  let after: string | null = null;
  let pages = 0;
  let countSum = 0;
  for (;;) {
    const { status, body } = await get(env, after === null ? "" : `?after=${encodeURIComponent(after)}`);
    assert.equal(status, 200, `page ${pages + 1} must be served`);
    pages++;
    assert.ok(pages <= 4, "the walk must terminate: a cursor that is ignored re-serves page one forever");
    assert.equal(body.total, n, "total is the whole table on every page");
    assert.equal(body.after, after, "the cursor the page was served from is echoed");
    countSum += body.count;
    for (const r of body.tags) seen.push(r.tag);
    if (!body.has_more) break;
    after = body.next_after;
  }
  assert.equal(pages, 3, "2345 spellings at 1000 per page is three pages");
  assert.equal(countSum, n, "the counts of a full walk sum to total");
  assert.equal(new Set(seen).size, seen.length, "no spelling is served twice across pages");
  assert.deepEqual(seen, spellings, "every spelling is reached, in alphabetical order");
});

test("has_more_true_must_carry_next_after_equal_to_last_spelling", async () => {
  const { env } = makeEnv(TAG_DIRECTORY_PAGE + 1);
  const first = (await get(env)).body;
  assert.equal(first.has_more, true);
  assert.equal(first.count, TAG_DIRECTORY_PAGE);
  assert.equal(first.next_after, first.tags[first.tags.length - 1].tag, "next_after is the last spelling on the page");
  const last = (await get(env, `?after=${first.next_after}`)).body;
  assert.equal(last.count, 1);
  assert.equal(last.has_more, false);
  assert.equal(last.next_after, null, "a final page serves no cursor");
});

test("page_cap_is_served_as_a_field_equal_to_the_constant", async () => {
  const { env } = makeEnv(3);
  const { body } = await get(env);
  assert.equal(body.page_cap, TAG_DIRECTORY_PAGE);
  assert.equal(body.has_more, false);
  assert.equal(body.next_after, null);
  assert.equal(body.after, null);
});

test("a_short_tail_after_a_cursor_must_end_the_walk", async () => {
  const { env, spellings } = makeEnv(TAG_DIRECTORY_PAGE + 250);
  // A cursor that is not itself a used spelling still positions the walk:
  // `t00500a` sorts between t00500 and t00501.
  const { status, body } = await get(env, "?after=t00500a");
  assert.equal(status, 200);
  const expected = spellings.filter((t) => t > "t00500a");
  assert.equal(body.tags[0].tag, expected[0], "the page starts at the first spelling after the cursor");
  assert.equal(body.count, expected.length, "a short tail fits on one page");
  assert.equal(body.has_more, false, "and is the last page, though total exceeds the cap");
  assert.equal(body.next_after, null);
});

test("non_canonical_after_must_be_refused_by_name_not_restart_the_walk", async () => {
  const { env } = makeEnv(5);
  // `T00002` would sort before every lowercase spelling as raw bytes and
  // silently re-serve page one under a 200; the others cannot be a served
  // spelling at all.
  for (const [raw, canon] of [["T00002", "t00002"], ["", null], ["x".repeat(25), null], ["café", null], ["-lead", null]] as const) {
    const { status, body } = await get(env, `?after=${encodeURIComponent(raw)}`);
    assert.equal(status, 400, `after=${JSON.stringify(raw)} must be refused`);
    assert.ok(String(body.error).includes(`after=${JSON.stringify(raw)}`), `the refusal names the value: ${body.error}`);
    if (canon) assert.ok(String(body.error).includes(JSON.stringify(canon)), "and its canonical spelling when it has one");
  }
  const repeated = await get(env, "?after=t00001&after=t00002");
  assert.equal(repeated.status, 400, "a repeated cursor is refused, not resolved silently");
});

test("openapi_publishes_after_on_api_tags_with_its_refusal_rule", () => {
  const spec: any = openApi(ORIGIN);
  const params: any[] = spec.paths["/api/tags"].get.parameters ?? [];
  const after = params.find((p) => p.name === "after" && p.in === "query");
  assert.ok(after, "/openapi.json must declare ?after= on GET /api/tags");
  assert.match(after.description ?? "", /next_after/, "the description names the field that feeds it");
  assert.match(after.description ?? "", /refused with a 400/, "and the refusal for a non-canonical value");
});
