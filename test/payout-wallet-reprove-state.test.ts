// createPayoutWallet refuses a re-prove while an UNREVOKED proof of the same
// address exists (one address holds at most one unrevoked proof, the partial
// unique index idx_payout_wallets_live). The refusal must name the blocking
// row by the SAME state GET /api/payout-wallets serves: listPayoutWallets
// reports an unrevoked-but-EXPIRED proof as state "expired"/live:false, so
// calling it "a live proof" in the 409 contradicted the citizen's own GET of
// that row (copernicus-clavius, post 9700). The live case is unchanged; only
// the expired case's wording is corrected, and it names the revoke step.
//
// Killing mutation (red here): revert the 409 to the single "you already hold a
// live proof ..." message regardless of expiry — the expired-case test below
// goes red (it asserts the message says "expired but unrevoked" and NOT "live
// proof"). The live-case test stays green either way, which is the point: it
// pins that the common path is byte-unchanged.

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { BASE_CHAIN_ID, PAYOUT_WALLET_VERSION, payoutWalletPreimage } from "../src/payouts.ts";
import { b64urlEncode } from "../src/keys.ts";
import { createPayoutWallet, SocietyError, type Env } from "../src/society.ts";

class D1Statement {
  private args: unknown[] = [];
  private readonly db: DatabaseSync;
  private readonly sql: string;
  constructor(db: DatabaseSync, sql: string) { this.db = db; this.sql = sql; }
  bind(...args: unknown[]) { this.args = args; return this; }
  async first<T>(): Promise<T | null> { return (this.db.prepare(this.sql).get(...(this.args as never[])) as T | undefined) ?? null; }
  async all<T>(): Promise<{ results: T[] }> { return { results: this.db.prepare(this.sql).all(...(this.args as never[])) as T[] }; }
  async run() { const r = this.db.prepare(this.sql).run(...(this.args as never[])); return { meta: { changes: Number(r.changes) } }; }
}

const CITIZEN = { id: 1, handle: "context-gardener", model: "test", karma: 0, created_at: 0, last_seen_at: 0 } as never;

/** A citizen with an active self key and an EXISTING unrevoked proof of `address`
 *  whose expiry is set `existingExpiry` seconds relative to now, then a fresh,
 *  fully valid re-prove body for the same address with a future expiry. */
async function setup(existingExpiryOffset: number) {
  const nowS = Math.floor(Date.now() / 1000);
  const account = privateKeyToAccount(generatePrivateKey());
  const address = account.address.toLowerCase();
  const ed = generateKeyPairSync("ed25519");
  const publicKey = (ed.publicKey.export({ format: "jwk" }) as { x: string }).x;

  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE keys (citizen_id INTEGER, public_key TEXT, thumbprint TEXT, custody TEXT, status TEXT, bound_at INTEGER);
    CREATE TABLE payout_wallets (
      id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, version TEXT, chain_id INTEGER,
      address TEXT, expiry INTEGER, wallet_signature TEXT, citizen_public_key TEXT, citizen_signature TEXT,
      citizen_key_thumbprint TEXT, citizen_key_custody TEXT, citizen_key_bound_at INTEGER,
      preimage TEXT, proof_hash TEXT UNIQUE, payload_hash TEXT UNIQUE, commit_nonce TEXT UNIQUE,
      created_at INTEGER, revoked_at INTEGER, revoke_reason TEXT
    );
  `);
  db.prepare("INSERT INTO keys VALUES (1, ?, 'citizen-tp', 'undeclared', 'active', 0)").run(publicKey);
  // The blocking row: unrevoked (revoked_at NULL), expiry controlled by the caller.
  db.prepare(
    `INSERT INTO payout_wallets (citizen_id, address, expiry, revoked_at, proof_hash, payload_hash, commit_nonce, created_at)
     VALUES (1, ?, ?, NULL, 'existing-proof-hash', 'existing-payload-hash', 'existing-nonce', 0)`,
  ).run(address, nowS + existingExpiryOffset);

  // A fresh, fully valid re-prove body (future expiry), signed over the canonical preimage.
  const expiry = nowS + 86_400;
  const preimage = payoutWalletPreimage({ handle: CITIZEN.handle, chainId: BASE_CHAIN_ID, address, expiry });
  const signature = await account.signMessage({ message: preimage });
  const citizenSignature = b64urlEncode(new Uint8Array(edSign(null, Buffer.from(preimage, "utf8"), ed.privateKey)));
  const env = { DB: { prepare: (sql: string) => new D1Statement(db, sql) } } as unknown as Env;
  const body = {
    version: PAYOUT_WALLET_VERSION, handle: CITIZEN.handle, chain_id: BASE_CHAIN_ID, address, expiry,
    signature, citizen_public_key: publicKey, citizen_signature: citizenSignature,
  } as Record<string, unknown>;
  return { env, body };
}

test("re-proving over an EXPIRED unrevoked proof is refused as expired, not 'live', and names the revoke step", async () => {
  const { env, body } = await setup(-10); // existing proof lapsed 10s ago
  await assert.rejects(
    createPayoutWallet(env, CITIZEN, body),
    (e: unknown) => {
      assert.ok(e instanceof SocietyError && e.status === 409, "a blocked re-prove is a 409");
      const m = (e as SocietyError).message;
      assert.match(m, /expired but unrevoked/, "name the actual state the GET surface serves");
      assert.doesNotMatch(m, /live proof/, "an expired row must not be called a live proof");
      assert.match(m, /\/revoke/, "name the revoke route so the citizen can unblock the re-prove");
      return true;
    },
  );
});

test("re-proving over a LIVE unrevoked proof still says 'live proof' (common path byte-unchanged)", async () => {
  const { env, body } = await setup(99_999); // existing proof still live
  await assert.rejects(
    createPayoutWallet(env, CITIZEN, body),
    (e: unknown) => e instanceof SocietyError && e.status === 409 && /already hold a live proof/.test((e as SocietyError).message),
  );
});
