// Refusals in src/payouts.ts's binding and wallet validators that no test
// killed. Found by the mutation audit of 2026-09-04: each `throw new
// SocietyError` below was replaced with `void new SocietyError` and the suite
// stayed green. Every test names its killing mutation.

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  BASE_USDC,
  PAYOUT_VERSION,
  PAYOUT_WALLET_VERSION,
  payoutFunderStatement,
  payoutPreimage,
  payoutWalletPreimage,
  validatePayoutBinding,
  validatePayoutWallet,
  validateReceiptInput,
  verifyFunderAttestation,
} from "../src/payouts.ts";
import { b64urlEncode } from "../src/keys.ts";
import { DOCKET } from "../src/docket.ts";
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

// The validators reach the database only after the shape checks under test,
// so an empty keys table is enough: every test here is refused before a key
// is looked up.
function makeEnv(): Env {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE keys (citizen_id INTEGER, public_key TEXT, thumbprint TEXT, custody TEXT, status TEXT, bound_at INTEGER)");
  db.exec("CREATE TABLE payout_wallets (id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER, version TEXT, chain_id INTEGER, address TEXT, expiry INTEGER, wallet_signature TEXT, citizen_public_key TEXT, citizen_signature TEXT, citizen_key_thumbprint TEXT, citizen_key_custody TEXT, citizen_key_bound_at INTEGER, preimage TEXT, proof_hash TEXT UNIQUE, payload_hash TEXT UNIQUE, commit_nonce TEXT UNIQUE, created_at INTEGER, revoked_at INTEGER, revoke_reason TEXT)");
  return { DB: { prepare: (sql: string) => new D1Statement(db, sql) } } as unknown as Env;
}

const CITIZEN = { id: 1, handle: "context-gardener", model: "test", karma: 0, created_at: 0, last_seen_at: 0 };
const NOW = 1_800_000_000;
const ROW = DOCKET[0].id;
const ADDRESS = "0x" + "a".repeat(40);

const bindingBody = (over: Record<string, unknown> = {}) => ({
  version: PAYOUT_VERSION, handle: CITIZEN.handle, row: ROW, amount_atomic: "5000000", chain_id: 8453, token: BASE_USDC,
  address: ADDRESS, expiry: NOW + 3600, ...over,
});

const refusedWith = (status: number, pattern: RegExp) => (e: unknown) =>
  e instanceof SocietyError && e.status === status && pattern.test(e.message);

test("an amount_atomic that does not fit uint256 is refused, even though it is a canonical positive integer", async () => {
  // KILLING MUTATION: src/payouts.ts canonicalAmount, `throw new
  // SocietyError(400, "amount_atomic does not fit uint256")` -> `void ...`.
  // The string passes the canonical-integer test and would be signed into a
  // binding for an amount no ERC-20 transfer can carry, so no receipt could
  // ever match it and the row would sit on the rail as a routing record for
  // an impossible sum.
  const env = makeEnv();
  const tooLong = "1" + "0".repeat(78); // 79 digits
  await assert.rejects(validatePayoutBinding(env, CITIZEN as never, bindingBody({ amount_atomic: tooLong }), NOW), refusedWith(400, /amount_atomic does not fit uint256/));
  const overMax = ((1n << 256n)).toString(); // 78 digits, one past uint256
  await assert.rejects(validatePayoutBinding(env, CITIZEN as never, bindingBody({ amount_atomic: overMax }), NOW), refusedWith(400, /amount_atomic does not fit uint256/));
});

test("chain_id must be a positive safe integer, and a numeric string is not one", async () => {
  // KILLING MUTATION: src/payouts.ts positiveSafeInteger, `throw new
  // SocietyError(400, `${name} must be a positive safe integer`)` -> `void
  // ...`. The string "8453" would then flow into assetRefusal as a string,
  // fail the strict comparison with 8453, and the payee would be told their
  // chain is not Base. A refusal for the wrong reason is a refusal the
  // payee cannot fix.
  const env = makeEnv();
  for (const chain_id of ["8453", 0, -8453, 1.5, Number.NaN, null]) {
    await assert.rejects(
      validatePayoutBinding(env, CITIZEN as never, bindingBody({ chain_id }), NOW),
      refusedWith(400, /chain_id must be a positive safe integer/),
      `chain_id ${String(chain_id)}`,
    );
  }
});

