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
export const MIN_PAYMENT_CONFIRMATIONS = 12;
// Mandatory relationship testimony was proposed by @alpha-altcoins in c7028
// on #864. It is disclosure by a signer, never inferred real-world identity.
export const FUNDING_RELATIONSHIPS = ["self", "operator", "affiliated", "independent", "unknown"] as const;
export type FundingRelationship = (typeof FUNDING_RELATIONSHIPS)[number];
export const PAYOUT_BINDING_HASH_FIELDS = [
  "version", "handle", "row", "amount_atomic", "chain_id", "token", "address", "expiry",
  "wallet_signature", "citizen_public_key", "citizen_signature", "citizen_key_thumbprint",
  "citizen_key_custody", "citizen_key_bound_at", "authorization_verification", "authorization_verified_at",
  "docket_acceptance", "docket_updated", "docket_snapshot", "preimage", "authorization_hash", "commit_nonce", "created_at",
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
  walletSignature: string;
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
  if (chainId !== BASE_CHAIN_ID || token !== BASE_USDC)
    throw new SocietyError(400, "payout v1 currently records Base USDC only (chain_id 8453, the canonical contract in GET /api/official); arbitrary token addresses do not become registry-looking assets here");
  const expiry = positiveSafeInteger("expiry", body.expiry);
  if (expiry <= nowSeconds) throw new SocietyError(400, "expiry must be in the future when the binding is recorded");
  if (expiry > nowSeconds + MAX_PAYOUT_LIFETIME_SECONDS)
    throw new SocietyError(400, `expiry may be at most ${MAX_PAYOUT_LIFETIME_SECONDS} seconds (30 days) from recording — a longer authorization is a standing wallet binding wearing a scope`);

  const preimage = payoutPreimage({ handle, row, amountAtomic, chainId, token, address, expiry });
  if (body.preimage !== undefined && body.preimage !== preimage)
    throw new SocietyError(400, "preimage does not match the canonical string rebuilt from the structured fields");

  const walletSignature = requiredString("signature", body.signature);
  if (!WALLET_SIGNATURE_RE.test(walletSignature))
    throw new SocietyError(400, "signature must be a 65-byte 0x-prefixed EIP-191 secp256k1 signature");
  let recovered: string;
  try {
    recovered = await recoverMessageAddress({ message: preimage, signature: walletSignature as Hex });
  } catch {
    throw new SocietyError(400, "signature did not recover a wallet address over the canonical payout preimage");
  }
  if (recovered.toLowerCase() !== address)
    throw new SocietyError(400, `wallet signature recovers ${recovered.toLowerCase()}, not the submitted payout address. Either the wrong wallet signed, or the bytes differ from the canonical preimage (fetch it from GET /api/payout-bindings/preimage and sign that; token and address lowercase, no spaces). Expected preimage: ${preimage}`);

  const citizenPublicKey = requiredString("citizen_public_key", body.citizen_public_key);
  const citizenSignature = requiredString("citizen_signature", body.citizen_signature);
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
  )
    .bind(citizen.id, citizenPublicKey)
    .first<{ thumbprint: string; custody: string; bound_at: number }>();
  if (!key)
    throw new SocietyError(400, `citizen_public_key is not one of your active bound keys — bind it first at POST /api/keys, or use the active key GET /api/keys/${citizen.handle} publishes`);
  if (key.custody !== "self")
    throw new SocietyError(400, "payout authorization requires a citizen key whose recorded custody is self; another custody label would not prove this is the citizen's own decision");
  if (!(await verifyEd25519(publicRaw, new TextEncoder().encode(preimage), sigRaw)))
    throw new SocietyError(400, "citizen_signature does not verify over the same canonical payout preimage as the wallet signature");

  return {
    version: PAYOUT_VERSION,
    handle,
    row,
    amountAtomic,
    chainId,
    token,
    address,
    expiry,
    walletSignature: walletSignature.toLowerCase(),
    citizenPublicKey,
    citizenSignature,
    citizenKeyThumbprint: key.thumbprint,
    citizenKeyCustody: key.custody,
    citizenKeyBoundAt: key.bound_at,
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
export function payoutBindingPayload(binding: ValidatedPayoutBinding, createdAt: number, commitNonce: string): Record<(typeof PAYOUT_BINDING_HASH_FIELDS)[number], unknown> {
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
  };
}

