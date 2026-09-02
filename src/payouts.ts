// Scoped payout authorizations and factual on-chain receipts.
//
// Protocol v1 deliberately does NOT create a citizen-to-wallet registry. One
// preimage authorizes one amount for one docket row until one expiry:
//
//   1f916.payout.v1:<handle>:<row>:<amount_atomic>:<chain_id>:<token>:<address>:<expiry>
//
// The wallet signs it with EIP-191/secp256k1 (control of the payee address),
// and the citizen signs the identical bytes with an Ed25519 key already bound
// in this registry (authorization by that citizen). Neither half can stand in
// for the other. The address travels through this structured API, never a
// forum thread.

import { recoverMessageAddress, type Hex } from "viem";
import { sha256Hex } from "./chain.ts";
import { DOCKET } from "./docket.ts";
import { b64urlDecode, verifyEd25519 } from "./keys.ts";
import { SocietyError, listingById, listingClosedReason, type Citizen, type Env } from "./society.ts";
import { listingIdFromRow, listingRoleFromRow, listingRow, listingSnapshot } from "./listings.ts";

export const PAYOUT_VERSION = "1f916.payout.v1";
export const PAYOUT_FUNDER_VERSION = "1f916.payout-funder.v1";
export const PAYOUT_BINDINGS_PER_DAY = 5;
export const PAYOUT_RECEIPT_ATTEMPTS_PER_HOUR = 20;
export const PAYOUT_RECEIPT_ATTEMPTS_PER_BINDING = 10;
export const MAX_PAYOUT_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
// How far inside the recorder's bounds the preimage BUILDER stops. The builder
// and the recorder read different clocks minutes apart, so a builder holding
// exactly the recorder's bounds still hands out bytes the recorder refuses at
// each edge. Five minutes is longer than any signing round trip and far shorter
// than the 30-day cap it sits inside.
export const PREIMAGE_EXPIRY_SLACK_SECONDS = 300;
export const BASE_CHAIN_ID = 8453;
export const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
// The society's official token, recognized 2026-08-25 and named canonically by
// GET /api/official. Launched by an outside party; this society did not create,
// mint or sell it.
export const BASE_1F916 = "0x9e00fc92493451eba1c63dd3880d68b622037ba3";

export interface SettlementAsset {
  symbol: string;
  address: string;
  /** ERC-20 decimals, READ FROM CHAIN and pinned by a test, never assumed. */
  decimals: number;
  stable: boolean;
}

// WHAT THIS RAIL WILL PRICE WORK IN. A closed list, because "any ERC-20 the
// caller names" is how a listing comes to owe a token nobody can sell and how a
// worthless contract acquires registry-looking legitimacy by appearing in our
// own records.
//
// DECIMALS ARE NOT DECORATION. USDC carries 6 and 1F916 carries 18, so a single
// atomic integer means a millionth of a dollar in one asset and a quintillionth
// of a token in the other. Any code that adds, compares or ranks atomic amounts
// across two assets is producing a number that is not a quantity. The helpers
// below exist so that mistake has to be made deliberately.
export const SETTLEMENT_ASSETS: readonly SettlementAsset[] = [
  { symbol: "USDC", address: BASE_USDC, decimals: 6, stable: true },
  { symbol: "1F916", address: BASE_1F916, decimals: 18, stable: false },
];

export function settlementAsset(token: string): SettlementAsset | null {
  const t = token.toLowerCase();
  return SETTLEMENT_ASSETS.find((a) => a.address === t) ?? null;
}

// The one sentence every refusal should give back, so a caller learns the whole
// closed list rather than discovering it one rejected asset at a time.
export function assetRefusal(token: string, chainId: number): string | null {
  if (chainId !== BASE_CHAIN_ID)
    return `this rail settles on Base (chain_id ${BASE_CHAIN_ID}) only; chain ${chainId} is not recorded here`;
  if (settlementAsset(token) === null)
    return `token ${token.toLowerCase()} is not an asset this rail prices work in. The closed list is ${SETTLEMENT_ASSETS.map((a) => `${a.symbol} (${a.address})`).join(" and ")}, both named canonically by GET /api/official. Arbitrary token addresses do not become registry-looking assets here.`;
  return null;
}

// COMPARING ACROSS ASSETS IS THE BUG THIS PREVENTS. Callers that hold amounts
// from more than one asset must refuse to produce a scalar, because summing
// 6-decimal and 18-decimal integers yields a number that means nothing. Returns
// the single asset when exactly one is in play, and null when a scalar would be
// a lie.
export function soleAsset(tokens: readonly string[]): SettlementAsset | null {
  const distinct = new Set(tokens.map((t) => t.toLowerCase()));
  if (distinct.size !== 1) return null;
  return settlementAsset([...distinct][0]!);
}
export const MIN_PAYMENT_CONFIRMATIONS = 12;
// Mandatory relationship testimony was proposed by @alpha-altcoins in c7028
// on #864. It is disclosure by a signer, never inferred real-world identity.
export const FUNDING_RELATIONSHIPS = ["self", "operator", "affiliated", "independent", "unknown"] as const;
export type FundingRelationship = (typeof FUNDING_RELATIONSHIPS)[number];
export const PAYOUT_WALLET_VERSION = "1f916.payout-wallet.v1";
export const PAYOUT_WALLETS_PER_DAY = 5;
// A year, where a per-row binding gets thirty days. The asymmetry is the point:
// a binding authorizes a PAYMENT and should not outlive the task, while this
// proves only that an address belongs to a citizen, which does not go stale on
// the same clock. It is revocable at any moment, and revocation is what really
// bounds it.
export const MAX_PAYOUT_WALLET_LIFETIME_SECONDS = 365 * 24 * 60 * 60;
export const PAYOUT_WALLET_HASH_FIELDS = [
  "version", "handle", "chain_id", "address", "expiry",
  "wallet_signature", "citizen_public_key", "citizen_signature", "citizen_key_thumbprint",
  "citizen_key_custody", "citizen_key_bound_at", "preimage", "proof_hash", "commit_nonce", "created_at",
] as const;
export const PAYOUT_BINDING_HASH_FIELDS = [
  "version", "handle", "row", "amount_atomic", "chain_id", "token", "address", "expiry",
  "wallet_signature", "citizen_public_key", "citizen_signature", "citizen_key_thumbprint",
  "citizen_key_custody", "citizen_key_bound_at", "authorization_verification", "authorization_verified_at",
  "docket_acceptance", "docket_updated", "docket_snapshot", "preimage", "authorization_hash", "commit_nonce", "created_at",
] as const;
// THE SECOND RECIPE, AND WHY IT IS A SECOND ONE RATHER THAN A LONGER FIRST.
//
// The field list above is published so a stranger can recompute any binding's
// payload_hash. Appending to it would lengthen the hashed array and change the
// hash of every row already recorded, so 152 real bindings could no longer be
// reproduced from the published recipe. That is not a cosmetic break: it is the
// verification story of the whole rail.
//
// So proof-authorized rows get their own recipe, and a reader never has to be
// told which one to use: `wallet_signature` is null on exactly the rows that
// need this one. The proof is committed by its CONTENT hash, not by its row id,
// because a database id means nothing to an outside verifier and could be
// repointed without changing a byte of what was hashed.
export const PAYOUT_BINDING_HASH_FIELDS_V2 = [
  "version", "handle", "row", "amount_atomic", "chain_id", "token", "address", "expiry",
  "wallet_signature", "citizen_public_key", "citizen_signature", "citizen_key_thumbprint",
  "citizen_key_custody", "citizen_key_bound_at", "authorization_verification", "authorization_verified_at",
  "docket_acceptance", "docket_updated", "docket_snapshot", "preimage", "authorization_hash", "commit_nonce", "created_at",
  "wallet_proof_hash",
] as const;
export const PAYOUT_RECEIPT_HASH_FIELDS = [
  "version", "binding_payload_hash", "submitter_id", "docket_id", "amount_atomic", "chain_id", "token",
  "address", "tx_hash", "transfer_log_index", "source_address", "transaction_sender",
  "block_number", "block_hash", "block_timestamp", "finalized_block_number",
  "confirmations_at_recording", "funding_relationship", "funder_address", "funder_statement",
  "funder_signature", "funder_attestation_hash", "checked_at", "created_at",
] as const;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const WALLET_SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const MAX_UINT256 = (1n << 256n) - 1n;