test("a payout preimage cannot be built from a handle or row containing its own separator", () => {
  // KILLING MUTATION: src/payouts.ts payoutPreimage, `throw new
  // SocietyError(400, "handle and row must not contain ':' ...")` -> `void
  // ...`. The joined bytes would then parse as a different field layout, so
  // a wallet signature over them would verify against a binding whose row
  // or amount a stranger reads differently.
  const fields = { handle: CITIZEN.handle, row: ROW, amountAtomic: "5000000", chainId: 8453, token: BASE_USDC, address: ADDRESS, expiry: NOW + 3600 };
  assert.throws(() => payoutPreimage({ ...fields, handle: "a:b" }), refusedWith(400, /handle and row must not contain ':'/));
  assert.throws(() => payoutPreimage({ ...fields, row: "listing-1:verifier" }), refusedWith(400, /handle and row must not contain ':'/));
  assert.equal(payoutPreimage(fields).split(":").length, 8, "eight fields, joined by the one separator");
});

test("a wallet-proof preimage cannot be built from a handle containing the separator either", () => {
  // KILLING MUTATION: src/payouts.ts payoutWalletPreimage, `throw new
  // SocietyError(400, "handle must not contain ':' ...")` -> `void ...`.
  const fields = { handle: "a:b", chainId: 8453, address: ADDRESS, expiry: NOW + 3600 };
  assert.throws(() => payoutWalletPreimage(fields), refusedWith(400, /handle must not contain ':'/));
  assert.equal(payoutWalletPreimage({ ...fields, handle: CITIZEN.handle }).split(":").length, 5);
});

const walletBody = (over: Record<string, unknown> = {}) => ({
  version: PAYOUT_WALLET_VERSION, handle: CITIZEN.handle, chain_id: 8453, address: ADDRESS, expiry: NOW + 3600, ...over,
});

test("a wallet proof is refused unless its handle is the authenticated citizen's own", async () => {
  // KILLING MUTATION: src/payouts.ts validatePayoutWallet, `throw new
  // SocietyError(403, `handle must be your authenticated citizen handle
  // ...`)` -> `void ...`. A citizen could then file a wallet proof under
  // another citizen's handle, and every later binding by that handle would
  // resolve to a wallet its owner never chose.
  const env = makeEnv();
  await assert.rejects(
    validatePayoutWallet(env, CITIZEN as never, walletBody({ handle: "somebody-else" }), NOW),
    refusedWith(403, /handle must be your authenticated citizen handle 'context-gardener'/),
  );
});

test("a wallet proof names a 20-byte address on Base, and nothing else", async () => {
  // KILLING MUTATIONS: src/payouts.ts validatePayoutWallet, `throw new
  // SocietyError(400, "address must be a 20-byte 0x-prefixed EVM payout
  // address")` -> `void ...` (the malformed string would then be lowercased
  // and compared against a recovered address it can never equal, so the
  // refusal would name the signature instead of the address), and `throw
  // new SocietyError(400, `payout wallets are proved on Base ...`)` ->
  // `void ...` (a proof on chain 1 would then be recorded and a Base
  // binding could later cite it).
  const env = makeEnv();
  for (const address of ["0x1234", "a".repeat(40), "0x" + "g".repeat(40)]) {
    await assert.rejects(validatePayoutWallet(env, CITIZEN as never, walletBody({ address }), NOW), refusedWith(400, /address must be a 20-byte 0x-prefixed EVM payout address/), `address ${address}`);
  }
  for (const chain_id of [1, 56, 84532]) {
    await assert.rejects(validatePayoutWallet(env, CITIZEN as never, walletBody({ chain_id }), NOW), refusedWith(400, /payout wallets are proved on Base \(chain_id 8453\) only/), `chain ${chain_id}`);
  }
});

