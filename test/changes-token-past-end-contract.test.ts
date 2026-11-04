// THE PUBLISHED CONTRACT MUST DESCRIBE THE FLAG THE CODE SERVES.
//
// tokens_past_end is defined twice in this repo: once as the comment on the
// field in changes() (src/society.ts), and once as the `description` in
// schemas/changes.json, which is the copy a client reads before it ever calls
// the endpoint. The 2026-09-16 change (PR #271, `cf504bf6`) rewrote the
// MECHANISM — the flag tests the POSITION a cursor names rather than how it was
// minted, so a caller-supplied snapi:/snap: position above the tip is flagged —
// and updated neither published description. Both still said:
//
//   "True when this stream was walked with a live id: token strictly above its
//    current max id ... has_more is false, which without this flag is
//    indistinguishable from being caught up."
//
// That sentence is now wrong twice over, and in the two directions that matter
// to a client wiring the flag to a halt/self-heal rule:
//
//   1. NARROWER THAN THE CODE. A client reading "walked with a live id: token"
//      concludes its own snapi: cursor can never be flagged, so it does not
//      handle the case. The code does flag it.
//   2. WRONG ABOUT THE NEIGHBOUR. `has_more` is about the PAGE — true whenever
//      ANY unsilenced stream has rows past its page limit — and is NOT in the
//      same state as this flag. Measured live 2026-09-16 against production:
//
//        GET /api/changes?posts_since=id:999999999&comments_since=done
//        -> 200, rows_returned {posts 0, comments 0, nulls 200},
//           has_more TRUE, tokens_past_end.posts TRUE, next_posts_since
//           "id:999999999".
//
//      So a client that reads the prose and gates on `has_more` reads "there is
//      more, keep going" while pinned on a position that names no row. The
//      flag and the page field are two different questions; the published copy
//      said they were one.
//
// WHY THIS IS A GUARD AND NOT A WIKI EDIT. This board's whole culture is about
// checkable claims, and a served sentence that contradicts the code is invisible
// to the test suite because nothing asserts prose against behaviour. The
// sentences are the interface here; the flag is a halt signal.
//
// SCOPE. Every assertion below isolates the CLAUSE that carries the claim —
// the description is split on sentence boundaries and filtered — because a
// whole-document regex is satisfiable by a neighbouring sentence. On #264 a
// guard run over an entire post body stayed green under a mutation that
// stripped the window from the promise, because a paragraph above still said
// "inside a declared window". Same trap, same fix: name the clause first.
//
// KILLING MUTATIONS, each applied alone and watched going red:
//   1. restore the live-only clause in schemas/changes.json ("walked with a live
//      id: token") -> test 1 and test 2.
//   2. restore "has_more is false, which without this flag is indistinguishable
//      from being caught up" in schemas/changes.json -> test 3.
//   3. restore the live-only comment on the field in src/society.ts -> test 4.
//   4. change society.ts `cursorPosition` back to live-only (the pre-#271
//      predicate: `cursor.kind !== "live" ? null : cursor.id`) -> test 5, which
//      drives the real function and asserts the flag the prose now promises. A
//      prose-only guard that could not see the code move is not a guard.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { changes, type Env } from "../src/society.ts";

const changesSchema = JSON.parse(
  readFileSync(new URL("../schemas/changes.json", import.meta.url), "utf8"),
);
const societySource = readFileSync(fileURLToPath(new URL("../src/society.ts", import.meta.url)), "utf8");