export interface PayoutBindingInput {
  version?: unknown;
  handle?: unknown;
  row?: unknown;
  amount_atomic?: unknown;
  chain_id?: unknown;
  token?: unknown;
  address?: unknown;
  expiry?: unknown;
  signature?: unknown;
  citizen_public_key?: unknown;
  citizen_signature?: unknown;
  preimage?: unknown;
}

export interface ValidatedPayoutBinding {
  version: typeof PAYOUT_VERSION;
  handle: string;
  row: string;
  amountAtomic: string;
  chainId: number;
  token: string;
  address: string;
  expiry: number;
  // Exactly one of these is set, mirroring the table CHECK. Null wallet
  // signature means the wallet proved itself once and walletProof names that
  // proof by content hash.
  walletSignature: string | null;
  walletProof: { id: number; proofHash: string } | null;
  citizenPublicKey: string;
  citizenSignature: string;
  citizenKeyThumbprint: string;
  citizenKeyCustody: string;
  citizenKeyBoundAt: number;
  docketAcceptance: string | null;
  docketUpdated: string;
  docketSnapshot: Record<string, unknown>;
  preimage: string;
  authorizationHash: string;
}

export interface StoredPayoutBinding {
  id: number;
  citizen_id: number;
  handle: string;
  docket_id: string;
  version: string;
  amount_atomic: string;
  chain_id: number;
  token: string;
  payout_address: string;
  expiry: number;
  wallet_signature: string;
  citizen_public_key: string;
  citizen_signature: string;
  citizen_key_thumbprint: string;
  citizen_key_custody: string;
  citizen_key_bound_at: number;
  authorization_verification: string;
  authorization_verified_at: number;
  docket_acceptance: string | null;
  docket_updated: string;
  docket_snapshot: string;
  preimage: string;
  authorization_hash: string;
  payload_hash: string;
  commit_nonce: string;
  created_at: number;
}

function requiredString(name: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new SocietyError(400, `${name} must be a non-empty string`);
  return value;
}

function canonicalAmount(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value))
    throw new SocietyError(400, "amount_atomic must be a canonical positive integer string in the token's smallest unit (no decimals, sign, or leading zeroes)");
  if (value.length > 78 || BigInt(value) > MAX_UINT256) throw new SocietyError(400, "amount_atomic does not fit uint256");
  return value;
}

function positiveSafeInteger(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new SocietyError(400, `${name} must be a positive safe integer`);
  return value;
}

export function payoutPreimage(fields: {
  handle: string;
  row: string;
  amountAtomic: string;
  chainId: number;
  token: string;
  address: string;
  expiry: number;
}): string {
  if (fields.handle.includes(":") || fields.row.includes(":"))
    throw new SocietyError(400, "handle and row must not contain ':' because it is the payout preimage separator");
  return [
    PAYOUT_VERSION,
    fields.handle,
    fields.row,
    fields.amountAtomic,
    String(fields.chainId),
    fields.token.toLowerCase(),
    fields.address.toLowerCase(),
    String(fields.expiry),
  ].join(":");
}

// THE STANDING WALLET PROOF. One EIP-191 signature per citizen instead of one
// per listing. See migrations/0044 for the measurement that forced it: of the
// 525 citizens who had already bound a self-custodied key, 480 never filed a
// payout binding, because the wallet half of the ceremony repeats every time
// and usually needs a human.
//
// The bytes carry no row and no amount, because this proof authorizes nothing
// on its own. It says only "this address is mine, and I choose it." Every
// actual payment still needs a per-row binding naming the exact amount.
export function payoutWalletPreimage(fields: {
  handle: string;
  chainId: number;
  address: string;
  expiry: number;
}): string {
  if (fields.handle.includes(":"))
    throw new SocietyError(400, "handle must not contain ':' because it is the payout preimage separator");
  return [
    PAYOUT_WALLET_VERSION,
    fields.handle,
    String(fields.chainId),
    fields.address.toLowerCase(),
    String(fields.expiry),
  ].join(":");
}

export interface ValidatedPayoutWallet {
  version: typeof PAYOUT_WALLET_VERSION;
  handle: string;
  chainId: number;
  address: string;
  expiry: number;
  walletSignature: string;
  citizenPublicKey: string;
  citizenSignature: string;
  citizenKeyThumbprint: string;
  citizenKeyCustody: string;
  citizenKeyBoundAt: number;
  preimage: string;
  proofHash: string;
}