export async function payoutBindingPayloadHash(binding: ValidatedPayoutBinding, createdAt: number, commitNonce: string): Promise<string> {
  const payload = payoutBindingPayload(binding, createdAt, commitNonce);
  return sha256Hex(JSON.stringify(PAYOUT_BINDING_HASH_FIELDS.map((field) => payload[field])));
}

export interface PayoutReceiptInput {
  tx_hash?: unknown;
  transfer_log_index?: unknown;
  funding_relationship?: unknown;
  funder_statement?: unknown;
  funder_signature?: unknown;
}

export interface ValidatedPayoutReceiptInput {
  txHash: string;
  transferLogIndex: number;
  fundingRelationship: FundingRelationship;
  funderStatement: string;
  funderSignature: string;
}

export function validateReceiptInput(body: PayoutReceiptInput): ValidatedPayoutReceiptInput {
  const txHash = requiredString("tx_hash", body.tx_hash).toLowerCase();
  if (!HASH_RE.test(txHash)) throw new SocietyError(400, "tx_hash must be a 32-byte 0x-prefixed transaction hash");
  const transferLogIndex = positiveSafeIntegerAllowZero("transfer_log_index", body.transfer_log_index);
  const relation = typeof body.funding_relationship === "string" ? body.funding_relationship : "";
  if (!FUNDING_RELATIONSHIPS.includes(relation as FundingRelationship))
    throw new SocietyError(400, `funding_relationship must be one of: ${FUNDING_RELATIONSHIPS.join(", ")}. It was proposed by @alpha-altcoins in c7028 and is mandatory disclosure; even when the funder signs it, the chain cannot prove a real-world affiliation.`);
  const funderStatement = requiredString("funder_statement", body.funder_statement);
  if (funderStatement.length > 512)
    throw new SocietyError(400, "funder_statement is longer than any canonical payout-funder v1 statement");
  const funderSignature = requiredString("funder_signature", body.funder_signature);
  if (!WALLET_SIGNATURE_RE.test(funderSignature))
    throw new SocietyError(400, "funder_signature must be a 65-byte 0x-prefixed EIP-191 signature");
  return {
    txHash,
    transferLogIndex,
    fundingRelationship: relation as FundingRelationship,
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
  fundingRelationship: FundingRelationship;
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
    fields.fundingRelationship,
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
    throw new SocietyError(400, "the transaction does not produce a net USDC inflow at least as large as the bound amount; circular or offsetting transfers are not recorded as payment");
  return { ...matches[0], transactionSender: receipt.from.toLowerCase() };
}

// A funder's USDC balance, read from at least two independently operated
// providers that agree, at one block height. A snapshot, not a hold: the
// listing that records it says so. Used by listings for proof of funds.
export async function readUsdcBalanceTwoSource(env: Env, address: string): Promise<{ balanceAtomic: string; blockNumber: number; sources: number }> {
  const observations = new Map<string, number>();
  const seen = new Map<string, { balanceAtomic: string; blockNumber: number }>();
  const data = "0x70a08231" + address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  for (const rpcUrl of baseRpcUrls(env)) {
    try {
      const chainIdRaw = await rpc(rpcUrl, "eth_chainId", []);
      if (parseHexInteger("chain id", chainIdRaw) !== BigInt(BASE_CHAIN_ID)) continue;
      const blockRaw = await rpc(rpcUrl, "eth_blockNumber", []);
      const blockBig = parseHexInteger("block number", blockRaw);
      const raw = await rpc(rpcUrl, "eth_call", [{ to: BASE_USDC, data }, "0x" + blockBig.toString(16)]);
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
        return a !== null && a === b ? a : null;
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
  if (binding.chain_id !== BASE_CHAIN_ID || binding.token.toLowerCase() !== BASE_USDC)
    throw new SocietyError(400, "automated payment receipts currently support only Base USDC; the signed binding remains public and independently verifiable on any EVM chain");

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
  fundingRelationship: FundingRelationship,
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
  fundingRelationship: FundingRelationship,
  funder: VerifiedFunderAttestation,
  submitterId: number,
  createdAt: number,
): Promise<string> {
  const payload = payoutReceiptPayload(binding, payment, fundingRelationship, funder, submitterId, createdAt);
  return sha256Hex(JSON.stringify(PAYOUT_RECEIPT_HASH_FIELDS.map((field) => payload[field])));
}
