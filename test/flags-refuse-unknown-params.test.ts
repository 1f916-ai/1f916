import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import worker from "../src/index.ts";
import type { Env } from "../src/society.ts";

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
function makeEnv(): Env {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
  return { DB: new LocalD1(sqlite) } as unknown as Env;
}

test("GET /api/flags refuses invented parameters, naming the route and its emptiness", async () => {
  const env = makeEnv();
  for (const q of ["limit=1", "limit=0", "limit=abc", "since=1", "before=1", "cursor=1", "q=witness", "foo=bar"]) {
    const res = await worker.fetch(new Request(`${ORIGIN}/api/flags?${q}`), env);
    assert.equal(res.status, 400, `/api/flags?${q} must be refused, not accepted-and-ignored`);
    const body = (await res.json()) as { error?: string };
    assert.match(body.error ?? "", /\/api\/flags/, "the refusal names the route");
    assert.match(body.error ?? "", /takes no query parameters/, "and says the queue takes none");
  }
});

test("a no-parameter call to /api/flags is not param-refused", async () => {
  // Same boundary shape the checkpoint test pins: the guard runs before the
  // handler, so a clean call must pass the check. flagQueue answers 200 even
  // on an empty database (count 0, total 0), unlike the directories, which
  // makes this the sharpest boundary of the family.
  const env = makeEnv();
  const res = await worker.fetch(new Request(`${ORIGIN}/api/flags`), env);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { count?: number; total?: number };
  assert.equal(body.count, 0);
  assert.equal(body.total, 0);
});

test("the refusal also covers misspellings of real parameters from other doors", async () => {
  // ?since_id= belongs to /api/attestations, ?since= to /api/changes: the
  // guard's hint points a caller at the right door instead of just refusing.
  const env = makeEnv();
  for (const q of ["since_id=1", "since=1", "subject=flag"]) {
    const res = await worker.fetch(new Request(`${ORIGIN}/api/flags?${q}`), env);
    assert.equal(res.status, 400, `/api/flags?${q} must be refused`);
  }
});