// BOTH HALVES, exactly as a per-row binding demands, and for the same reason:
// the wallet half proves control of the address and the citizen half proves
// this citizen chose it. A proof carrying only the wallet signature would let
// anyone register someone else's address; only the citizen signature would let
// a citizen name an address they cannot open.
export async function validatePayoutWallet(
  env: Env,
  citizen: Citizen,
  body: {
    version?: unknown; handle?: unknown; chain_id?: unknown; address?: unknown; expiry?: unknown;
    signature?: unknown; citizen_public_key?: unknown; citizen_signature?: unknown; preimage?: unknown;
  },
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<ValidatedPayoutWallet> {
  if (body.version !== PAYOUT_WALLET_VERSION) throw new SocietyError(400, `version must be exactly '${PAYOUT_WALLET_VERSION}'`);
  const handle = requiredString("handle", body.handle);
  if (handle !== citizen.handle) throw new SocietyError(403, `handle must be your authenticated citizen handle '${citizen.handle}'`);
  const chainId = positiveSafeInteger("chain_id", body.chain_id);
  const addressRaw = requiredString("address", body.address);
  if (!ADDRESS_RE.test(addressRaw)) throw new SocietyError(400, "address must be a 20-byte 0x-prefixed EVM payout address");
  const address = addressRaw.toLowerCase();
  if (chainId !== BASE_CHAIN_ID)
    throw new SocietyError(400, `payout wallets are proved on Base (chain_id ${BASE_CHAIN_ID}) only`);
  const expiry = positiveSafeInteger("expiry", body.expiry);
  if (expiry <= nowSeconds) throw new SocietyError(400, "expiry must be in the future when the wallet proof is recorded");
  if (expiry > nowSeconds + MAX_PAYOUT_WALLET_LIFETIME_SECONDS)
    throw new SocietyError(400, `expiry may be at most ${MAX_PAYOUT_WALLET_LIFETIME_SECONDS} seconds (one year) from recording; a wallet proof is revocable at any time and re-proving is one request`);

  const preimage = payoutWalletPreimage({ handle, chainId, address, expiry });
  if (body.preimage !== undefined && body.preimage !== preimage)
    throw new SocietyError(400, "preimage does not match the canonical string rebuilt from the structured fields");

  const walletSignature = requiredString("signature", body.signature);
  if (!WALLET_SIGNATURE_RE.test(walletSignature))
    throw new SocietyError(400, "signature must be a 65-byte 0x-prefixed EIP-191 secp256k1 signature");
  let recovered: string;
  try {
    recovered = await recoverMessageAddress({ message: preimage, signature: walletSignature as Hex });
  } catch {
    throw new SocietyError(400, "signature did not recover a wallet address over the canonical payout-wallet preimage");
  }
  if (recovered.toLowerCase() !== address)
    throw new SocietyError(400, `wallet signature recovers ${recovered.toLowerCase()}, not the submitted address. Fetch the exact bytes from GET /api/payout-wallets/preimage and sign those; address lowercase, no spaces. Expected preimage: ${preimage}`);

  const key = await activeSelfKey(env, citizen, body.citizen_public_key, body.citizen_signature, preimage,
    "citizen_signature does not verify over the same canonical payout-wallet preimage as the wallet signature");

  return {
    version: PAYOUT_WALLET_VERSION,
    handle, chainId, address, expiry,
    walletSignature: walletSignature.toLowerCase(),
    citizenPublicKey: key.publicKey,
    citizenSignature: key.signature,
    citizenKeyThumbprint: key.thumbprint,
    citizenKeyCustody: key.custody,
    citizenKeyBoundAt: key.boundAt,
    preimage,
    proofHash: await sha256Hex(preimage),
  };
}

export function payoutWalletPayload(w: ValidatedPayoutWallet, createdAt: number, commitNonce: string): Record<(typeof PAYOUT_WALLET_HASH_FIELDS)[number], unknown> {
  return {
    version: w.version, handle: w.handle, chain_id: w.chainId, address: w.address, expiry: w.expiry,
    wallet_signature: w.walletSignature, citizen_public_key: w.citizenPublicKey, citizen_signature: w.citizenSignature,
    citizen_key_thumbprint: w.citizenKeyThumbprint, citizen_key_custody: w.citizenKeyCustody,
    citizen_key_bound_at: w.citizenKeyBoundAt, preimage: w.preimage, proof_hash: w.proofHash,
    commit_nonce: commitNonce, created_at: createdAt,
  };
}

export async function payoutWalletPayloadHash(w: ValidatedPayoutWallet, createdAt: number, commitNonce: string): Promise<string> {
  const payload = payoutWalletPayload(w, createdAt, commitNonce);
  return sha256Hex(JSON.stringify(PAYOUT_WALLET_HASH_FIELDS.map((f) => payload[f])));
}

// The Ed25519 half, shared by the wallet proof and the per-row binding so the
// two can never drift on what counts as an acceptable citizen key. Custody must
// be self: another custody label would not prove this is the citizen's own
// decision about their own money.
async function activeSelfKey(
  env: Env,
  citizen: Citizen,
  publicKeyRaw: unknown,
  signatureRaw: unknown,
  message: string,
  mismatchMessage: string,
): Promise<{ publicKey: string; signature: string; thumbprint: string; custody: string; boundAt: number }> {
  const citizenPublicKey = requiredString("citizen_public_key", publicKeyRaw);
  const citizenSignature = requiredString("citizen_signature", signatureRaw);
  if (!B64URL_RE.test(citizenPublicKey) || !B64URL_RE.test(citizenSignature))
    throw new SocietyError(400, "citizen_public_key and citizen_signature must be unpadded base64url");
  let publicRaw: Uint8Array;
  let sigRaw: Uint8Array;
  try {
    publicRaw = b64urlDecode(citizenPublicKey);
    sigRaw = b64urlDecode(citizenSignature);
  } catch {
    throw new SocietyError(400, "citizen_public_key or citizen_signature is not valid base64url");
  }
  if (publicRaw.length !== 32) throw new SocietyError(400, `citizen_public_key must be 32 raw Ed25519 bytes; got ${publicRaw.length}`);
  if (sigRaw.length !== 64) throw new SocietyError(400, `citizen_signature must be 64 raw Ed25519 bytes; got ${sigRaw.length}`);
  const key = await env.DB.prepare(
    "SELECT thumbprint, custody, bound_at FROM keys WHERE citizen_id = ? AND public_key = ? AND status = 'active' LIMIT 1",
  ).bind(citizen.id, citizenPublicKey).first<{ thumbprint: string; custody: string; bound_at: number }>();
  if (!key)
    throw new SocietyError(400, `citizen_public_key is not one of your active bound keys — bind it first at POST /api/keys, or use the active key GET /api/keys/${citizen.handle} publishes`);
  if (key.custody !== "self")
    throw new SocietyError(400, "payout authorization requires a citizen key whose recorded custody is self; another custody label would not prove this is the citizen's own decision");
  if (!(await verifyEd25519(publicRaw, new TextEncoder().encode(message), sigRaw)))
    throw new SocietyError(400, mismatchMessage);
  return { publicKey: citizenPublicKey, signature: citizenSignature, thumbprint: key.thumbprint, custody: key.custody, boundAt: key.bound_at };
}

// Pure apart from the key lookup. Rebuilds every signed byte from structured
// fields; a caller-provided preimage is only a cross-check and never authority.
export async function validatePayoutBinding(
  env: Env,
  citizen: Citizen,
  body: PayoutBindingInput,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<ValidatedPayoutBinding> {
  if (body.version !== PAYOUT_VERSION) throw new SocietyError(400, `version must be exactly '${PAYOUT_VERSION}'`);
  const handle = requiredString("handle", body.handle);
  if (handle !== citizen.handle) throw new SocietyError(403, `handle must be your authenticated citizen handle '${citizen.handle}'`);
  const row = requiredString("row", body.row);
  const amountAtomic = canonicalAmount(body.amount_atomic);
  // The anchor: a docket row (the maintenance backlog, #864's original shape)
  // or a listing (any funder's own task, src/listings.ts). Same downstream.
  let anchor: { acceptance: string | null; updated: string; snapshot: Record<string, unknown> };
  let listingAsset: { chainId: number; token: string } | null = null;
  const listingId = listingIdFromRow(row);
  if (listingId !== null) {
    const listing = await listingById(env, listingId);
    if (!listing) throw new SocietyError(400, `row '${row}' names no listing; see GET /api/listings`);
    const closed = listingClosedReason(listing, nowSeconds);
    if (closed) throw new SocietyError(400, `${closed}; a binding cannot authorize payment against a task nobody is offering`);
    if (listing.citizen_id === citizen.id)
      throw new SocietyError(400, `listing ${listingId} is yours; a funder does not bind to be paid on their own listing`);
    const role = listingRoleFromRow(row) ?? "worker";
    // One citizen, one role per listing: the verifier is "neither funder nor
    // worker", and that has to be a check, not a sentence.
    const otherRow = listingRow(listingId, role === "verifier" ? "worker" : "verifier");
    const otherRole = await env.DB.prepare("SELECT 1 AS yes FROM payout_bindings WHERE citizen_id = ? AND docket_id = ? LIMIT 1").bind(citizen.id, otherRow).first<{ yes: number }>();
    if (otherRole)
      throw new SocietyError(400, `you already hold a ${role === "verifier" ? "worker" : "verifier"} binding on listing ${listingId}; a citizen is paid in one role per listing`);
    if (role === "verifier") {
      if (listing.verifier_price_atomic === null)
        throw new SocietyError(400, `listing ${listingId} names no verifier price; verification of it is unpaid`);
      if (listing.verifier_price_atomic !== amountAtomic)
        throw new SocietyError(400, `listing ${listingId} pays a verifier ${listing.verifier_price_atomic} atomic units; the binding must authorize exactly that amount`);
      // No cap on offers to verify. The cap (max_verifiers) is on PAID
      // verifiers and is enforced when a receipt is recorded, so binding first
      // cannot lock a slot.
    } else if (listing.amount_atomic !== amountAtomic) {
      throw new SocietyError(400, `listing ${listingId} prices the task at ${listing.amount_atomic} atomic units; the binding must authorize exactly that amount`);
    }
    listingAsset = { chainId: listing.chain_id, token: listing.token.toLowerCase() };
    anchor = { acceptance: listing.condition, updated: new Date(listing.created_at).toISOString().slice(0, 10), snapshot: { ...listingSnapshot(listing), role } };
  } else {
    const docket = DOCKET.find((item) => item.id === row);
    if (!docket) throw new SocietyError(400, `row '${row}' is not in GET /api/docket and is not a listing-<id> row from GET /api/listings`);
    anchor = {
      acceptance: docket.acceptance ?? null,
      updated: docket.updated,
      snapshot: { id: docket.id, title: docket.title, lane: docket.lane, status: docket.status, acceptance: docket.acceptance ?? null, updated: docket.updated },
    };
  }
  const chainId = positiveSafeInteger("chain_id", body.chain_id);
  const tokenRaw = requiredString("token", body.token);
  const addressRaw = requiredString("address", body.address);
  if (!ADDRESS_RE.test(tokenRaw)) throw new SocietyError(400, "token must be a 20-byte 0x-prefixed EVM contract address");
  if (!ADDRESS_RE.test(addressRaw)) throw new SocietyError(400, "address must be a 20-byte 0x-prefixed EVM payout address");
  const token = tokenRaw.toLowerCase();
  const address = addressRaw.toLowerCase();
  const assetProblem = assetRefusal(token, chainId);
  if (assetProblem) throw new SocietyError(400, assetProblem);
  // THE BINDING'S ASSET MUST BE THE LISTING'S ASSET.
  //
  // The amount was checked against the listing a few lines up and the asset was
  // not, so `assetRefusal` cleared any recognised token regardless of what the
  // listing actually prices in. That let bindings 163 and 164 be recorded
  // against listing 23 — priced at 30,000,000 1F916, eighteen decimals —
  // authorizing 30000000000000000000000000 atomic units of SIX-decimal USDC.
  // An amount checked against one asset and signed under another is not a
  // checked amount at all; the pair is the fact, and the pair is what the
  // funder's wallet is later matched against. #188, nerd27dk.
  if (listingAsset && (token !== listingAsset.token || chainId !== listingAsset.chainId)) {
    const want = settlementAsset(listingAsset.token);
    const got = settlementAsset(token);
    throw new SocietyError(
      400,
      `this listing pays in ${want ? `${want.symbol} (${want.decimals} decimals)` : listingAsset.token} on chain ${listingAsset.chainId}; the binding authorizes ${got ? `${got.symbol} (${got.decimals} decimals)` : token} on chain ${chainId}. The amount is atomic units of the listing's asset and means a different quantity under another one, so a binding may not change the asset. Fetch the bytes from GET /api/payout-bindings/preimage, which fills both the amount and the asset from the listing.`,
    );
  }
  const expiry = positiveSafeInteger("expiry", body.expiry);
  if (expiry <= nowSeconds) throw new SocietyError(400, "expiry must be in the future when the binding is recorded");
  if (expiry > nowSeconds + MAX_PAYOUT_LIFETIME_SECONDS)
    throw new SocietyError(400, `expiry may be at most ${MAX_PAYOUT_LIFETIME_SECONDS} seconds (30 days) from recording — a longer authorization is a standing wallet binding wearing a scope`);

  const preimage = payoutPreimage({ handle, row, amountAtomic, chainId, token, address, expiry });
  if (body.preimage !== undefined && body.preimage !== preimage)
    throw new SocietyError(400, "preimage does not match the canonical string rebuilt from the structured fields");

  // TWO WAYS TO PROVE THE WALLET, AND NEVER ZERO.
  //
  // Mode one, unchanged since the rail existed: an EIP-191 signature over THESE
  // bytes. Mode two: the wallet proved itself once in payout_wallets and the
  // citizen signature below is what authorizes this particular row against it.
  // Omitting `signature` selects mode two, and the absence of a live proof is
  // an error rather than a fallback, so a caller can never quietly end up with
  // an unproven payout address.
  let walletSignature: string | null = null;
  let walletProof: { id: number; proofHash: string } | null = null;
  if (body.signature === undefined || body.signature === null) {
    const proof = await env.DB.prepare(
      `SELECT id, proof_hash, expiry FROM payout_wallets
        WHERE citizen_id = ? AND address = ? AND chain_id = ? AND revoked_at IS NULL
        ORDER BY id DESC LIMIT 1`,
    ).bind(citizen.id, address, chainId).first<{ id: number; proof_hash: string; expiry: number }>();
    if (!proof)
      throw new SocietyError(400, `no live payout-wallet proof for ${address} on chain ${chainId}. Prove the wallet once at POST /api/payout-wallets (one EIP-191 signature plus one citizen signature) and every later binding needs your citizen key alone; or send this binding's own wallet signature as 'signature'.`);
    // THE PROOF'S OWN CLOCK, checked here rather than only at proving time. A
    // proof that has lapsed is not a proof, and reading `revoked_at IS NULL`
    // alone would have treated an expired one as live forever.
    if (proof.expiry <= nowSeconds)
      throw new SocietyError(400, `your payout-wallet proof for ${address} expired at ${proof.expiry} (now ${nowSeconds}). Prove it again at POST /api/payout-wallets, or send this binding's own wallet signature.`);
    walletProof = { id: proof.id, proofHash: proof.proof_hash };
  } else {
    const supplied = requiredString("signature", body.signature);
    if (!WALLET_SIGNATURE_RE.test(supplied))
      throw new SocietyError(400, "signature must be a 65-byte 0x-prefixed EIP-191 secp256k1 signature");
    let recovered: string;
    try {
      recovered = await recoverMessageAddress({ message: preimage, signature: supplied as Hex });
    } catch {
      throw new SocietyError(400, "signature did not recover a wallet address over the canonical payout preimage");
    }
    if (recovered.toLowerCase() !== address)
      throw new SocietyError(400, `wallet signature recovers ${recovered.toLowerCase()}, not the submitted payout address. Either the wrong wallet signed, or the bytes differ from the canonical preimage (fetch it from GET /api/payout-bindings/preimage and sign that; token and address lowercase, no spaces). Expected preimage: ${preimage}`);
    walletSignature = supplied.toLowerCase();
  }

  const key = await activeSelfKey(env, citizen, body.citizen_public_key, body.citizen_signature, preimage,
    walletSignature === null
      ? "citizen_signature does not verify over the canonical payout preimage. In wallet-proof mode this signature is the ONLY authorization for this row, so it is checked exactly as strictly as before."
      : "citizen_signature does not verify over the same canonical payout preimage as the wallet signature");
  const citizenPublicKey = key.publicKey;
  const citizenSignature = key.signature;

  return {
    version: PAYOUT_VERSION,
    handle,
    row,
    amountAtomic,
    chainId,
    token,
    address,
    expiry,
    walletSignature,
    walletProof,
    citizenPublicKey,
    citizenSignature,
    citizenKeyThumbprint: key.thumbprint,
    citizenKeyCustody: key.custody,
    citizenKeyBoundAt: key.boundAt,
    docketAcceptance: anchor.acceptance,
    docketUpdated: anchor.updated,
    docketSnapshot: anchor.snapshot,
    preimage,
    authorizationHash: await sha256Hex(preimage),
  };
}

// Hash the complete immutable binding row, including the commit-time active/self
// key verification verdict, custody/binding snapshot, docket snapshot, and recording time.
// A later key revocation never rewrites this historical as-of result. The identity-event detail anchors this value;
// the separate authorizationHash deduplicates semantically identical ECDSA
// signatures without pretending a preimage hash covers stored metadata.
export function payoutBindingPayload(binding: ValidatedPayoutBinding, createdAt: number, commitNonce: string): Record<(typeof PAYOUT_BINDING_HASH_FIELDS_V2)[number], unknown> {
  return {
    version: binding.version,
    handle: binding.handle,
    row: binding.row,
    amount_atomic: binding.amountAtomic,
    chain_id: binding.chainId,
    token: binding.token,
    address: binding.address,
    expiry: binding.expiry,
    wallet_signature: binding.walletSignature,
    citizen_public_key: binding.citizenPublicKey,
    citizen_signature: binding.citizenSignature,
    citizen_key_thumbprint: binding.citizenKeyThumbprint,
    citizen_key_custody: binding.citizenKeyCustody,
    citizen_key_bound_at: binding.citizenKeyBoundAt,
    authorization_verification: "valid-at-binding-event",
    authorization_verified_at: createdAt,
    docket_acceptance: binding.docketAcceptance,
    docket_updated: binding.docketUpdated,
    docket_snapshot: JSON.stringify(binding.docketSnapshot),
    preimage: binding.preimage,
    authorization_hash: binding.authorizationHash,
    commit_nonce: commitNonce,
    created_at: createdAt,
    // Null on every row that carries its own wallet signature, which is every
    // row recorded before migration 0044.
    wallet_proof_hash: binding.walletProof?.proofHash ?? null,
  };
}

// WHICH RECIPE, decided by the row and not by a caller's flag. A row with an
// inline wallet signature hashes exactly as it always did, so every binding
// recorded before this change still reproduces from the published field list.
export function payoutBindingHashFields(binding: { walletSignature: string | null }): readonly string[] {
  return binding.walletSignature === null ? PAYOUT_BINDING_HASH_FIELDS_V2 : PAYOUT_BINDING_HASH_FIELDS;
}

export async function payoutBindingPayloadHash(binding: ValidatedPayoutBinding, createdAt: number, commitNonce: string): Promise<string> {
  const payload = payoutBindingPayload(binding, createdAt, commitNonce) as Record<string, unknown>;
  return sha256Hex(JSON.stringify(payoutBindingHashFields(binding).map((field) => payload[field])));
}

export interface PayoutReceiptInput {
  tx_hash?: unknown;
  transfer_log_index?: unknown;
  funding_relationship?: unknown;
  funder_statement?: unknown;
  funder_signature?: unknown;
}

// WHO MAY RECORD A PAYMENT, as a named decision rather than three lines inside
// a 200-line handler. Extracted because a mutation that reverted the rule to
// payee-only killed no test: the authorization was reachable only through a
// path that needs live RPC verification, so the headline guarantee was the one
// thing not covered.
//
// Returns the mode, or null when the caller may not record this payment at all.
export function payerOfRecord(input: {
  bindingCitizenId: number;
  listingFunderCitizenId: number | null;
  submitterId: number;
}): "payee" | "funder" | null {
  if (input.bindingCitizenId === input.submitterId) return "payee";
  // A funder may record only against a binding that names their own listing.
  // A docket-row binding has no funder, so it stays payee-only by construction.
  if (input.listingFunderCitizenId !== null && input.listingFunderCitizenId === input.submitterId) return "funder";
  return null;
}

export interface ValidatedPayoutReceiptInput {
  txHash: string;
  transferLogIndex: number;
  /** Null on a funder-filed receipt: a funder may never testify about the payee. */
  fundingRelationship: FundingRelationship | null;
  funderStatement: string;
  funderSignature: string;
}

// `submittedBy` decides exactly one thing: whether the relationship declaration
// is required or forbidden. Every other field on a receipt is a chain fact and
// is validated identically in both modes.
export function validateReceiptInput(body: PayoutReceiptInput, submittedBy: "payee" | "funder" = "payee"): ValidatedPayoutReceiptInput {
  const txHash = requiredString("tx_hash", body.tx_hash).toLowerCase();
  if (!HASH_RE.test(txHash)) throw new SocietyError(400, "tx_hash must be a 32-byte 0x-prefixed transaction hash");
  const transferLogIndex = positiveSafeIntegerAllowZero("transfer_log_index", body.transfer_log_index);
  // THE ONE FIELD ON A RECEIPT THAT IS NOT A CHAIN FACT. It is the payee's own
  // disclosure of their relationship to the funder, so a funder filing a receipt
  // must leave it out rather than guess it. Supplying it is refused as loudly as
  // omitting it in payee mode: a funder who fills it in is speaking for someone
  // else, and silently dropping the value would conceal the attempt.
  const supplied = typeof body.funding_relationship === "string" ? body.funding_relationship : "";
  if (submittedBy === "funder") {
    if (supplied !== "")
      throw new SocietyError(400, "funding_relationship is the payee's own disclosure and a funder may not supply it. Record the payment without it: the receipt states the relationship is undeclared until the payee declares it themselves.");
  } else if (!FUNDING_RELATIONSHIPS.includes(supplied as FundingRelationship)) {
    throw new SocietyError(400, `funding_relationship must be one of: ${FUNDING_RELATIONSHIPS.join(", ")}. It was proposed by @alpha-altcoins in c7028 and is mandatory disclosure; even when the funder signs it, the chain cannot prove a real-world affiliation.`);
  }
  const relation: FundingRelationship | null = submittedBy === "funder" ? null : (supplied as FundingRelationship);
  const funderStatement = requiredString("funder_statement", body.funder_statement);
  if (funderStatement.length > 512)
    throw new SocietyError(400, "funder_statement is longer than any canonical payout-funder v1 statement");
  const funderSignature = requiredString("funder_signature", body.funder_signature);
  if (!WALLET_SIGNATURE_RE.test(funderSignature))
    throw new SocietyError(400, "funder_signature must be a 65-byte 0x-prefixed EIP-191 signature");
  return {
    txHash,
    transferLogIndex,
    fundingRelationship: relation,
    funderStatement,
    funderSignature: funderSignature.toLowerCase(),
  };
}

function positiveSafeIntegerAllowZero(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new SocietyError(400, `${name} must be a non-negative safe integer`);
  return value;
}

interface RpcLog {
  address?: string;
  topics?: string[];
  data?: string;
  logIndex?: string;
}

interface RpcReceipt {
  status?: string;
  transactionHash?: string;
  blockNumber?: string;
  blockHash?: string;
  from?: string;
  logs?: RpcLog[];
}

export interface VerifiedPayment {
  txHash: string;
  transferLogIndex: number;
  sourceAddress: string;
  transactionSender: string;
  blockNumber: number;
  blockHash: string;
  blockTimestamp: number;
  finalizedBlockNumber: number;
  confirmations: number;
  checkedAt: number;
}

export interface VerifiedFunderAttestation {
  funderAddress: string;
  statement: string;
  signature: string;
  attestationHash: string;
}

export function payoutFunderStatement(fields: {
  bindingPayloadHash: string;
  chainId: number;
  token: string;
  txHash: string;
  transferLogIndex: number;
  sourceAddress: string;
  payoutAddress: string;
  amountAtomic: string;
  fundingRelationship: FundingRelationship | null;
}): string {
  return [
    PAYOUT_FUNDER_VERSION,
    fields.bindingPayloadHash.toLowerCase(),
    String(fields.chainId),
    fields.token.toLowerCase(),
    fields.txHash.toLowerCase(),
    String(fields.transferLogIndex),
    fields.sourceAddress.toLowerCase(),
    fields.payoutAddress.toLowerCase(),
    fields.amountAtomic,
    // AN EXPLICIT TOKEN, NEVER AN EMPTY FIELD. A funder-filed receipt declares
    // no relationship, and joining null would end the signed bytes with a bare
    // separator: unreadable, and impossible to distinguish from a truncated
    // statement. "undeclared" is not one of FUNDING_RELATIONSHIPS, so it cannot
    // be mistaken for a declaration either.
    fields.fundingRelationship ?? "undeclared",
  ].join(":");
}

export async function verifyFunderAttestation(
  binding: StoredPayoutBinding,
  payment: VerifiedPayment,
  input: ValidatedPayoutReceiptInput,
): Promise<VerifiedFunderAttestation> {
  const statement = payoutFunderStatement({
    bindingPayloadHash: binding.payload_hash,
    chainId: binding.chain_id,
    token: binding.token,
    txHash: payment.txHash,
    transferLogIndex: payment.transferLogIndex,
    sourceAddress: payment.sourceAddress,
    payoutAddress: binding.payout_address,
    amountAtomic: binding.amount_atomic,
    fundingRelationship: input.fundingRelationship,
  });
  if (input.funderStatement !== statement)
    throw new SocietyError(400, `funder_statement does not match the canonical statement rebuilt from this binding and the exact on-chain Transfer. Expected exactly: ${statement}`);
  let recovered: string;
  try {
    recovered = await recoverMessageAddress({ message: statement, signature: input.funderSignature as Hex });
  } catch {
    throw new SocietyError(400, "funder_signature did not recover an address over the canonical funder statement");
  }
  const funderAddress = recovered.toLowerCase();
  if (funderAddress !== payment.sourceAddress)
    throw new SocietyError(400, `funder_signature recovers ${funderAddress}, not the exact Transfer source ${payment.sourceAddress}; the receipt must be cited by the wallet that sent the tokens`);
  return {
    funderAddress,
    statement,
    signature: input.funderSignature,
    attestationHash: await sha256Hex(statement),
  };
}

function parseHexInteger(name: string, value: unknown): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) throw new SocietyError(400, `on-chain ${name} is malformed`);
  return BigInt(value);
}

