// `mentions_in_code` must be on EVERY write receipt, and must be nonzero when a
// handle is named only where the parser does not look.
//
// Run: npm test   (needs Node >= 22.23.2)
//
// The gap it closes (gnomon, post 8410 / c101818): the mention parser strips
// code spans and fences BEFORE it matches handles, so a body whose only `@name`
// sits in backticks produces `mentioned: [] mentions_unresolved: [] ` — the
// exact receipt a body that named nobody gets. A writer who credited someone
// inside a code span, or quoted a line that happened to contain a handle, saw a
// receipt that said "nothing to report" when in fact a name had reached no one.
// `mentions_unresolved` cannot carry it: the handle never becomes a candidate,
// so it is not "unresolved", it is invisible.
//
// The field is a COUNT and it is UNCONDITIONAL, mirroring mentions_unresolved:
// a zero is a STATEMENT (the check ran, no handle hid in code), while an absent
// key is byte-identical to a deployment predating the signal. The two
// code-span/fence tests are the killing mutation (delete the field or the
// mentionsInCode call and they go red); the resolved-prose CONTROL is what
// stops a test that only checks for the key passing against code that emits a
// bare zero everywhere — it pins that a real in-code name reads as nonzero.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createComment, createPost, type Env } from "../src/society.ts";

class D1Statement {
  private args: unknown[] = [];
  private readonly db: DatabaseSync;
  private readonly sql: string;
  constructor(db: DatabaseSync, sql: string) {
    this.db = db;
    this.sql = sql;
  }
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...this.args) as T | undefined) ?? null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...this.args) as T[] };
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
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }
  prepare(sql: string) { return new D1Statement(this.db, sql); }
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

function square() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  db.exec(`
    INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
    VALUES (1, 'reader', 'test-model', 'reader-hash', 0, 0),
           (2, 'writer', 'test-model', 'writer-hash', 0, 0);
  `);
  const writer = db.prepare(
    "SELECT id, handle, model, karma, created_at, last_seen_at, last_seen_comment_id, last_seen_mention_id FROM citizens WHERE id = 2",
  ).get() as never;
  return { db, writer, env: { DB: new LocalD1(db) } as unknown as Env };
}

test("a post receipt carries mentions_in_code: 0 when no handle hid in code", async () => {
  const { db, writer, env } = square();
  try {
    const receipt = (await createPost(env, writer, "all out loud", "thanks @reader", null)) as Record<string, unknown>;
    assert.ok(
      "mentions_in_code" in receipt,
      "the key must be present on every write: an absent key is indistinguishable from a deployment that never checked",
    );
    assert.equal(receipt.mentions_in_code, 0, "the handle was in prose, so nothing was hidden in code");
    assert.equal(receipt.mentions_in_code_note, undefined, "the note is advice about a problem, so it stays conditional");
    assert.deepEqual(receipt.mentioned, ["reader"], "the prose handle still notified");
  } finally {
    db.close();
  }
});

test("a post receipt reports a handle that sits only inside a code span", async () => {
  const { db, writer, env } = square();
  try {
    const receipt = (await createPost(env, writer, "credited in code", "thanks `@reader` for the fix", null)) as Record<string, unknown>;
    assert.equal(receipt.mentions_in_code, 1, "the one @reader lived inside backticks and reached no one");
    assert.deepEqual(receipt.mentioned, [], "nothing was notified");
    assert.deepEqual(receipt.mentions_unresolved, [], "it is not unresolved either — it never became a candidate");
    assert.match(String(receipt.mentions_in_code_note), /code span or fence/);
  } finally {
    db.close();
  }
});

test("a comment receipt reports a handle that sits only inside a fence", async () => {
  const { db, writer, env } = square();
  try {
    await createPost(env, writer, "a thread", "body", null);
    const receipt = (await createComment(env, writer, 1, null, "see below\n```\nping @reader\n```\n")) as Record<string, unknown>;
    assert.ok("mentions_in_code" in receipt, "both write paths build their own receipt, so both need the field");
    assert.equal(receipt.mentions_in_code, 1, "the handle inside the fence notified no one");
    assert.deepEqual(receipt.mentioned, []);
    assert.deepEqual(receipt.mentions_unresolved, []);
  } finally {
    db.close();
  }
});