test("a wallet signature must be 65 bytes, and 65 bytes that recover nothing are refused as such", async () => {
  // KILLING MUTATIONS: src/payouts.ts validatePayoutWallet, `throw new
  // SocietyError(400, "signature must be a 65-byte 0x-prefixed EIP-191
  // secp256k1 signature")` -> `void ...` (recovery is then attempted on
  // arbitrary bytes), and in the recovery catch, `throw new
  // SocietyError(400, "signature did not recover a wallet address ...")` ->
  // `void ...` (recovered is then undefined and the comparison after it
  // dies on .toLowerCase()).
  const env = makeEnv();
  await assert.rejects(
    validatePayoutWallet(env, CITIZEN as never, walletBody({ signature: "0x1234" }), NOW),
    refusedWith(400, /signature must be a 65-byte 0x-prefixed EIP-191 secp256k1 signature/),
  );
  // 65 bytes of zeros: well-formed length, no point on the curve.
  await assert.rejects(
    validatePayoutWallet(env, CITIZEN as never, walletBody({ signature: "0x" + "00".repeat(65) }), NOW),
    refusedWith(400, /signature did not recover a wallet address over the canonical payout-wallet preimage/),
  );
});

test("a receipt's funder_signature must be 65 bytes before anything is recovered from it", () => {
  // KILLING MUTATION: src/payouts.ts validateReceiptInput, `throw new
  // SocietyError(400, "funder_signature must be a 65-byte 0x-prefixed
  // EIP-191 signature")` -> `void ...`. The malformed value would then be
  // lowercased, carried to the RPC verification, and only fail at recovery
  // after two providers had been asked about the transaction.
  const body = { tx_hash: "0x" + "ab".repeat(32), transfer_log_index: 0, funding_relationship: "independent", funder_statement: "payout-funder v1 ...", funder_signature: "0x1234" };
  assert.throws(() => validateReceiptInput(body), refusedWith(400, /funder_signature must be a 65-byte 0x-prefixed EIP-191 signature/));
  assert.throws(() => validateReceiptInput({ ...body, funder_signature: "0x" + "ab".repeat(64) }), refusedWith(400, /funder_signature must be a 65-byte/));
  assert.equal(validateReceiptInput({ ...body, funder_signature: "0x" + "AB".repeat(65) }).funderSignature, "0x" + "ab".repeat(65), "the well-formed value is lowercased");
});

test("a funder attestation whose signature recovers nothing is refused as such, not as a wrong wallet", async () => {
  // KILLING MUTATION: src/payouts.ts verifyFunderAttestation, in the
  // recovery catch, `throw new SocietyError(400, "funder_signature did not
  // recover an address ...")` -> `void ...`. `recovered` is then undefined
  // and the next line dies on .toLowerCase() with a TypeError, so the
  // payee is shown a stack trace instead of which of their inputs is wrong.
  const binding = { payload_hash: "cd".repeat(32), chain_id: 8453, token: BASE_USDC, payout_address: ADDRESS, amount_atomic: "5000000" } as never;
  const payment = { txHash: "0x" + "ab".repeat(32), transferLogIndex: 0, sourceAddress: "0x" + "b".repeat(40) } as never;
  const statement = payoutFunderStatement({
    bindingPayloadHash: "cd".repeat(32), chainId: 8453, token: BASE_USDC, txHash: "0x" + "ab".repeat(32), transferLogIndex: 0,
    sourceAddress: "0x" + "b".repeat(40), payoutAddress: ADDRESS, amountAtomic: "5000000", fundingRelationship: "independent",
  });
  await assert.rejects(
    verifyFunderAttestation(binding, payment, { txHash: "0x" + "ab".repeat(32), transferLogIndex: 0, fundingRelationship: "independent", funderStatement: statement, funderSignature: "0x" + "00".repeat(65) }),
    refusedWith(400, /funder_signature did not recover an address over the canonical funder statement/),
  );
});

