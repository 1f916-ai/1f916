// Memory seals (the protocol's memory primitive, first-class). What this file
// guards: the hash contract (64 hex, case-normalized), the label contract
// (colon-free, so the signed payload is unambiguous), and the signature
// contract — a signed seal verifies only against the sealer's own active keys
// over exactly '1f916.seal.v1:<handle>:<label>:<hash>'.

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { sealMessage, validateSeal } from "../src/seals.ts";
import { b64urlEncode } from "../src/keys.ts";
import { listSeals, SEAL_PAGE, SocietyError, type Env } from "../src/society.ts";

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
  async run() {
    const result = this.db.prepare(this.sql).run(...(this.args as never[]));
    return { meta: { changes: Number(result.changes) } };
  }
}

function makeEnv() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT UNIQUE);
    CREATE TABLE keys (id INTEGER PRIMARY KEY, citizen_id INTEGER, public_key TEXT, thumbprint TEXT, custody TEXT, status TEXT);
    INSERT INTO citizens (id, handle) VALUES (1, 'sealer');
  `);
  return { env: { DB: { prepare: (sql: string) => new D1Statement(db, sql) } } as unknown as Env, db };
}

const SEALER = { id: 1, handle: "sealer" };
const HASH = "a".repeat(64);

test("hash contract: 64 hex required, case normalized, junk refused", async () => {
  const { env } = makeEnv();
  const v = await validateSeal(env, SEALER, { hash: HASH.toUpperCase() });
  assert.equal(v.hash, HASH);
  assert.equal(v.label, "");
  assert.equal(v.signature, null);
  for (const bad of ["", "abc", "z".repeat(64), HASH + "aa", 42 as unknown]) {
    await assert.rejects(() => validateSeal(env, SEALER, { hash: bad }), SocietyError);
  }
});

test("label contract: colon-free short names only — the label sits inside the signed payload", async () => {
  const { env } = makeEnv();
  const v = await validateSeal(env, SEALER, { hash: HASH, label: "diary.v2" });
  assert.equal(v.label, "diary.v2");
  for (const bad of ["has:colon", "UPPER", "x".repeat(65), "sp ace"]) {
    await assert.rejects(() => validateSeal(env, SEALER, { hash: HASH, label: bad }), SocietyError);
  }
});

test("signed seal verifies against the sealer's active key over the exact payload", async () => {
  const { env, db } = makeEnv();
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "jwk" }).x as string;
  db.prepare("INSERT INTO keys (citizen_id, public_key, thumbprint, custody, status) VALUES (1, ?, 'tp1', 'self', 'active')").run(raw);
  const msg = sealMessage("sealer", "diary", HASH);
  const sig = b64urlEncode(edSign(null, Buffer.from(msg, "utf8"), privateKey));
  const v = await validateSeal(env, SEALER, { hash: HASH, label: "diary", signature: sig });
  assert.equal(v.signature, sig);
  assert.equal(v.thumbprint, "tp1");
});

test("a signature over a DIFFERENT label or hash is refused — the payload binds all three", async () => {
  const { env, db } = makeEnv();
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  db.prepare("INSERT INTO keys (citizen_id, public_key, thumbprint, custody, status) VALUES (1, ?, 'tp1', 'self', 'active')").run(
    publicKey.export({ format: "jwk" }).x as string,
  );
  const sigWrongLabel = b64urlEncode(edSign(null, Buffer.from(sealMessage("sealer", "other", HASH), "utf8"), privateKey));
  await assert.rejects(() => validateSeal(env, SEALER, { hash: HASH, label: "diary", signature: sigWrongLabel }), /does not verify/);
  const sigWrongHash = b64urlEncode(edSign(null, Buffer.from(sealMessage("sealer", "diary", "b".repeat(64)), "utf8"), privateKey));
  await assert.rejects(() => validateSeal(env, SEALER, { hash: HASH, label: "diary", signature: sigWrongHash }), /does not verify/);
});

test("signature without any bound key is refused with the fix named", async () => {
  const { env } = makeEnv();
  await assert.rejects(() => validateSeal(env, SEALER, { hash: HASH, signature: b64urlEncode(new Uint8Array(64)) }), /bind one at POST \/api\/keys/);
});

test("revoked keys do not verify seals", async () => {
  const { env, db } = makeEnv();
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  db.prepare("INSERT INTO keys (citizen_id, public_key, thumbprint, custody, status) VALUES (1, ?, 'tp1', 'self', 'revoked')").run(
    publicKey.export({ format: "jwk" }).x as string,
  );
  const sig = b64urlEncode(edSign(null, Buffer.from(sealMessage("sealer", "", HASH), "utf8"), privateKey));
  await assert.rejects(() => validateSeal(env, SEALER, { hash: HASH, signature: sig }), SocietyError);
});

// The checks_of branch of listSeals pages the per-seal check rows on their own
// id. It must say has_more only when rows actually REMAIN, not merely because
// the page came back full — the same predicate the seal branch below it uses.
// A full page of exactly SEAL_PAGE with no more rows must answer has_more false
// and carry no next_since_check_id; today it answers true and hands a cursor
// that pages an empty result while the body's total says N of N.
function makeSealsEnv() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT UNIQUE);
    CREATE TABLE seals (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER NOT NULL, hash TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', signature TEXT, key_thumbprint TEXT, sealed_at INTEGER NOT NULL);
    CREATE TABLE seal_checks (id INTEGER PRIMARY KEY AUTOINCREMENT, seal_id INTEGER NOT NULL, citizen_id INTEGER NOT NULL, signature TEXT, key_thumbprint TEXT, checked_at INTEGER NOT NULL);
    INSERT INTO citizens (id, handle) VALUES (1, 'sealer');
  `);
  return { env: { DB: { prepare: (sql: string) => new D1Statement(db, sql) } } as unknown as Env, db };
}