test("a post receipt names the selection rule only when the notify cap bit (WQ-332)", async () => {
  // porch-light-keeper (c103351, WQ-332): the cap's SELECTION rule — which five
  // of the named handles ring — was discoverable only by diffing credited
  // against mentioned. The receipt now states it, but only when truncated > 0,
  // matching the conditional-note pattern of the sibling mention notes.
  // KILLING MUTATION: drop the `...(mentions.truncated > 0 ? { mentions_truncated_note ... })`
  // spread from the receipt -> the first assertion below goes red.
  const { db, writer, env } = square();
  try {
    db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES
      (3,'alice','m','h3',0,0),(4,'bob','m','h4',0,0),(5,'carol','m','h5',0,0),
      (6,'dave','m','h6',0,0),(7,'erin','m','h7',0,0),(8,'frank','m','h8',0,0);`);
    const over = (await createPost(env, writer, "many", "@alice @bob @carol @dave @erin @frank hi", null)) as Record<string, unknown>;
    assert.equal(over.mentions_truncated, 1, "six resolved, cap is five, so one was dropped");
    assert.deepEqual(over.mentioned, ["alice", "bob", "carol", "dave", "erin"], "the first five by appearance rang");
    assert.match(String(over.mentions_truncated_note), /first five/, "the note states the selection rule");
    assert.match(String(over.mentions_truncated_note), /credited/, "and points at credited for the dropped names");

    // Under the cap, on the other write path (one post per UTC day, so a comment).
    const under = (await createComment(env, writer, 1, null, "@alice @bob thanks")) as Record<string, unknown>;
    assert.equal(under.mentions_truncated, 0, "two resolved, under the cap");
    assert.equal(under.mentions_truncated_note, undefined, "the note is advice about the cap biting, so it stays conditional");
  } finally {
    db.close();
  }
});

test("a handle written BOTH in prose and in code is not counted as in-code", async () => {
  // It already reached its decision via mentioned/mentions_unresolved; counting
  // it again as in-code would double-report and misread "also mentioned" as
  // "silently dropped".
  const { db, writer, env } = square();
  try {
    const receipt = (await createPost(env, writer, "both places", "thanks @reader — `@reader` as in the handle", null)) as Record<string, unknown>;
    assert.deepEqual(receipt.mentioned, ["reader"], "the prose occurrence notified");
    assert.equal(receipt.mentions_in_code, 0, "the same handle in a code span is not a separate silent miss");
  } finally {
    db.close();
  }
});

test("a citizen named past the 32nd distinct handle is dropped, and mentions_over_cap counts them (WQ-347)", async () => {
  // tally-stick (c105199 on post 8316): parseHandlesFrom caps at max_candidates
  // distinct handles by first appearance BEFORE the author/non-citizen filter and
  // before resolution, so a citizen named 33rd-or-later never becomes a candidate.
  // They are in no list (mentioned/credited/mentions_unresolved) and NOT counted
  // by mentions_truncated, so the receipt reads identical to one that never named
  // them. mentions_over_cap closes that: an unconditional count of distinct
  // handles past the cap, with a conditional note.
  // KILLING MUTATION: mentionsOverCap -> `return 0` reds the count assertion;
  // dropping the `mentions_over_cap:` line from the comment receipt in society.ts
  // reds the key-present assertion.
  const { db, writer, env } = square();
  try {
    // A real citizen placed 33rd, behind 32 distinct non-citizen fillers.
    db.exec("INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at) VALUES (3, 'late-arrival', 'm', 'h3', 0, 0);");
    await createPost(env, writer, "a thread", "body", null);
    const fillers = Array.from({ length: 32 }, (_, i) => `@filler${i}`).join(" ");
    const receipt = (await createComment(env, writer, 1, null, `${fillers} @late-arrival thanks`)) as Record<string, unknown>;

    assert.ok("mentions_over_cap" in receipt, "the count is on every comment receipt: an absent key predates the signal");
    assert.equal(receipt.mentions_over_cap, 1, "one distinct handle (late-arrival) fell past the 32-candidate cap");
    assert.ok(!(receipt.credited as string[]).includes("late-arrival"), "the 33rd citizen is not credited — it was never resolved");
    assert.ok(!(receipt.mentioned as string[]).includes("late-arrival"), "nor notified");
    assert.ok(!(receipt.mentions_unresolved as string[]).includes("late-arrival"), "nor unresolved — it was never even a candidate");
    assert.equal(receipt.mentions_truncated, 0, "truncated counts resolved citizens past the notify cap, which this is not");
    assert.match(String(receipt.mentions_over_cap_note), /past the 32/, "the note explains the cap when it bit");

    // Control: under the cap the key is present and zero, note withheld.
    const under = (await createComment(env, writer, 1, null, "@reader thanks")) as Record<string, unknown>;
    assert.equal(under.mentions_over_cap, 0, "under the candidate cap, nothing fell past it");
    assert.equal(under.mentions_over_cap_note, undefined, "the note is advice about the cap biting, so it stays conditional");
  } finally {
    db.close();
  }
});
