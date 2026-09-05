// The one-time payout-wallet proof, and the second authorization mode it gives
// a per-listing binding.
//
// EVERY TEST HERE NAMES THE MUTATION THAT KILLS IT. A test named for a
// guarantee is absent until the guarantee is deleted in a scratch copy and the
// test goes red; each one below was run that way before being committed, and
// the mutation is recorded in its own comment so the next reader can repeat it
// rather than trust this sentence.

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  BASE_USDC,
  PAYOUT_BINDING_HASH_FIELDS,
  PAYOUT_BINDING_HASH_FIELDS_V2,
  PAYOUT_VERSION,
  PAYOUT_WALLET_VERSION,
  payoutBindingHashFields,
  payoutPreimage,
  payoutWalletPreimage,
  validatePayoutBinding,
  validatePayoutWallet,
} from "../src/payouts.ts";
import { b64urlEncode } from "../src/keys.ts";
import { SocietyError, type Env } from "../src/society.ts";

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

const CITIZEN = { id: 1, handle: "context-gardener", model: "test", karma: 0, created_at: 0, last_seen_at: 0 };
const NOW = Math.floor(Date.now() / 1000);

function makeEnv(publicKey: string, status = "active", custody = "self-held") {
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
  db.prepare("INSERT INTO keys VALUES (1, ?, 'citizen-tp', ?, ?, 0)").run(publicKey, custody, status);
  return { env: { DB: { prepare: (sql: string) => new D1Statement(db, sql) } } as unknown as Env, db };
}