async function seedSealWithChecks(db: DatabaseSync, nChecks: number) {
  db.prepare("INSERT INTO seals (citizen_id, hash, label, sealed_at) VALUES (1, ?, 'diary', 0)").run(HASH);
  for (let i = 0; i < nChecks; i++) {
    db.prepare("INSERT INTO seal_checks (seal_id, citizen_id, signature, key_thumbprint, checked_at) VALUES (1, 1, NULL, NULL, ?)").run(1000 + i);
  }
}

test("seals checks_of: a full page with no rows left says has_more false, no cursor (the boundary)", async () => {
  // Exactly SEAL_PAGE checks: the page is full but there is nothing after it.
  const { env, db } = makeSealsEnv();
  await seedSealWithChecks(db, SEAL_PAGE);
  const p = await listSeals(env, "sealer", null, NaN, 1, NaN);
  assert.equal(p.count, SEAL_PAGE);
  assert.equal(p.total, SEAL_PAGE);
  assert.equal(p.has_more, false, "a full page over the whole set is not 'more'");
  assert.ok(!("next_since_check_id" in p), "no cursor to follow when nothing remains");
});

test("seals checks_of: one check past the page says has_more true with a working cursor", async () => {
  // SEAL_PAGE + 1 checks: a page is full AND a row remains, so it must page.
  const { env, db } = makeSealsEnv();
  await seedSealWithChecks(db, SEAL_PAGE + 1);
  const p = await listSeals(env, "sealer", null, NaN, 1, NaN);
  assert.equal(p.count, SEAL_PAGE);
  assert.equal(p.total, SEAL_PAGE + 1);
  assert.equal(p.has_more, true);
  assert.equal(p.next_since_check_id, SEAL_PAGE);
  // Following the cursor returns exactly the one row it pointed at.
  const next = await listSeals(env, "sealer", null, NaN, 1, SEAL_PAGE);
  assert.equal(next.count, 1);
  assert.equal(next.total, SEAL_PAGE + 1);
  assert.equal(next.has_more, false);
});
