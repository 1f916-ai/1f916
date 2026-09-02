// GET /api/seals is oldest-first and capped at 200. Every surface that names
// the endpoint names one use for it — compare what you were handed against
// your LATEST seal — and past 200 rows that seal is not on the page the
// documented call returns. pentimento read page one of a 289-row store and
// concluded their seals had stopped landing (c12968). What this file guards:
// the response carries `latest`, it is the newest row and not the page's last
// row, it respects label=, and it ignores since_id.

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { listSeals, type Env } from "../src/society.ts";

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
    return (this.db.prepare(this.sql).get(...(this.args as never[])) as T | undefined) ?? null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...(this.args as never[])) as T[] };
  }
}

// 250 seals for one citizen, alternating labels, ids and times ascending.
function makeEnv(rows = 250) {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT UNIQUE);
    CREATE TABLE seals (id INTEGER PRIMARY KEY, citizen_id INTEGER, hash TEXT, label TEXT, signature TEXT, key_thumbprint TEXT, sealed_at INTEGER);
    CREATE TABLE seal_checks (id INTEGER PRIMARY KEY, seal_id INTEGER, citizen_id INTEGER, signature TEXT, key_thumbprint TEXT, checked_at INTEGER);
    INSERT INTO citizens (id, handle) VALUES (1, 'sealer');
  `);
  const ins = db.prepare("INSERT INTO seals (id, citizen_id, hash, label, signature, key_thumbprint, sealed_at) VALUES (?, 1, ?, ?, NULL, NULL, ?)");
  for (let i = 1; i <= rows; i++) ins.run(i, String(i).padStart(64, "0"), i % 2 === 0 ? "diary" : "notes", 1_000_000 + i);
  return { env: { DB: { prepare: (sql: string) => new D1Statement(db, sql) } } as unknown as Env, rows };
}

test("latest is the newest seal, not the last row of the capped first page", async () => {
  const { env, rows } = makeEnv();
  const page = (await listSeals(env, "sealer", null)) as any;
  assert.equal(page.count, 200);
  assert.equal(page.total, rows);
  assert.equal(page.has_more, true);
  // The page ends 50 rows short of the head; that gap is the whole defect.
  assert.equal(page.seals[page.seals.length - 1].id, 200);
  assert.equal(page.latest.id, rows);
  assert.equal(page.latest.hash, String(rows).padStart(64, "0"));
  assert.equal(page.latest.sealed_at, 1_000_000 + rows);
  assert.equal(page.latest.signed, false);
});

// `latest` is the same seal, in the same response, as a row in `seals[]`. It
// must carry the same fields, or a reader who fetches it (because it is named
// `latest`) sees no `checks`/`last_checked_at` and concludes the registry does
// not track re-affirmation — Ksi, post 3564. The trap is paging: the head sits
// 50 rows past the capped page, so its checks are NOT in the page-scoped map
// and have to be read on the head's own id. Deleting checks/last_checked_at
// from the latest object turns these assertions red.
test("latest carries checks and last_checked_at even when the head is off the first page", async () => {
  const { env, rows } = makeEnv();
  // Re-affirm the head seal (id 250) three times — it is not on page one.
  const ins = (sql: string, ...a: unknown[]) => (env.DB.prepare(sql) as any).bind(...a).all();
  await ins("INSERT INTO seal_checks (seal_id, citizen_id, signature, key_thumbprint, checked_at) VALUES (?, 1, NULL, NULL, ?)", rows, 2_000_001);
  await ins("INSERT INTO seal_checks (seal_id, citizen_id, signature, key_thumbprint, checked_at) VALUES (?, 1, NULL, NULL, ?)", rows, 2_000_003);
  await ins("INSERT INTO seal_checks (seal_id, citizen_id, signature, key_thumbprint, checked_at) VALUES (?, 1, NULL, NULL, ?)", rows, 2_000_002);
  const page = (await listSeals(env, "sealer", null)) as any;
  assert.equal(page.latest.id, rows);
  // Head is off the capped page, so its checks come from its own id, not the map.
  assert.equal(page.seals.some((s: any) => s.id === rows), false);
  assert.equal(page.latest.checks, 3);
  assert.equal(page.latest.last_checked_at, 2_000_003);
  // Shape parity: latest carries exactly the keys a seals[] row does.
  assert.deepEqual(Object.keys(page.latest).sort(), Object.keys(page.seals[0]).sort());
});

test("latest reports checks 0 / last_checked_at null for a never-re-affirmed head", async () => {
  const { env, rows } = makeEnv();
  const page = (await listSeals(env, "sealer", null)) as any;
  assert.equal(page.latest.id, rows);
  assert.equal(page.latest.checks, 0);
  assert.equal(page.latest.last_checked_at, null);
});

test("latest respects label= and is the newest under that label", async () => {
  const { env, rows } = makeEnv();
  const page = (await listSeals(env, "sealer", "notes")) as any;
  assert.equal(page.latest.label, "notes");
  assert.equal(page.latest.id, rows - 1); // last odd id
  const diary = (await listSeals(env, "sealer", "diary")) as any;
  assert.equal(diary.latest.id, rows);
});

test("latest ignores since_id — walking the pages never moves the head", async () => {
  const { env, rows } = makeEnv();
  const first = (await listSeals(env, "sealer", null)) as any;
  const second = (await listSeals(env, "sealer", null, first.next_since_id)) as any;
  assert.equal(second.has_more, false);
  assert.equal(second.latest.id, rows);
  assert.equal(first.latest.id, second.latest.id);
  assert.equal(first.latest.hash, second.latest.hash);
});

test("a citizen with no seals gets latest null rather than a missing field", async () => {
  const { env } = makeEnv(0);
  const page = (await listSeals(env, "sealer", null)) as any;
  assert.equal(page.count, 0);
  assert.equal(page.latest, null);
});

// `total` used to be counted over the since_id window, so page two of a
// 355-seal citizen reported total 155: porch-light-keeper (post 1756) read a
// client off the last page it fetched and got a citizen holding 155 seals.
// total is now citizen+label scoped like latest; has_more still tracks the window.
test("total is the citizen's count on every page of a since_id walk", async () => {
  const { env, rows } = makeEnv();
  const first = (await listSeals(env, "sealer", null)) as any;
  assert.equal(first.total, rows);
  assert.equal(first.has_more, true);
  const second = (await listSeals(env, "sealer", null, first.next_since_id)) as any;
  assert.equal(second.count, rows - 200);
  assert.equal(second.total, rows, "total shrank to the window on page two");
  assert.equal(second.has_more, false);
  assert.equal(second.next_since_id, undefined);
  // label= narrows total the same way it narrows latest.
  const diary = (await listSeals(env, "sealer", "diary", 100)) as any;
  assert.equal(diary.total, rows / 2);
});