test("a funder_statement longer than any canonical statement is refused before it is compared", () => {
  // KILLING MUTATION: src/payouts.ts validateReceiptInput, `throw new
  // SocietyError(400, "funder_statement is longer than any canonical
  // payout-funder v1 statement")` -> `void ...`. The bound exists so a
  // multi-kilobyte statement is refused at the door rather than carried
  // through RPC verification and rejected at the end for not matching.
  const body = { tx_hash: "0x" + "ab".repeat(32), transfer_log_index: 0, funding_relationship: "independent", funder_statement: "x".repeat(513), funder_signature: "0x" + "ab".repeat(65) };
  assert.throws(() => validateReceiptInput(body), refusedWith(400, /funder_statement is longer than any canonical payout-funder v1 statement/));
  assert.equal(validateReceiptInput({ ...body, funder_statement: "x".repeat(512) }).funderStatement.length, 512, "the bound itself is accepted");
});

// A wallet proof that gets past the wallet half: a real secp256k1 signature
// by a fresh wallet over the exact wallet preimage, so the only thing left
// to refuse is the citizen half.
async function walletSigned(env: Env, over: Record<string, unknown> = {}) {
  const wallet = privateKeyToAccount(generatePrivateKey());
  const address = wallet.address.toLowerCase();
  const expiry = NOW + 3600;
  const preimage = payoutWalletPreimage({ handle: CITIZEN.handle, chainId: 8453, address, expiry });
  const signature = await wallet.signMessage({ message: preimage });
  return { body: walletBody({ address, expiry, signature, ...over }), preimage };
}

test("the citizen half of a wallet proof is refused for shape before any key is looked up", async () => {
  // KILLING MUTATIONS, all in src/payouts.ts activeSelfKey, each `throw new
  // SocietyError(400, ...)` -> `void ...`:
  //   "citizen_public_key and citizen_signature must be unpadded base64url"
  //   "citizen_public_key or citizen_signature is not valid base64url"
  //   `citizen_public_key must be 32 raw Ed25519 bytes; got ${n}`
  //   `citizen_signature must be 64 raw Ed25519 bytes; got ${n}`
  // With any of them gone the value flows on to the key lookup and the
  // Ed25519 verify, which refuse for a different reason or, for the byte
  // lengths, hand WebCrypto a key it cannot import.
  const env = makeEnv();
  const good = b64urlEncode(new Uint8Array(32));
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ citizen_public_key: "not+base64/url=", citizen_signature: good }, /must be unpadded base64url/],
    [{ citizen_public_key: good, citizen_signature: "has spaces" }, /must be unpadded base64url/],
    [{ citizen_public_key: "AAAAA", citizen_signature: good }, /is not valid base64url/], // length mod 4 == 1
    [{ citizen_public_key: "AAAA", citizen_signature: good }, /citizen_public_key must be 32 raw Ed25519 bytes; got 3/],
    [{ citizen_public_key: good, citizen_signature: "AAAA" }, /citizen_signature must be 64 raw Ed25519 bytes; got 3/],
  ];
  for (const [over, pattern] of cases) {
    const { body } = await walletSigned(env, over);
    await assert.rejects(validatePayoutWallet(env, CITIZEN as never, body, NOW), refusedWith(400, pattern), JSON.stringify(over));
  }
});

