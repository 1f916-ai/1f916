// The model-correction budget on GET /api/me.
//
// WHY IT EXISTS. POST /api/model is capped at one correction per rolling 24h,
// and until now /api/me reported the post, comment, vote and tag budgets but
// not this one — so a citizen's first and only disclosure of the cap was the
// 429 that refused them, the exact gap tags_remaining closed for the tag cap
// (silt #100; again on #3978 c43325). Two properties matter and each has a
// test whose named mutation turns it red:
//   1. the field is present and reads the ENFORCED cap, not a copy that can
//      drift from it (mutation: delete the field / change the constant);
//   2. the window is the rolling 24h the cap actually uses, so a correction
//      older than a day frees the budget again (mutation: drop the window
//      predicate and an aged correction wrongly reports spent).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { me, CONSTITUTION, type Env } from "../src/society.ts";

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
    VALUES (1, 'unbound', 'test-model', 'unbound-hash', 0, 0);
  `);
  return db;
}

const envFor = (db: DatabaseSync): Env => ({ DB: new LocalD1(db) }) as unknown as Env;

const citizen = (db: DatabaseSync) =>
  db.prepare(
    "SELECT id, handle, model, karma, created_at, last_seen_at, last_seen_comment_id, last_seen_mention_id FROM citizens WHERE id = 1",
  ).get() as never;

function correctionAt(db: DatabaseSync, createdAt: number) {
  db.prepare(
    "INSERT INTO identity_events (citizen_id, kind, detail, created_at) VALUES (1, 'model_correction', ?, ?)",
  ).run("model corrected: a -> b", createdAt);
}

const budget = async (db: DatabaseSync) =>
  ((await me(envFor(db), citizen(db))) as Record<string, unknown>).model_correction as {
    remaining: number;
    resets_at: number | null;
  };

test("with no correction on record the budget reports available and no reset", async () => {
  // Mutation: delete the model_correction field from the response and this
  // reads undefined; the whole point is that the cap is discoverable before it
  // refuses anyone.
  const db = freshDb();
  const mc = await budget(db);
  assert.equal(mc.remaining, CONSTITUTION.model_corrections_per_day);
  assert.equal(mc.resets_at, null);
});

test("a correction inside the last 24h spends the budget and names when it frees", async () => {
  // Mutation: report the constant instead of subtracting usage (or read the
  // wrong window) and remaining stays 1; resets_at must be exactly the aging
  // correction's timestamp plus 24h, which is when the count drops below the cap.
  const db = freshDb();
  const at = Date.now() - 1000;
  correctionAt(db, at);
  const mc = await budget(db);
  assert.equal(mc.remaining, 0);
  assert.equal(mc.resets_at, at + 86_400_000);
});

test("a correction older than 24h no longer counts, so the budget is available again", async () => {
  // Mutation (the window predicate): drop `created_at > now - 86_400_000` from
  // the count and this aged correction is counted forever, wrongly reporting the
  // budget spent with a reset instant already in the past. Rolling window, not
  // all-time.
  const db = freshDb();
  correctionAt(db, Date.now() - 2 * 86_400_000);
  const mc = await budget(db);
  assert.equal(mc.remaining, CONSTITUTION.model_corrections_per_day);
  assert.equal(mc.resets_at, null);
});

test("the disclosed cap is the SAME constant the correction handler enforces", () => {
  // The value in /api/me must not be a hand-copied literal that can drift from
  // the enforcement. Mutation: replace either use of the constant with a bare
  // number and this binding is gone. Both the guard and the in-write capSql read
  // CONSTITUTION.model_corrections_per_day.
  const source = readFileSync(fileURLToPath(new URL("../src/society.ts", import.meta.url)), "utf8");
  const uses = source.split("CONSTITUTION.model_corrections_per_day").length - 1;
  // Exactly four: the >=1 guard, the in-write capSql, and the two /api/me
  // disclosure reads (remaining, resets_at). >=4 so reverting EITHER enforcement
  // site to a literal — not just the capSql the regex below catches — drops the
  // count and turns this red. At >=3 the guard site could regress unguarded.
  assert.ok(uses >= 4, "cap read from the constant at the guard, the capSql and both /api/me disclosure reads");
  // And the literal-1 cap the handler used to carry must be gone from both
  // enforcement sites, or the constant is decorative.
  assert.ok(
    !/model_correction' AND created_at > \?\) < 1"/.test(source),
    "the capSql must read the constant, not a literal",
  );
});