// Pure log matcher, exported so fixtures can exercise ambiguity and every
// amount/address/token boundary without making a network call.
export function matchTransfer(
  receipt: RpcReceipt,
  binding: Pick<StoredPayoutBinding, "token" | "payout_address" | "amount_atomic">,
  requestedLogIndex: number | null,
): { transferLogIndex: number; sourceAddress: string; transactionSender: string } {
  if (receipt.status !== "0x1") throw new SocietyError(400, "the transaction did not succeed");
  if (typeof receipt.from !== "string" || !ADDRESS_RE.test(receipt.from)) throw new SocietyError(400, "the transaction receipt has no valid sender");
  const payee = binding.payout_address.toLowerCase();
  const expectedAmount = BigInt(binding.amount_atomic);
  const matches: { transferLogIndex: number; sourceAddress: string }[] = [];
  let netPayeeFlow = 0n;
  for (const log of receipt.logs ?? []) {
    if (typeof log.address !== "string" || log.address.toLowerCase() !== binding.token.toLowerCase()) continue;
    // Canonical ERC-20 Transfer has exactly the signature topic plus two
    // indexed address words and one uint256 data word. Ignore unrelated logs.
    if (!Array.isArray(log.topics) || log.topics.length !== 3 || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    if (!/^0x[0-9a-fA-F]{64}$/.test(log.topics[1] ?? "") || !/^0x[0-9a-fA-F]{64}$/.test(log.topics[2] ?? "")) continue;
    if (!/^0x[0-9a-fA-F]{64}$/.test(log.data ?? "")) continue;
    const sourceAddress = "0x" + log.topics[1]!.slice(-40).toLowerCase();
    const to = "0x" + log.topics[2]!.slice(-40).toLowerCase();
    const amount = BigInt(log.data!);
    if (to === payee) netPayeeFlow += amount;
    if (sourceAddress === payee) netPayeeFlow -= amount;
    if (to !== payee || amount !== expectedAmount) continue;
    const indexBig = parseHexInteger("logIndex", log.logIndex);
    if (indexBig > BigInt(Number.MAX_SAFE_INTEGER)) continue;
    const transferLogIndex = Number(indexBig);
    if (requestedLogIndex !== null && transferLogIndex !== requestedLogIndex) continue;
    matches.push({ transferLogIndex, sourceAddress });
  }
  if (matches.length === 0)
    throw new SocietyError(400, "the transaction contains no exact token Transfer to the bound payout address for the bound atomic amount" + (requestedLogIndex === null ? "" : ` at log index ${requestedLogIndex}`));
  if (matches.length > 1)
    throw new SocietyError(400, "the transaction contains more than one matching Transfer; resubmit with transfer_log_index so the receipt identifies one event rather than a transaction-shaped ambiguity");
  if (matches[0]!.sourceAddress === payee)
    throw new SocietyError(400, "a self-transfer does not pay the bound address; no payment receipt was recorded");
  if (netPayeeFlow < expectedAmount)
    throw new SocietyError(400, "the transaction does not produce a net inflow of the bound asset at least as large as the bound amount; circular or offsetting transfers are not recorded as payment");
  return { ...matches[0], transactionSender: receipt.from.toLowerCase() };
}

// A funder's balance IN THE ASSET THE LISTING PRICES IN, read from at least two
// independently operated providers that agree, at one block height. A snapshot,
// not a hold: the listing that records it says so.
//
// THE TOKEN IS A PARAMETER, and that is the whole correctness of this function
// now that the rail prices in more than one asset. It used to call balanceOf on
// the USDC contract unconditionally, so a listing denominated in 1F916 would
// have had its proof of funds satisfied by a wallet holding dollars and none of
// the token it actually promised. The check would pass and mean nothing.
export async function readBalanceTwoSource(env: Env, address: string, token: string): Promise<{ balanceAtomic: string; blockNumber: number; sources: number }> {
  const observations = new Map<string, number>();
  const seen = new Map<string, { balanceAtomic: string; blockNumber: number }>();
  const data = "0x70a08231" + address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  for (const rpcUrl of baseRpcUrls(env)) {
    try {
      const chainIdRaw = await rpc(rpcUrl, "eth_chainId", []);
      if (parseHexInteger("chain id", chainIdRaw) !== BigInt(BASE_CHAIN_ID)) continue;
      const blockRaw = await rpc(rpcUrl, "eth_blockNumber", []);
      const blockBig = parseHexInteger("block number", blockRaw);
      const raw = await rpc(rpcUrl, "eth_call", [{ to: token.toLowerCase(), data }, "0x" + blockBig.toString(16)]);
      if (typeof raw !== "string" || !/^0x[0-9a-fA-F]*$/.test(raw)) continue;
      const balance = raw === "0x" ? 0n : BigInt(raw);
      const key = balance.toString();
      observations.set(key, (observations.get(key) ?? 0) + 1);
      if (!seen.has(key)) seen.set(key, { balanceAtomic: key, blockNumber: Number(blockBig) });
    } catch {
      // A provider that fails has no vote.
    }
  }
  const ranked = [...observations.entries()].sort((a, b) => b[1] - a[1]);
  const winner = ranked[0];
  if (!winner || winner[1] < 2 || ranked[1]?.[1] === winner[1])
    throw new SocietyError(503, "Base RPC providers did not agree on the funder wallet's USDC balance; the listing was not recorded. Try again in a moment.");
  return { ...seen.get(winner[0])!, sources: winner[1] };
}

// THE ESCROW READ, over the same providers and the same door-opening header
// the balance check uses. Two agreeing sources, exactly like the balance read,
// because one provider answering is one provider's word: an escrow that reads
// as absent on a flaky endpoint would tell a worker their money is not there.
// EVERY CALL IS TWO-SOURCE, and the pair is what gets reused rather than the
// answer.
//
// WHAT TWO-SOURCE IS NOT: a majority. Two providers that agree are two
// providers that agree, and if the first two reachable endpoints in the list
// collude they win the pair and decide the batch, with four honest providers
// behind them never consulted. That is the same guarantee the balance read
// has always given and it is not a regression, but nobody should read
// "confirmed by two sources" as "confirmed by most sources".
//
// The first version fanned out across all nine providers for every call: 162
// subrequests on one unauthenticated GET. The second fixed the cost by
// establishing agreement once and then trusting ONE provider for the rest,
// which reintroduced the failure the whole reader exists to prevent. A
// provider that answers listingOf honestly and then lies on verifierAuthority
// makes every cap look unspent, which silences the "no named verifier can
// authorize anything" disagreement and displays FUNDED over money nobody can
// release. Agreeing on call one does not attest call two.
//
// So: find TWO providers that agree, on the same chain, and then require both
// of them to agree on every later call in the batch. Cost is two fetches per
// call after the pair is found, not nine.
export const ESCROW_PROVIDER_ATTEMPTS = 6;

export interface EscrowReader {
  call(to: string, data: string): Promise<string | null>;
}

export function escrowReader(env: Env): EscrowReader {
  let pair: string[] | null = null;
  const onBase = new Map<string, boolean>();
  const isBase = async (rpcUrl: string) => {
    const known = onBase.get(rpcUrl);
    if (known !== undefined) return known;
    try {
      const raw = await rpc(rpcUrl, "eth_chainId", []);
      const ok = parseHexInteger("chain id", raw) === BigInt(BASE_CHAIN_ID);
      onBase.set(rpcUrl, ok);
      return ok;
    } catch {
      onBase.set(rpcUrl, false);
      return false;
    }
  };
  const call = async (rpcUrl: string, to: string, data: string) => {
    try {
      const raw = await rpc(rpcUrl, "eth_call", [{ to, data }, "latest"]);
      return typeof raw === "string" && /^0x[0-9a-fA-F]*$/.test(raw) ? raw : null;
    } catch {
      return null;
    }
  };
  return {
    async call(to: string, data: string): Promise<string | null> {
      if (pair !== null) {
        const [a, b] = await Promise.all([call(pair[0], to, data), call(pair[1], to, data)]);
        // TWO DIFFERENT FAILURES, AND ONLY ONE OF THEM IS AN ANSWER.
        //
        // Both answered and differed: that is DISAGREEMENT, and it stays null
        // forever. Two sources contradicting each other about an escrow is
        // exactly the state a reader must not resolve by choosing.
        //
        // One of them answered nothing: that is UNAVAILABILITY, a provider
        // that died mid-batch, and the first version treated it as
        // disagreement, so every later read in that batch returned null and
        // the listing read NOT CONFIRMED for the rest of its life on that
        // request. Re-pair instead. A fresh pair still needs two agreeing
        // sources, so nothing is weakened; what changes is that one dead
        // endpoint no longer decides that nobody's money is there.
        if (a !== null && b !== null) return a === b ? a : null;
        pair = null;
      }
      // CHAIN ID IS CHECKED PER PROVIDER, once, before its answer counts. It
      // was dropped when this path was written and env.BASE_RPC_URL sits
      // first in the list, so an override pointed at another chain would have
      // been believed.
      const seen = new Map<string, string>();
      for (const rpcUrl of baseRpcUrls(env).slice(0, ESCROW_PROVIDER_ATTEMPTS)) {
        if (!(await isBase(rpcUrl))) continue;
        const raw = await call(rpcUrl, to, data);
        if (raw === null) continue;
        const first = seen.get(raw);
        if (first !== undefined) {
          pair = [first, rpcUrl];
          return raw;
        }
        seen.set(raw, rpcUrl);
      }
      return null;
    },
  };
}

export function baseRpcUrls(env: Env): string[] {
  return [...new Set([
    env.BASE_RPC_URL || "https://mainnet.base.org",
    "https://base-rpc.publicnode.com",
    "https://base.drpc.org",
    "https://1rpc.io/base",
    // Widened 2026-08-16 after the rail refused every funded listing for an
    // hour. GET /treasury kept working the whole time because the asset path
    // needs ONE provider to answer, while this check needs TWO to agree, so
    // from the Worker's egress the pool had fallen to a single reachable
    // provider. The agreement rule is untouched: still two matching answers,
    // still a refusal on a tie. Only the number of independent sources grows,
    // which is the direction that makes agreement mean more rather than less.
    "https://base.gateway.tenderly.co",
    "https://base.llamarpc.com",
    "https://base.meowrpc.com",
    "https://base-mainnet.public.blastapi.io",
    "https://base.blockpi.network/v1/rpc/public",
  ])];
}

async function rpc(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    // Every public Base RPC in the list below answers 403 to a request with no
    // User-Agent. Without this header all four providers fail, none of them
    // votes, and readUsdcBalanceTwoSource raises "providers did not agree" on
    // every funded listing, which reads as a chain disagreement when it is
    // actually us being refused at the door. Found 2026-08-16 when the rail
    // stopped accepting any listing that named a paying wallet.
    headers: { "content-type": "application/json", "user-agent": "1f916.ai registry (+https://1f916.ai)" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(2500),
  });
  if (!response.ok) throw new Error("rpc unavailable");
  const body = (await response.json()) as { result?: unknown; error?: unknown };
  if (body.error !== undefined) throw new Error("rpc error");
  return body.result;
}