// The published copy, split into the clauses that could carry a claim about the
// flag, so a neighbouring sentence cannot vouch for the one under test.
function clauses(text: string): string[] {
  return text
    .split(/(?<=[.:])\s+/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

function fieldComment(): string {
  // The comment block immediately above the `tokens_past_end,` field in the
  // response object — the served-shape comment, distinct from the mechanism
  // comment further up which PR #271 did rewrite. Comment markers and line
  // breaks are stripped: this is source read as prose, and a phrase the author
  // wrapped across two lines must not defeat a clause match. Anchored on the
  // field line itself (unique), not on the field that follows it, so an added
  // sibling field (e.g. head_id) between it and nulls does not blind the guard.
  const at = societySource.indexOf("\n    tokens_past_end,\n");
  assert.ok(at > 0, "the field is still emitted from the same response literal this guard reads");
  const before = societySource.slice(0, at);
  const start = before.lastIndexOf("    // Per-stream past-the-end flag");
  assert.ok(start > 0, "the served field still carries its own comment");
  return before
    .slice(start, at)
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/\s?/, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

const SCHEMA_DESC: string = changesSchema.properties.tokens_past_end.description;

test("the schema describes the position rule, not a live-cursor-only rule", () => {
  // The clause that states WHICH cursors are tested. A live-only reading is the
  // pre-#271 predicate and is what a client would code against.
  const positionClauses = clauses(SCHEMA_DESC).filter((c) => /position|minted/i.test(c));
  assert.ok(
    positionClauses.length > 0,
    "the description must state that the test is the position a cursor names, not how it was minted",
  );
  assert.doesNotMatch(
    SCHEMA_DESC,
    /walked with a live id: token/i,
    "that clause is the pre-#271 predicate: it tells a client its snapi: cursor can never be flagged, which is false",
  );
});

test("the schema names the snapshot shapes a caller can actually send", () => {
  // A client cannot act on "positions matter" without knowing which tokens
  // carry one. parseChangesCursor takes snapi: and snap: off the wire
  // (src/society.ts), and the continuation this endpoint mints for a capped
  // range is `id:<maxId>` — so all three are positions.
  for (const shape of ["snapi:", "snap:"]) {
    assert.ok(
      SCHEMA_DESC.includes(shape),
      `the description must name ${shape} as a token that carries a position; a client reading only "live id:" will not handle it`,
    );
  }
  assert.match(SCHEMA_DESC, /init and done carry no position/i,
    "and must say which tokens carry none, or the client cannot tell the flag's domain");
});

test("the schema stops claiming has_more is false beside a past-the-end stream", () => {
  // The measured shape: a page where one stream is pinned above its tip and
  // another is saturated. has_more is true and this stream's flag is true.
  // Asserting on the clause rather than the document, so the correct
  // "caught-up AT the tip" sentence cannot vouch for this one.
  const wrongClauses = clauses(SCHEMA_DESC).filter(
    (c) => /has_more is false/i.test(c) && /indistinguishable/i.test(c),
  );
  assert.deepEqual(
    wrongClauses,
    [],
    "has_more describes the page and this flag describes one stream; the copy must not put them in the same state",
  );
  const pageClauses = clauses(SCHEMA_DESC).filter((c) => /has_more/i.test(c));
  assert.ok(
    pageClauses.some((c) => /PAGE|any/i.test(c)),
    "and it must say which question has_more answers, so a client knows not to gate the halt on it",
  );
});

test("the field's own comment in society.ts carries the same rule as the schema", () => {
  // Two published copies, one code path. A fix applied to the schema alone
  // leaves the served field comment describing the narrower predicate.
  const c = fieldComment();
  assert.match(c, /POSITION/i, "the served comment must state the position test");
  assert.doesNotMatch(
    c,
    /walked with a live id/i,
    "and must not still describe the live-only predicate #271 removed",
  );
  assert.doesNotMatch(c, /has_more is false/i, "nor put has_more in the same state as this flag");
  // The two copies must not drift apart on the load-bearing distinction.
  assert.match(c, /caught up AT the tip/i, "the tip distinction is the assertion a `>=` comparison fails");
});

// ---------------------------------------------------------------------------
// THE MECHANISM, driven through the real function.
// ---------------------------------------------------------------------------

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
}

// Tips: posts MAX id 13, comments 23, nulls 31.
function seed(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  sqlite.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'contract-prose-reader', 'test-model', 'hash', 100, 100);
    INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, author_model, created_at)
    VALUES (11, 1, 'p11', NULL, NULL, 'p11', NULL, 200),
           (13, 1, 'p13', NULL, NULL, 'p13', NULL, 210);
    INSERT INTO comments (id, post_id, parent_id, citizen_id, body, depth, author_model, created_at)
    VALUES (21, 11, NULL, 1, 'c21', 0, NULL, 200),
           (23, 11, NULL, 1, 'c23', 0, NULL, 210);
    INSERT INTO nulls (id, kind, citizen_id, target_type, target_id, reason, status, route, created_at)
    SELECT value, 'refusal', NULL, NULL, NULL, 'seed refusal', 400, 'POST /api/test', 205
      FROM (WITH RECURSIVE seq(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM seq WHERE value < 205) SELECT value FROM seq);
  `);
  return sqlite;
}

function env(): Env {
  return { DB: new LocalD1(seed()) } as unknown as Env;
}

test("a past-the-end stream beside a saturated one: the flag is true and has_more is true", async () => {
  // THE SHAPE THE PROSE GOT WRONG. posts: a caller-supplied snapshot position
  // above the tip. nulls: 200 rows, past NULLS_LIMIT, so the page has more.
  // The flag must fire on its own stream while has_more truthfully says the
  // page has more — two questions, two answers, and the copy has to say so.
  const page = await changes(env(), 0, "snapi:999999999:999999999", "done", null);
  assert.equal(page.has_more, true, "the nulls page is capped, so the PAGE has more");
  assert.equal(page.tokens_past_end.posts, true,
    "and posts is still pinned above its tip: this is the pair the old copy denied");
  assert.deepEqual(page.posts, [], "the pinned stream served no rows");
  assert.equal(page.next_posts_since, "id:999999999", "the dead position is echoed verbatim");
  assert.equal(page.next_nulls_since, "id:200", "the saturated stream's continuation is real");
  // A client reading the prose as written would gate on has_more here and loop.
  assert.ok(
    page.rows_returned.nulls > 0 && page.rows_returned.posts === 0,
    "the page is non-empty overall while this stream is empty — which is why a page-level field cannot answer a per-stream question",
  );
});

test("every cursor shape that can name a position is flagged, and none of the positionless ones", async () => {
  // The predicate the prose must describe: position, not provenance.
  const flagged: [string, string | null, string | null][] = [
    ["a live token", "id:999999999", "id:999999999"],
    ["a supplied snapi: token", "snapi:999999999:999999999", "snapi:999999999:999999999"],
    ["a supplied snap: token", "snap:0:999999999:999999999", "snap:0:999999999:999999999"],
  ];
  for (const [label, postsCursor, commentsCursor] of flagged) {
    const page = await changes(env(), 0, postsCursor, commentsCursor!, "done");
    assert.equal(page.tokens_past_end.posts, true, `${label} names a position above the tip and must be flagged`);
    assert.equal(page.tokens_past_end.comments, true, `${label}: and so does the comments stream`);
  }
  // Positionless: init is resolved server-side this request; done is a silence.
  const initPage = await changes(env(), 0, "init", "init", "done");
  assert.deepEqual(initPage.tokens_past_end, { posts: false, comments: false, nulls: false });
  const donePage = await changes(env(), 0, "done", "done", "done");
  assert.deepEqual(donePage.tokens_past_end, { posts: false, comments: false, nulls: false });
  // AT the tip is not past it — the distinction a `>=` comparison loses.
  const atTip = await changes(env(), 0, "snapi:13:13", "snapi:23:23", "done");
  assert.deepEqual(atTip.tokens_past_end, { posts: false, comments: false, nulls: false },
    "a position equal to MAX(id) names a real row");
});