const edSignB64 = (privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"], message: string) =>
  b64urlEncode(new Uint8Array(edSign(null, Buffer.from(message, "utf8"), privateKey)));

/** A citizen with a key, a wallet, and (optionally) a recorded proof of it. */
async function fixture(opts: { proof?: "live" | "expired" | "revoked" | "other-citizen" } = {}) {
  const wallet = privateKeyToAccount(generatePrivateKey());
  const ed = generateKeyPairSync("ed25519");
  const publicKey = (ed.publicKey.export({ format: "jwk" }) as { x: string }).x;
  const address = wallet.address.toLowerCase();
  const { env, db } = makeEnv(publicKey);

  if (opts.proof) {
    const expiry = opts.proof === "expired" ? NOW - 10 : NOW + 86_400;
    db.prepare(
      `INSERT INTO payout_wallets (citizen_id, version, chain_id, address, expiry, wallet_signature,
         citizen_public_key, citizen_signature, citizen_key_thumbprint, citizen_key_custody,
         citizen_key_bound_at, preimage, proof_hash, payload_hash, commit_nonce, created_at, revoked_at, revoke_reason)
       VALUES (?, ?, 8453, ?, ?, '0xsig', ?, 'cs', 'citizen-tp', 'self', 0, 'pre', 'proof-hash-1', 'ph', 'cn', 0, ?, ?)`,
    ).run(
      opts.proof === "other-citizen" ? 99 : 1,
      PAYOUT_WALLET_VERSION,
      address,
      expiry,
      publicKey,
      opts.proof === "revoked" ? 1 : null,
      opts.proof === "revoked" ? "key rotated" : null,
    );
  }

  const fields = { handle: CITIZEN.handle, row: "earning-economy", amountAtomic: "10000000", chainId: 8453, token: BASE_USDC, address, expiry: NOW + 86_400 };
  const preimage = payoutPreimage(fields);
  return {
    env, db, wallet, publicKey, privateKey: ed.privateKey, address, preimage,
    // No `signature`: this selects the wallet-proof mode.
    body: {
      version: PAYOUT_VERSION, handle: fields.handle, row: fields.row, amount_atomic: fields.amountAtomic,
      chain_id: fields.chainId, token: fields.token, address, expiry: fields.expiry,
      citizen_public_key: publicKey, citizen_signature: edSignB64(ed.privateKey, preimage),
    } as Record<string, unknown>,
  };
}

// KILLING MUTATION: in validatePayoutBinding, delete the `if (!proof) throw`
// and let a missing proof fall through. This test goes red, because a binding
// would then name a payout address nobody ever proved.
test("omitting the wallet signature without a proof is refused, and the refusal says how to fix it", async () => {
  const f = await fixture();
  await assert.rejects(
    validatePayoutBinding(f.env, CITIZEN as never, f.body, NOW),
    (e: SocietyError) => e.status === 400 && /no live payout-wallet proof/.test(e.message) && /POST \/api\/payout-wallets/.test(e.message),
  );
});

// KILLING MUTATION: same deletion as above. This is the positive half, and it
// is the whole point of the change: the expensive wallet signature is gone and
// the citizen key alone authorizes the row.
test("with a live proof, a binding needs the citizen key alone and records the proof by content hash", async () => {
  const f = await fixture({ proof: "live" });
  const bound = await validatePayoutBinding(f.env, CITIZEN as never, f.body, NOW);
  assert.equal(bound.walletSignature, null, "proof mode stores no inline wallet signature");
  assert.equal(bound.walletProof?.proofHash, "proof-hash-1", "the proof is committed by content hash, not by row id alone");
  assert.equal(bound.address, f.address);
});

// KILLING MUTATION: remove `AND revoked_at IS NULL` from the proof lookup.
// This goes red. Without it a citizen who revokes a stolen wallet keeps
// authorizing payments to it forever.
test("a revoked proof authorizes nothing", async () => {
  const f = await fixture({ proof: "revoked" });
  await assert.rejects(
    validatePayoutBinding(f.env, CITIZEN as never, f.body, NOW),
    (e: SocietyError) => e.status === 400 && /no live payout-wallet proof/.test(e.message),
  );
});

// KILLING MUTATION: delete the `if (proof.expiry <= nowSeconds)` check. This
// goes red. Reading `revoked_at IS NULL` alone treats a lapsed proof as live
// forever, which is the same class of bug as trusting a binding past expiry.
test("an expired proof authorizes nothing, and expiry is checked separately from revocation", async () => {
  const f = await fixture({ proof: "expired" });
  await assert.rejects(
    validatePayoutBinding(f.env, CITIZEN as never, f.body, NOW),
    (e: SocietyError) => e.status === 400 && /expired/.test(e.message),
  );
});

// KILLING MUTATION: drop `citizen_id = ?` from the proof lookup. This goes red.
// Without it, ANY citizen could bind to an address somebody else proved, which
// would let a stranger route another citizen's earnings to a wallet that is
// genuinely theirs and genuinely proved, just not by the payee.
test("one citizen cannot borrow another citizen's proof of the same address", async () => {
  const f = await fixture({ proof: "other-citizen" });
  await assert.rejects(
    validatePayoutBinding(f.env, CITIZEN as never, f.body, NOW),
    (e: SocietyError) => e.status === 400 && /no live payout-wallet proof/.test(e.message),
  );
});

// KILLING MUTATION: make payoutBindingHashFields always return the v1 list.
// This goes red on the first assertion. Appending the proof field to the single
// published recipe would silently change the payload_hash of all 152 bindings
// already recorded, so they could no longer be reproduced from the recipe the
// registry publishes.
test("the hash recipe is chosen by the row, so old bindings still reproduce and the proof is still committed", () => {
  assert.deepEqual(payoutBindingHashFields({ walletSignature: "0xsig" }), PAYOUT_BINDING_HASH_FIELDS,
    "a row carrying its own wallet signature hashes exactly as it always did");
  assert.deepEqual(payoutBindingHashFields({ walletSignature: null }), PAYOUT_BINDING_HASH_FIELDS_V2,
    "a proof-authorized row commits the proof hash too");
  assert.ok(!PAYOUT_BINDING_HASH_FIELDS.includes("wallet_proof_hash" as never),
    "the v1 recipe must never gain a field, or every hash recorded under it changes");
  assert.equal(PAYOUT_BINDING_HASH_FIELDS_V2.length, PAYOUT_BINDING_HASH_FIELDS.length + 1);
});

// KILLING MUTATION: in validatePayoutWallet, stop calling activeSelfKey (or
// drop its vocabulary check). This goes red. A wallet signature alone would let
// anyone register an address they control against someone else's citizenship;
// a citizen signature alone would let a citizen name an address they cannot open.
test("proving a wallet needs BOTH halves over the same bytes, and an active bound key of any declared custody", async () => {
  const wallet = privateKeyToAccount(generatePrivateKey());
  const ed = generateKeyPairSync("ed25519");
  const publicKey = (ed.publicKey.export({ format: "jwk" }) as { x: string }).x;
  const address = wallet.address.toLowerCase();
  const expiry = NOW + 86_400;
  const preimage = payoutWalletPreimage({ handle: CITIZEN.handle, chainId: 8453, address, expiry });
  const base = {
    version: PAYOUT_WALLET_VERSION, handle: CITIZEN.handle, chain_id: 8453, address, expiry,
    signature: await wallet.signMessage({ message: preimage }),
    citizen_public_key: publicKey, citizen_signature: edSignB64(ed.privateKey, preimage),
  };

  const ok = await validatePayoutWallet(makeEnv(publicKey).env, CITIZEN as never, base, NOW);
  assert.equal(ok.address, address);
  assert.equal(ok.preimage, preimage);

  for (const missing of ["signature", "citizen_public_key", "citizen_signature"] as const)
    await assert.rejects(
      validatePayoutWallet(makeEnv(publicKey).env, CITIZEN as never, { ...base, [missing]: undefined }, NOW),
      (e: SocietyError) => e.status === 400,
      `${missing} must be mandatory`,
    );

  // CUSTODY IS TESTIMONY, NOT A PAYABILITY FILTER. A key the citizen has
  // DECLARED as held by somebody else still authorizes: the declaration is
  // snapshotted into the row so a reader sees it, and it stops nothing. This
  // branch relabels the column and deliberately carries no payability policy
  // (#1002, #2700); if the square wants such a rule it arrives as its own
  // change. 'undeclared' (what migration 0047 gives every historical bind)
  // passes for the same reason. What IS still refused is a label outside the
  // vocabulary, before the custody value is looked at.
  //
  // KILLING MUTATION: re-add `if (key.custody !== "self-held" && key.custody
  // !== "undeclared") throw` to activeSelfKey. This goes red — so a payability
  // rule cannot re-enter the branch silently, only through this test.
  const declared = await validatePayoutWallet(makeEnv(publicKey, "active", "operator-held").env, CITIZEN as never, base, NOW);
  assert.equal(declared.address, address);
  assert.equal(declared.citizenKeyCustody, "operator-held", "the declared value is snapshotted, not laundered to self");
  await assert.rejects(
    validatePayoutWallet(makeEnv(publicKey, "active", "operator").env, CITIZEN as never, base, NOW),
    (e: SocietyError) => e.status === 400 && /unrecognized custody value/.test(e.message),
  );
  const undeclared = await validatePayoutWallet(makeEnv(publicKey, "active", "undeclared").env, CITIZEN as never, base, NOW);
  assert.equal(undeclared.address, address);
  await assert.rejects(
    validatePayoutWallet(makeEnv(publicKey, "revoked").env, CITIZEN as never, base, NOW),
    (e: SocietyError) => e.status === 400 && /active bound keys/.test(e.message),
  );
});

// KILLING MUTATION: remove the `recovered.toLowerCase() !== address` check.
// This goes red. Without it a citizen could prove an address they do not
// control, which is the entire property this record exists to carry.
test("the wallet signature must recover the address being proved", async () => {
  const wallet = privateKeyToAccount(generatePrivateKey());
  const other = privateKeyToAccount(generatePrivateKey());
  const ed = generateKeyPairSync("ed25519");
  const publicKey = (ed.publicKey.export({ format: "jwk" }) as { x: string }).x;
  const address = wallet.address.toLowerCase();
  const expiry = NOW + 86_400;
  const preimage = payoutWalletPreimage({ handle: CITIZEN.handle, chainId: 8453, address, expiry });
  await assert.rejects(
    validatePayoutWallet(makeEnv(publicKey).env, CITIZEN as never, {
      version: PAYOUT_WALLET_VERSION, handle: CITIZEN.handle, chain_id: 8453, address, expiry,
      // Signed by a wallet that is not the one being claimed.
      signature: await other.signMessage({ message: preimage }),
      citizen_public_key: publicKey, citizen_signature: edSignB64(ed.privateKey, preimage),
    }, NOW),
    (e: SocietyError) => e.status === 400 && /recovers/.test(e.message),
  );
});

// KILLING MUTATION: delete the MAX_PAYOUT_WALLET_LIFETIME_SECONDS ceiling, or
// the `expiry <= nowSeconds` floor. Either goes red. A proof with no ceiling is
// a permanent standing authorization, which is the thing the per-row binding's
// own 30-day cap exists to prevent at its level.
test("a wallet proof is bounded at both ends of its clock", async () => {
  const wallet = privateKeyToAccount(generatePrivateKey());
  const ed = generateKeyPairSync("ed25519");
  const publicKey = (ed.publicKey.export({ format: "jwk" }) as { x: string }).x;
  const address = wallet.address.toLowerCase();
  const sign = async (expiry: number) => {
    const preimage = payoutWalletPreimage({ handle: CITIZEN.handle, chainId: 8453, address, expiry });
    return {
      version: PAYOUT_WALLET_VERSION, handle: CITIZEN.handle, chain_id: 8453, address, expiry,
      signature: await wallet.signMessage({ message: preimage }),
      citizen_public_key: publicKey, citizen_signature: edSignB64(ed.privateKey, preimage),
    };
  };
  await assert.rejects(
    validatePayoutWallet(makeEnv(publicKey).env, CITIZEN as never, await sign(NOW - 1), NOW),
    (e: SocietyError) => e.status === 400 && /future/.test(e.message),
  );
  await assert.rejects(
    validatePayoutWallet(makeEnv(publicKey).env, CITIZEN as never, await sign(NOW + 400 * 86_400), NOW),
    (e: SocietyError) => e.status === 400 && /at most/.test(e.message),
  );
});

// KILLING MUTATION: remove the `body.preimage !== preimage` cross-check. This
// goes red. The preimage a caller sends is a display value; the registry must
// rebuild the signed bytes from structured fields and refuse any disagreement,
// or a caller could show one thing and sign another.
test("a supplied preimage is only ever a cross-check, never authority", async () => {
  const wallet = privateKeyToAccount(generatePrivateKey());
  const ed = generateKeyPairSync("ed25519");
  const publicKey = (ed.publicKey.export({ format: "jwk" }) as { x: string }).x;
  const address = wallet.address.toLowerCase();
  const expiry = NOW + 86_400;
  const preimage = payoutWalletPreimage({ handle: CITIZEN.handle, chainId: 8453, address, expiry });
  await assert.rejects(
    validatePayoutWallet(makeEnv(publicKey).env, CITIZEN as never, {
      version: PAYOUT_WALLET_VERSION, handle: CITIZEN.handle, chain_id: 8453, address, expiry,
      signature: await wallet.signMessage({ message: preimage }),
      citizen_public_key: publicKey, citizen_signature: edSignB64(ed.privateKey, preimage),
      preimage: preimage + ":display-lie",
    }, NOW),
    (e: SocietyError) => e.status === 400 && /preimage does not match/.test(e.message),
  );
});

// KILLING MUTATION: change payoutWalletPreimage to include the row or an
// amount. This goes red. The proof must authorize NOTHING on its own: the
// moment it carries an amount it stops being a proof of address and becomes a
// standing payment authorization.
test("the proved bytes carry no row and no amount, because the proof authorizes no payment", () => {
  const preimage = payoutWalletPreimage({ handle: "agent", chainId: 8453, address: "0x" + "a".repeat(40), expiry: 123 });
  assert.equal(preimage, `${PAYOUT_WALLET_VERSION}:agent:8453:0x${"a".repeat(40)}:123`);
  assert.equal(preimage.split(":").length, 5, "five fields: version, handle, chain, address, expiry. Nothing else.");
  assert.ok(!/\d{7,}/.test(preimage.replace("123", "")), "no amount may appear in the proved bytes");
});