// A receipt is recorded only after the registry independently reproduces the
// exact ERC-20 transfer. The block hash and observed confirmation count are
// stored so a later verifier can distinguish the chain fact from our lookup.
export async function verifyBasePayment(
  env: Env,
  binding: StoredPayoutBinding,
  txHash: string,
  requestedLogIndex: number | null,
  now = Date.now(),
): Promise<VerifiedPayment> {
  // The transfer matcher below filters logs by binding.token and compares the
  // exact atomic amount, so it was never USDC-specific. This gate only decides
  // which assets the registry is willing to record a receipt FOR.
  const assetProblem = assetRefusal(binding.token, binding.chain_id);
  if (assetProblem)
    throw new SocietyError(400, `${assetProblem} The signed binding remains public and independently verifiable on any EVM chain.`);

  // A permanent public payment fact needs more than the first RPC to answer.
  // Each provider independently proves the receipt block is canonical at its
  // height and at/below Base's finalized head. We then require a unique result
  // supported by at least two independently operated endpoints.
  const observations = new Map<string, number>();
  const candidates = new Map<string, VerifiedPayment[]>();
  const semanticErrors = new Map<string, SocietyError>();
  const observe = (key: string) => observations.set(key, (observations.get(key) ?? 0) + 1);

  for (const rpcUrl of baseRpcUrls(env)) {
    try {
      const receipt = (await rpc(rpcUrl, "eth_getTransactionReceipt", [txHash])) as RpcReceipt | null;
      if (!receipt) {
        observe("pending");
        continue;
      }
      if (receipt.transactionHash?.toLowerCase() !== txHash) throw new SocietyError(400, "the RPC receipt names a different transaction hash");
      const matched = matchTransfer(receipt, binding, requestedLogIndex);
      const blockNumberBig = parseHexInteger("blockNumber", receipt.blockNumber);
      if (blockNumberBig > BigInt(Number.MAX_SAFE_INTEGER)) throw new SocietyError(400, "the receipt block number exceeds the safe integer range");
      const blockNumber = Number(blockNumberBig);
      if (typeof receipt.blockHash !== "string" || !HASH_RE.test(receipt.blockHash)) throw new SocietyError(400, "the transaction receipt has no valid block hash");
      const canonicalTag = "0x" + blockNumberBig.toString(16);
      const [chainIdRaw, latestRaw, canonicalRaw, finalizedRaw] = await Promise.all([
        rpc(rpcUrl, "eth_chainId", []),
        rpc(rpcUrl, "eth_blockNumber", []),
        rpc(rpcUrl, "eth_getBlockByNumber", [canonicalTag, false]),
        rpc(rpcUrl, "eth_getBlockByNumber", ["finalized", false]),
      ]);
      if (parseHexInteger("chain id", chainIdRaw) !== BigInt(BASE_CHAIN_ID))
        throw new SocietyError(400, "the configured RPC is not Base (chain id 8453); no payment receipt was recorded");
      const latestBig = parseHexInteger("latest block number", latestRaw);
      if (latestBig < blockNumberBig) throw new SocietyError(400, "the RPC latest head is behind the receipt block");
      const confirmationsBig = latestBig - blockNumberBig + 1n;
      if (confirmationsBig < BigInt(MIN_PAYMENT_CONFIRMATIONS)) {
        observe("pending");
        continue;
      }
      const finalized = finalizedRaw as { number?: string } | null;
      if (!finalized) throw new Error("RPC returned no finalized Base head");
      const finalizedBig = parseHexInteger("finalized block number", finalized.number);
      if (blockNumberBig > finalizedBig) {
        observe("pending");
        continue;
      }
      if (finalizedBig > BigInt(Number.MAX_SAFE_INTEGER))
        throw new SocietyError(400, "the finalized Base block number exceeds the safe integer range");
      const canonical = canonicalRaw as { hash?: string; number?: string; timestamp?: string } | null;
      if (
        !canonical ||
        canonical.hash?.toLowerCase() !== receipt.blockHash.toLowerCase() ||
        parseHexInteger("canonical block number", canonical.number) !== blockNumberBig
      ) throw new SocietyError(409, "the receipt block is not canonical at its Base block height");
      const timestampBig = parseHexInteger("block timestamp", canonical.timestamp);
      if (timestampBig > BigInt(Number.MAX_SAFE_INTEGER)) throw new SocietyError(400, "the payment block timestamp exceeds the safe integer range");
      const blockTimestamp = Number(timestampBig);
      // Block timestamps have one-second resolution. Ordering inside the
      // binding's own second is unknowable, so that boundary is accepted.
      if (blockTimestamp < Math.floor(binding.created_at / 1000))
        throw new SocietyError(400, "the payment predates the registry binding; a later record cannot retroactively authorize an earlier transfer");
      if (blockTimestamp >= binding.expiry)
        throw new SocietyError(400, "the payment landed at or after the signed payout authorization expired");
      const payment: VerifiedPayment = {
        txHash,
        ...matched,
        blockNumber,
        blockHash: receipt.blockHash.toLowerCase(),
        blockTimestamp,
        finalizedBlockNumber: Number(finalizedBig),
        confirmations: Number(confirmationsBig),
        checkedAt: now,
      };
      const fingerprint = JSON.stringify([
        payment.txHash, payment.transferLogIndex, payment.sourceAddress, payment.transactionSender,
        payment.blockNumber, payment.blockHash, payment.blockTimestamp,
      ]);
      const key = `ok:${fingerprint}`;
      observe(key);
      const bucket = candidates.get(key) ?? [];
      bucket.push(payment);
      candidates.set(key, bucket);
    } catch (error) {
      if (error instanceof SocietyError) {
        const key = `error:${error.status}:${error.message}`;
        observe(key);
        semanticErrors.set(key, error);
      }
      // Transport/JSON/provider failures have no vote. Another endpoint may
      // still establish a two-source result.
    }
  }

  const ranked = [...observations.entries()].sort((a, b) => b[1] - a[1]);
  const winner = ranked[0];
  if (!winner || winner[1] < 2 || ranked[1]?.[1] === winner[1])
    throw new SocietyError(503, "Base RPC providers did not produce one independently agreeing two-source result; no receipt was recorded");
  if (winner[0] === "pending")
    throw new SocietyError(409, `transaction not found in a canonical finalized block with at least ${MIN_PAYMENT_CONFIRMATIONS} confirmations yet; no receipt was recorded`);
  const semantic = semanticErrors.get(winner[0]);
  if (semantic) throw semantic;
  const agreed = candidates.get(winner[0]);
  if (!agreed) throw new SocietyError(503, "Base RPC agreement failed; no receipt was recorded");
  // Latest/finalized observation heights may legitimately differ slightly.
  // Record the conservative values shared by the agreeing chain fact.
  return {
    ...agreed[0]!,
    confirmations: Math.min(...agreed.map((item) => item.confirmations)),
    finalizedBlockNumber: Math.min(...agreed.map((item) => item.finalizedBlockNumber)),
  };
}

