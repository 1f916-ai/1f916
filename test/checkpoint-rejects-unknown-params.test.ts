// GET /api/checkpoint must refuse a query parameter it does not read, the way
// /api/docket and its own /consistency sibling already do.
//
// The defect (egress c63428 on #5507, measured live 2026-09-16): three calls
//   /api/checkpoint, ?log=nonsense, ?log=ledger
// returned bodies identical but for the `now` tick. `log` is a real parameter
// one path-segment over (/api/checkpoint/consistency reads it), so a reader who
// wrote /api/checkpoint?log=ledger expecting a filtered head got a confident
// 200 whose body still carried the moving identity_events row beside the frozen
// ledger row — the accepted-but-ignored / no-400 family. The head takes no
// parameters; it must say so.
//
// KILLING MUTATION: delete the `checkQueryParams(url, "/api/checkpoint")` line
// from the GET handler in src/index.ts. The two 400 cases below go green->…no:
// the request then returns 200 with the head, so `res.status === 400` fails —
// the test goes red. Watched red on a scratch copy before shipping.

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

test("GET /api/checkpoint refuses ?log= (a real param on the consistency sibling), naming the route", async () => {
  const env = makeEnv();
  for (const q of ["log=ledger", "log=nonsense", "zqxjklmn=1"]) {
    const res = await worker.fetch(new Request(`${ORIGIN}/api/checkpoint?${q}`), env);
    assert.equal(res.status, 400, `/api/checkpoint?${q} must be refused, not accepted-and-ignored`);
    const body = (await res.json()) as { error?: string };
    assert.match(body.error ?? "", /\/api\/checkpoint/, "the refusal names the route");
    assert.match(body.error ?? "", /takes no query parameters/, "and says the head takes none");
  }
});

test("GET /api/checkpoint with no parameters is not refused by the guard", async () => {
  // The guard runs before latestCheckpoints, so this asserts its boundary, not
  // the head itself: a no-parameter call must pass through the param check. On
  // this empty in-memory DB the head then 503s (no registry seed / no
  // checkpoints), which is exactly what proves checkQueryParams let it through
  // rather than short-circuiting it with a 400. What must never happen is a
  // no-parameter call being refused for a parameter.
  const env = makeEnv();
  const res = await worker.fetch(new Request(`${ORIGIN}/api/checkpoint`), env);
  assert.notEqual(res.status, 400, "a call with no parameters must not be param-refused");
  const body = (await res.json()) as { error?: string };
  assert.doesNotMatch(body.error ?? "", /takes no query parameters/, "the no-parameter path is not the param refusal");
});
