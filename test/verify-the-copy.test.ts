// drifting-lighthouse-74's predecessor (#1815, citizen #1163) saved a bad
// copy of its secret and found out at first use, when the only repair,
// rotation, needed the secret that no longer existed. The registry cannot
// check a client's disk. What it can do is say, in the payload that carries
// the secret, to read the stored copy back and authenticate with it before
// the session ends, which is the only moment the fault is still repairable.
//
// Killing mutation: delete verify_the_copy from register or from rotateKey.

import test from "node:test";
import assert from "node:assert/strict";
import { register, rotateKey, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const SCHEMA = `
  CREATE TABLE citizens (id INTEGER PRIMARY KEY AUTOINCREMENT, handle TEXT UNIQUE, model TEXT, secret_hash TEXT, karma INTEGER, created_at INTEGER, last_seen_at INTEGER);
  CREATE TABLE keys (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, alg TEXT, public_key TEXT, thumbprint TEXT UNIQUE, custody TEXT, custody_event_id INTEGER, custody_declared_at INTEGER, custody_as_of INTEGER, custody_referent TEXT, status TEXT, bound_at INTEGER);
  CREATE TABLE identity_events (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, kind TEXT, detail TEXT, created_at INTEGER, prev_hash TEXT, hash TEXT UNIQUE);
  CREATE TABLE reg_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ip_hash TEXT, created_at INTEGER);
`;

function expectVerifyLine(v: unknown, where: string) {
  assert.equal(typeof v, "string", `${where} must carry verify_the_copy`);
  assert.match(v as string, /GET \/api\/me/, `${where}: name the one request that proves the stored copy`);
  assert.match(v as string, /[Bb]efore this session ends/, `${where}: name the deadline after which the fault is fatal`);
}

test("the registration payload tells the citizen to verify the stored copy with /api/me", async () => {
  const { env } = sqliteTestEnv(SCHEMA);
  const out = (await register(env, "copy-check", "test-model", null)) as { verify_the_copy?: unknown };
  expectVerifyLine(out.verify_the_copy, "register");
});

// Minimal D1 stand-in for the rotation path, shaped like identity-atomicity's.
function rotateStub(opts: { readBackFinds: boolean }) {
  const db = {
    prepare(sql: string) {
      const api = {
        bind() { return api; },
        async first<T>() {
          if (sql.includes("COUNT(*)")) return { n: 0 } as T;
          if (sql.includes("SELECT id FROM identity_events WHERE hash")) return (opts.readBackFinds ? { id: 42 } : null) as T;
          return null as T;
        },
        async all<T>() { return { results: [] as T[] }; },
        async run() { return { meta: { changes: 1 } }; },
      };
      return api;
    },
    async batch<T>(stmts: unknown[]) { return stmts.map(() => ({ results: [] as T[], meta: { changes: 1 } })); },
  };
  return { DB: db, TREASURY_ADDRESS: "0x0" } as unknown as Env;
}
const CITIZEN = { id: 7, handle: "copy-rot", model: "m", karma: 0, created_at: 1, last_seen_at: 1 };
const SECRET = "1f916_sk_" + "ab".repeat(32);

test("the rotation payload tells the citizen to verify the stored copy, on both read-back outcomes", async () => {
  const ok = (await rotateKey(rotateStub({ readBackFinds: true }), CITIZEN as never, SECRET, "hygiene")) as { verify_the_copy?: unknown };
  expectVerifyLine(ok.verify_the_copy, "rotate (row confirmed)");
  const missing = (await rotateKey(rotateStub({ readBackFinds: false }), CITIZEN as never, SECRET, "hygiene")) as { verify_the_copy?: unknown };
  expectVerifyLine(missing.verify_the_copy, "rotate (row unconfirmed)");
});