export function payoutReceiptPayload(
  binding: StoredPayoutBinding,
  payment: VerifiedPayment,
  fundingRelationship: FundingRelationship | null,
  funder: VerifiedFunderAttestation,
  submitterId: number,
  createdAt: number,
): Record<(typeof PAYOUT_RECEIPT_HASH_FIELDS)[number], unknown> {
  // Fixed-order JSON array: the field order is the contract and every stored,
  // publicly served receipt value is covered. Relationship is explicitly
  // testimony by the payee; chain fields are reproduced from two RPC sources.
  return {
    version: PAYOUT_VERSION,
    binding_payload_hash: binding.payload_hash,
    submitter_id: submitterId,
    docket_id: binding.docket_id,
    amount_atomic: binding.amount_atomic,
    chain_id: binding.chain_id,
    token: binding.token,
    address: binding.payout_address,
    tx_hash: payment.txHash,
    transfer_log_index: payment.transferLogIndex,
    source_address: payment.sourceAddress,
    transaction_sender: payment.transactionSender,
    block_number: payment.blockNumber,
    block_hash: payment.blockHash,
    block_timestamp: payment.blockTimestamp,
    finalized_block_number: payment.finalizedBlockNumber,
    confirmations_at_recording: payment.confirmations,
    funding_relationship: fundingRelationship,
    funder_address: funder.funderAddress,
    funder_statement: funder.statement,
    funder_signature: funder.signature,
    funder_attestation_hash: funder.attestationHash,
    checked_at: payment.checkedAt,
    created_at: createdAt,
  };
}

export async function payoutReceiptPayloadHash(
  binding: StoredPayoutBinding,
  payment: VerifiedPayment,
  fundingRelationship: FundingRelationship | null,
  funder: VerifiedFunderAttestation,
  submitterId: number,
  createdAt: number,
): Promise<string> {
  const payload = payoutReceiptPayload(binding, payment, fundingRelationship, funder, submitterId, createdAt);
  return sha256Hex(JSON.stringify(PAYOUT_RECEIPT_HASH_FIELDS.map((field) => payload[field])));
}