test("a citizen signature that does not verify over the preimage is refused with the caller's own mismatch sentence", async () => {
  // KILLING MUTATION: src/payouts.ts activeSelfKey, `throw new
  // SocietyError(400, mismatchMessage)` -> `void ...`. A wallet proof would
  // then be recorded on a bound key that never signed it: the wallet half
  // proves the wallet is real, and only this line proves the citizen chose it.
  const env = makeEnv();
  const ed = generateKeyPairSync("ed25519");
  const publicKey = (ed.publicKey.export({ format: "jwk" }) as { x: string }).x;
  (env.DB as unknown as { prepare: (sql: string) => D1Statement }).prepare("INSERT INTO keys VALUES (1, ?, 'tp', 'self', 'active', 0)").bind(publicKey).run();
  const { body } = await walletSigned(env, { citizen_public_key: publicKey, citizen_signature: b64urlEncode(new Uint8Array(randomBytes(64))) });
  await assert.rejects(validatePayoutWallet(env, CITIZEN as never, body, NOW), refusedWith(400, /citizen_signature does not verify|does not verify/));
});

test("a receipt's tx_hash must be a 32-byte hash before anything is asked of a provider", () => {
  // KILLING MUTATION: src/payouts.ts validateReceiptInput, `throw new
  // SocietyError(400, "tx_hash must be a 32-byte 0x-prefixed transaction
  // hash")` -> `void ...`. The malformed value would then be sent to every
  // provider in the pool as eth_getTransactionReceipt and come back as
  // "not found", a 409 that tells the payee to wait for confirmations that
  // will never come.
  const body = { tx_hash: "0x1234", transfer_log_index: 0, funding_relationship: "independent", funder_statement: "payout-funder v1 ...", funder_signature: "0x" + "ab".repeat(65) };
  assert.throws(() => validateReceiptInput(body), refusedWith(400, /tx_hash must be a 32-byte 0x-prefixed transaction hash/));
  assert.throws(() => validateReceiptInput({ ...body, tx_hash: "ab".repeat(32) }), refusedWith(400, /tx_hash must be a 32-byte/), "no 0x prefix");
  assert.equal(validateReceiptInput({ ...body, tx_hash: "0x" + "AB".repeat(32) }).txHash, "0x" + "ab".repeat(32));
});

test("a payout binding is refused unless its handle is the authenticated citizen's own", async () => {
  // KILLING MUTATION: src/payouts.ts validatePayoutBinding, `throw new
  // SocietyError(403, `handle must be your authenticated citizen handle
  // ...`)` -> `void ...`. The handle is the first field of the signed
  // preimage, so a binding filed under another citizen's handle would be a
  // routing authorization in their name, signed by somebody else.
  const env = makeEnv();
  await assert.rejects(
    validatePayoutBinding(env, CITIZEN as never, bindingBody({ handle: "somebody-else" }), NOW),
    refusedWith(403, /handle must be your authenticated citizen handle 'context-gardener'/),
  );
});

test("a binding's wallet signature must recover the payout address it names, not merely some address", async () => {
  // KILLING MUTATION: src/payouts.ts validatePayoutBinding, `throw new
  // SocietyError(400, `wallet signature recovers ${...}, not the submitted
  // payout address ...`)` -> `void ...`. Wallet A could then authorize
  // payment to address B: a signature that proves control of a wallet the
  // money will never reach.
  const env = makeEnv();
  const signer = privateKeyToAccount(generatePrivateKey());
  const other = privateKeyToAccount(generatePrivateKey());
  const address = other.address.toLowerCase();
  const expiry = NOW + 3600;
  const preimage = payoutPreimage({ handle: CITIZEN.handle, row: ROW, amountAtomic: "5000000", chainId: 8453, token: BASE_USDC, address, expiry });
  const signature = await signer.signMessage({ message: preimage });
  await assert.rejects(
    validatePayoutBinding(env, CITIZEN as never, bindingBody({ address, expiry, signature }), NOW),
    refusedWith(400, new RegExp(`wallet signature recovers ${signer.address.toLowerCase()}, not the submitted payout address`)),
  );
  // And the two refusals before that line, for the same binding: the
  // signature's shape, then whether it recovers anything at all.
  // KILLING MUTATIONS: `throw new SocietyError(400, "signature must be a
  // 65-byte 0x-prefixed EIP-191 secp256k1 signature")` -> `void ...`, and
  // in the recovery catch `throw new SocietyError(400, "signature did not
  // recover a wallet address over the canonical payout preimage")` ->
  // `void ...` (recovered is then undefined and the address comparison
  // dies on .toLowerCase()).
  await assert.rejects(
    validatePayoutBinding(env, CITIZEN as never, bindingBody({ address, expiry, signature: "0x1234" }), NOW),
    refusedWith(400, /signature must be a 65-byte 0x-prefixed EIP-191 secp256k1 signature/),
  );
  await assert.rejects(
    validatePayoutBinding(env, CITIZEN as never, bindingBody({ address, expiry, signature: "0x" + "00".repeat(65) }), NOW),
    refusedWith(400, /signature did not recover a wallet address over the canonical payout preimage/),
  );
});

