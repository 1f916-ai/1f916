// A rejected concurrent revocation must not leave a witnessed event for an
// operation that changed no state. Run the real statements sequentially in a
// transaction, as D1 does; a batch stub that only reports success misses this.

import test from "node:test";
import assert from "node:assert/strict";
import { revokeKey, SocietyError } from "../src/society.ts";
import { SqliteD1Statement, sqliteTestEnv } from "./helpers/sqlite-d1.ts";

function makeEnv() {
  return sqliteTestEnv(`
    CREATE TABLE keys (
      id INTEGER PRIMARY KEY, citizen_id INTEGER NOT NULL, public_key TEXT NOT NULL,
      thumbprint TEXT NOT NULL UNIQUE, status TEXT NOT NULL, ended_at INTEGER
    );
    CREATE TABLE identity_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, kind TEXT, detail TEXT,
      subject_thumbprint TEXT, proof_mode TEXT, created_at INTEGER, prev_hash TEXT, hash TEXT UNIQUE
    );
  `);
}

const citizen = { id: 7, handle: "race-witness", model: "test", karma: 0, created_at: 1, last_seen_at: 1 };

test("a losing concurrent key revocation appends no phantom identity event", async () => {
  const { env, db } = makeEnv();
  const thumbprint = "t".repeat(43);
  db.prepare("INSERT INTO keys (id, citizen_id, public_key, thumbprint, status) VALUES (3, 7, 'unused', ?, 'active')").run(thumbprint);

  // Hold both initial SELECTs until both requests have observed the key active.
  const originalPrepare = (env.DB as never as { prepare(sql: string): SqliteD1Statement }).prepare.bind(env.DB);
  let reads = 0;
  let release!: () => void;
  const bothRead = new Promise<void>((resolve) => { release = resolve; });
  (env.DB as never as { prepare(sql: string): SqliteD1Statement }).prepare = (sql: string) => {
    const stmt = originalPrepare(sql);
    if (!sql.startsWith("SELECT id, public_key, status FROM keys")) return stmt;
    const first = stmt.first.bind(stmt);
    stmt.first = async <T>() => {
      const row = await first<T>();
      reads++;
      if (reads === 2) release();
      await bothRead;
      return row;
    };
    return stmt;
  };

  const settled = await Promise.allSettled([
    revokeKey(env, citizen, { thumbprint }),
    revokeKey(env, citizen, { thumbprint }),
  ]);
  assert.equal(settled.filter((r) => r.status === "fulfilled").length, 1);
  const rejected = settled.find((r) => r.status === "rejected") as PromiseRejectedResult;
  assert.ok(rejected.reason instanceof SocietyError);
  assert.equal(rejected.reason.status, 409);

  const key = db.prepare("SELECT status FROM keys WHERE id = 3").get() as { status: string };
  assert.equal(key.status, "revoked");
  const events = db.prepare("SELECT id, detail FROM identity_events WHERE citizen_id = 7 AND kind = 'key-revoke'").all();
  assert.equal(events.length, 1, "only the revocation that changed state may enter the witnessed identity log");
});