test("a binding whose expiry has already passed is refused at recording time", async () => {
  // KILLING MUTATION: src/payouts.ts validatePayoutBinding, `throw new
  // SocietyError(400, "expiry must be in the future when the binding is
  // recorded")` -> `void ...`. An already-expired authorization would then
  // be recorded, and every receipt against it refused as "landed after
  // expiry": a routing record that can never route.
  const env = makeEnv();
  for (const expiry of [NOW, NOW - 1, NOW - 86400]) {
    await assert.rejects(
      validatePayoutBinding(env, CITIZEN as never, bindingBody({ expiry }), NOW),
      refusedWith(400, /expiry must be in the future when the binding is recorded/),
      `expiry ${expiry - NOW}s from now`,
    );
  }
});

test("a binding names a 20-byte token and a 20-byte payout address, in an asset this rail prices in", async () => {
  // KILLING MUTATIONS, src/payouts.ts validatePayoutBinding, each `throw new
  // SocietyError(400, ...)` -> `void ...`:
  //   "token must be a 20-byte 0x-prefixed EVM contract address"
  //   "address must be a 20-byte 0x-prefixed EVM payout address"
  //   assetProblem (the closed asset list, applied to the binding's own token)
  // With the asset refusal gone a binding in an arbitrary token would be
  // recorded as a routing authorization the rail has no price for.
  const env = makeEnv();
  await assert.rejects(validatePayoutBinding(env, CITIZEN as never, bindingBody({ token: "0x1234" }), NOW), refusedWith(400, /token must be a 20-byte 0x-prefixed EVM contract address/));
  await assert.rejects(validatePayoutBinding(env, CITIZEN as never, bindingBody({ address: "0x1234" }), NOW), refusedWith(400, /address must be a 20-byte 0x-prefixed EVM payout address/));
  await assert.rejects(validatePayoutBinding(env, CITIZEN as never, bindingBody({ token: "0x" + "9".repeat(40) }), NOW), refusedWith(400, /is not an asset this rail prices work in/));
  await assert.rejects(validatePayoutBinding(env, CITIZEN as never, bindingBody({ chain_id: 1 }), NOW), refusedWith(400, /settles on Base \(chain_id 8453\) only/));
});

test("a wallet proof with the wrong version string is refused first, before any signature is examined", async () => {
  // KILLING MUTATION: src/payouts.ts validatePayoutWallet, `throw new
  // SocietyError(400, `version must be exactly '${PAYOUT_WALLET_VERSION}'`)`
  // -> `void ...`. The proof would then be checked and, if the signature
  // held, recorded under a version the preimage recipe does not describe.
  const env = makeEnv();
  for (const version of ["payout-wallet-v0", PAYOUT_VERSION, undefined, 1]) {
    await assert.rejects(
      validatePayoutWallet(env, CITIZEN as never, { version, handle: CITIZEN.handle, chain_id: 8453, address: ADDRESS, expiry: NOW + 3600 }, NOW),
      refusedWith(400, new RegExp(`version must be exactly '${PAYOUT_WALLET_VERSION}'`)),
      `version ${String(version)}`,
    );
  }
});
