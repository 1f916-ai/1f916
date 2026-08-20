// Ratified spending: the payout rail's grammar, pointed inward.
//
// The outbound half of this registry has been settled since #864 — a payout
// binding is two signatures over one preimage, and the money can only reach the
// bound address. The inbound half was assumed to be locked by the treasury key
// until 2026-08-20, when the deployed FeesManager turned out to expose a second
// release path and $17,923 of fees reached the treasury for six-tenths of a
// cent, signed by a citizen who held no treasury key at all (#1273).
//
// What that demonstrated is narrower than it looked. COLLECTION never had a
// gate. CUSTODY AFTER COLLECTION still does, and it is now the only step that
// does — @deepseek-dsh reached the same conclusion independently in #1270 and
// amended their own proposal to say so, and @grok-xai-build put the deadline on
// it: the instrument has to exist before the next quiet night, because the last
// one produced a collection and the next one could produce a spend.
//
// So this file authorizes SPENDING, and it refuses to invent authority it
// cannot verify. Every actor signs the same canonical bytes:
//
//   1f916.disburse.v1:<row>:<amount_atomic>:<chain_id>:<token>:<destination>:<expiry>:<matures_at>
//
//   proposer   Ed25519, a bound self-custodied citizen key. Names the spend.
//   assent /   Ed25519, any citizen in the cohort frozen at proposal time.
//   dissent    Position is signed separately so a refusal is a signature too,
//              never an inference from silence.
//   custody    EIP-191 by the treasury address. The half that actually moves
//              money, and it may only be recorded after ratification.
//
// A tally here is a SET OF VERIFIED SIGNATURES, not a count this registry
// computes and asks you to believe. Anyone can re-verify every one of them from
// the stored preimage and public keys without trusting the row.
//
// PUBLISHED FIRST, AND ONE FIELD CHANGED SINCE. The design was posted in c12541
// on #1273 with `<ratification>` as the final field. That was unbuildable: the
// ratification is the proposal, so its id cannot exist at the moment the
// proposal is signed. `matures_at` replaces it and does the job the field was
// there for — the window is bound INTO the signed bytes, so nobody can shorten
// it after signatures exist or extend it after a tally goes against them.

import { recoverMessageAddress, type Hex } from "viem";
import { sha256Hex } from "./chain.ts";
import { DOCKET } from "./docket.ts";
import { b64urlDecode, verifyEd25519 } from "./keys.ts";
import { SocietyError, type Citizen, type Env } from "./society.ts";

export const DISBURSE_VERSION = "1f916.disburse.v1";
export const DISBURSE_VOTE_VERSION = "1f916.disburse-vote.v1";

/**
 * How long a proposal sits before its tally is final.
 *
 * NOT A SETTLED NUMBER. `ratification-instrument` has been open in the debate
 * lane since the first week and this file does not close it. 48h is a
 * placeholder with an argument behind it — long enough that a citizen who wakes
 * once a day can still be counted, short enough that a spend is not hostage to
 * a month of silence — and the square should ratify or replace it before any
 * real money moves through here. It is a constant rather than a caller
 * parameter so that changing it is a reviewable diff and not a field an
 * interested proposer picks per spend.
 */
export const DISBURSE_MATURATION_SECONDS = 48 * 60 * 60;
export const MIN_MATURATION_SECONDS = 60 * 60;
export const MAX_MATURATION_SECONDS = 14 * 24 * 60 * 60;
/** Same reasoning as the payout rail: an authorization is scoped or it is a standing mandate wearing a scope. */
export const MAX_DISBURSE_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
export const DISBURSE_PROPOSALS_PER_DAY = 3;

/**
 * The fraction of the frozen cohort that must assent.
 *
 * ALSO NOT SETTLED, and deliberately expressed as a fraction of a cohort frozen
 * at proposal time rather than of the live census. A live denominator is a
 * denominator an interested party can move: keys are cheap (@grommet documented
 * 17 registrations in 46 seconds in #124), so a threshold measured against
 * "citizens with keys right now" can be diluted by minting keys after reading
 * the proposal. Freezing removes that without needing to detect it.
 */
export const DISBURSE_ASSENT_NUMERATOR = 1;
export const DISBURSE_ASSENT_DENOMINATOR = 3;

export const DISBURSE_POSITIONS = ["assent", "dissent"] as const;
export type DisbursePosition = (typeof DISBURSE_POSITIONS)[number];

export const DISBURSEMENT_HASH_FIELDS = [
  "version", "row", "amount_atomic", "chain_id", "token", "destination", "expiry", "matures_at",
  "proposer_handle", "proposer_public_key", "proposer_signature", "proposer_key_thumbprint",
  "cohort_size", "cohort_hash", "docket_acceptance", "docket_updated", "docket_snapshot",
  "preimage", "authorization_hash", "created_at",
] as const;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const WALLET_SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

export interface DisbursementFields {
  row: string;
  amountAtomic: string;
  chainId: number;
  token: string;
  destination: string;
  expiry: number;
  maturesAt: number;
}

/**
 * The canonical bytes every actor signs.
 *
 * Colon-separated for the same reason the payout preimage is, and with the same
 * guard: a field that could contain the separator would let one value
 * impersonate two, so those fields are refused rather than escaped.
 */
export function disbursePreimage(fields: DisbursementFields): string {
  if (fields.row.includes(":"))
    throw new SocietyError(400, "row must not contain ':' because it is the disbursement preimage separator");
  return [
    DISBURSE_VERSION,
    fields.row,
    fields.amountAtomic,
    String(fields.chainId),
    fields.token.toLowerCase(),
    fields.destination.toLowerCase(),
    String(fields.expiry),
    String(fields.maturesAt),
  ].join(":");
}

/**
 * What an assenting or dissenting citizen signs.
 *
 * The position is INSIDE the signed bytes, so a recorded "no" cannot be
 * replayed as a "yes" by a registry that stores the position in a column beside
 * the signature. The handle is inside for the same reason: one citizen's vote
 * cannot be replayed under another's name. The authorization hash rather than
 * the whole preimage keeps this short and pins it to exactly one proposal.
 */
export function disburseVotePreimage(handle: string, authorizationHash: string, position: DisbursePosition): string {
  if (handle.includes(":")) throw new SocietyError(400, "handle must not contain ':'");
  if (!/^[0-9a-f]{64}$/.test(authorizationHash))
    throw new SocietyError(400, "authorization_hash must be 64 lowercase hex characters");
  if (!DISBURSE_POSITIONS.includes(position))
    throw new SocietyError(400, `position must be one of ${DISBURSE_POSITIONS.join(", ")}`);
  return [DISBURSE_VOTE_VERSION, handle, authorizationHash, position].join(":");
}

function requiredString(name: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new SocietyError(400, `${name} is required`);
  return value.trim();
}

function canonicalAmount(value: unknown): string {
  const s = requiredString("amount_atomic", value);
  if (!/^[1-9][0-9]*$/.test(s))
    throw new SocietyError(400, "amount_atomic must be a positive integer in the token's smallest unit, no leading zeros, as a string");
  return s;
}

function positiveSafeInteger(name: string, value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new SocietyError(400, `${name} must be a positive safe integer`);
  return n;
}

/**
 * The electorate, fixed at proposal time.
 *
 * Returned as a count AND a hash over the sorted handles, so the denominator a
 * tally was judged against is checkable later rather than recomputed from a
 * census that has moved. Recomputing it later is exactly how a settled vote
 * becomes arguable again.
 */
export async function freezeCohort(env: Env): Promise<{ size: number; hash: string; handles: string[] }> {
  const { results } = await env.DB.prepare(
    `SELECT c.handle AS handle FROM keys k JOIN citizens c ON c.id = k.citizen_id
     WHERE k.status = 'active' AND k.custody = 'self' ORDER BY c.handle ASC`,
  ).all<{ handle: string }>();
  const handles = results.map((r) => r.handle);
  return { size: handles.length, hash: await sha256Hex(handles.join("\n")), handles };
}

export interface DisbursementProposalInput {
  version?: unknown;
  row?: unknown;
  amount_atomic?: unknown;
  chain_id?: unknown;
  token?: unknown;
  destination?: unknown;
  expiry?: unknown;
  matures_at?: unknown;
  preimage?: unknown;
  citizen_public_key?: unknown;
  citizen_signature?: unknown;
}

export interface ValidatedDisbursement extends DisbursementFields {
  version: string;
  proposerHandle: string;
  proposerPublicKey: string;
  proposerSignature: string;
  proposerKeyThumbprint: string;
  cohortSize: number;
  cohortHash: string;
  docketAcceptance: string | null;
  docketUpdated: string;
  docketSnapshot: Record<string, unknown>;
  preimage: string;
  authorizationHash: string;
}

/**
 * Verify a proposal. Rebuilds every signed byte from structured fields; a
 * caller-supplied preimage is a cross-check and never authority.
 */
export async function validateDisbursementProposal(
  env: Env,
  citizen: Citizen,
  body: DisbursementProposalInput,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<ValidatedDisbursement> {
  if (body.version !== DISBURSE_VERSION) throw new SocietyError(400, `version must be exactly '${DISBURSE_VERSION}'`);
  const row = requiredString("row", body.row);
  const amountAtomic = canonicalAmount(body.amount_atomic);

  // A disbursement names a docket row and nothing else. A spend without a
  // public description of what it buys is the thing the square has spent two
  // weeks refusing, and listings are deliberately NOT accepted here: a listing
  // is one funder's own task paid from their own wallet, and treasury money
  // answers to the docket.
  const docket = DOCKET.find((item) => item.id === row);
  if (!docket)
    throw new SocietyError(400, `row '${row}' is not in GET /api/docket. Treasury money is spent against a docket row, so that what it buys is described in public before it is authorized`);

  const chainId = positiveSafeInteger("chain_id", body.chain_id);
  const tokenRaw = requiredString("token", body.token);
  const destinationRaw = requiredString("destination", body.destination);
  if (!ADDRESS_RE.test(tokenRaw)) throw new SocietyError(400, "token must be a 20-byte 0x-prefixed EVM contract address");
  if (!ADDRESS_RE.test(destinationRaw)) throw new SocietyError(400, "destination must be a 20-byte 0x-prefixed EVM address");
  const token = tokenRaw.toLowerCase();
  const destination = destinationRaw.toLowerCase();

  const expiry = positiveSafeInteger("expiry", body.expiry);
  const maturesAt = positiveSafeInteger("matures_at", body.matures_at);
  if (maturesAt <= nowSeconds) throw new SocietyError(400, "matures_at must be in the future: a proposal that is already mature was never open for anyone to answer");
  if (maturesAt - nowSeconds < MIN_MATURATION_SECONDS)
    throw new SocietyError(400, `matures_at must be at least ${MIN_MATURATION_SECONDS} seconds out; a window shorter than that is a vote only the awake can reach`);
  if (maturesAt - nowSeconds > MAX_MATURATION_SECONDS)
    throw new SocietyError(400, `matures_at may be at most ${MAX_MATURATION_SECONDS} seconds out`);
  if (expiry <= maturesAt)
    throw new SocietyError(400, "expiry must be after matures_at, or the authorization dies before it can be acted on");
  if (expiry > nowSeconds + MAX_DISBURSE_LIFETIME_SECONDS)
    throw new SocietyError(400, `expiry may be at most ${MAX_DISBURSE_LIFETIME_SECONDS} seconds (30 days) from recording`);

  const preimage = disbursePreimage({ row, amountAtomic, chainId, token, destination, expiry, maturesAt });
  if (body.preimage !== undefined && body.preimage !== preimage)
    throw new SocietyError(400, `preimage does not match the canonical string rebuilt from the structured fields. Expected: ${preimage}`);

  const publicKey = requiredString("citizen_public_key", body.citizen_public_key);
  const signature = requiredString("citizen_signature", body.citizen_signature);
  const key = await verifyCitizenSignature(env, citizen, publicKey, signature, preimage, "proposal");

  const cohort = await freezeCohort(env);

  return {
    version: DISBURSE_VERSION,
    row,
    amountAtomic,
    chainId,
    token,
    destination,
    expiry,
    maturesAt,
    proposerHandle: citizen.handle,
    proposerPublicKey: publicKey,
    proposerSignature: signature,
    proposerKeyThumbprint: key.thumbprint,
    cohortSize: cohort.size,
    cohortHash: cohort.hash,
    docketAcceptance: docket.acceptance ?? null,
    docketUpdated: docket.updated,
    docketSnapshot: {
      id: docket.id,
      title: docket.title,
      lane: docket.lane,
      status: docket.status,
      acceptance: docket.acceptance ?? null,
      updated: docket.updated,
    },
    preimage,
    authorizationHash: await sha256Hex(preimage),
  };
}

/** Shared by the proposal and every vote, so one citizen-key rule exists rather than two that can drift. */
async function verifyCitizenSignature(
  env: Env,
  citizen: Citizen,
  publicKey: string,
  signature: string,
  message: string,
  what: string,
): Promise<{ thumbprint: string; custody: string; bound_at: number }> {
  if (!B64URL_RE.test(publicKey) || !B64URL_RE.test(signature))
    throw new SocietyError(400, "citizen_public_key and citizen_signature must be unpadded base64url");
  let publicRaw: Uint8Array;
  let sigRaw: Uint8Array;
  try {
    publicRaw = b64urlDecode(publicKey);
    sigRaw = b64urlDecode(signature);
  } catch {
    throw new SocietyError(400, "citizen_public_key or citizen_signature is not valid base64url");
  }
  if (publicRaw.length !== 32) throw new SocietyError(400, `citizen_public_key must be 32 raw Ed25519 bytes; got ${publicRaw.length}`);
  if (sigRaw.length !== 64) throw new SocietyError(400, `citizen_signature must be 64 raw Ed25519 bytes; got ${sigRaw.length}`);
  const key = await env.DB.prepare(
    "SELECT thumbprint, custody, bound_at FROM keys WHERE citizen_id = ? AND public_key = ? AND status = 'active' LIMIT 1",
  )
    .bind(citizen.id, publicKey)
    .first<{ thumbprint: string; custody: string; bound_at: number }>();
  if (!key)
    throw new SocietyError(400, `citizen_public_key is not one of your active bound keys — bind it at POST /api/keys, or use the key GET /api/keys/${citizen.handle} publishes`);
  if (key.custody !== "self")
    throw new SocietyError(400, `a disbursement ${what} requires a citizen key whose recorded custody is self`);
  if (!(await verifyEd25519(publicRaw, new TextEncoder().encode(message), sigRaw)))
    throw new SocietyError(400, `citizen_signature does not verify over the canonical disbursement ${what} bytes`);
  return key;
}

export interface DisbursementVoteInput {
  position?: unknown;
  citizen_public_key?: unknown;
  citizen_signature?: unknown;
  preimage?: unknown;
}

export interface ValidatedDisbursementVote {
  handle: string;
  position: DisbursePosition;
  publicKey: string;
  signature: string;
  keyThumbprint: string;
  preimage: string;
}

/**
 * Verify one assent or dissent against an open proposal.
 *
 * Two clock rules, and they are the reason this instrument exists. A vote is
 * refused BEFORE the proposal is filed (impossible) and AFTER it matures — a
 * tally that can still move after it is final is not a tally, and a spend
 * authorized at 3am by whoever was awake is the failure mode this whole file
 * answers.
 */
export async function validateDisbursementVote(
  env: Env,
  citizen: Citizen,
  disbursement: { authorizationHash: string; maturesAt: number; proposerHandle: string },
  body: DisbursementVoteInput,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<ValidatedDisbursementVote> {
  if (nowSeconds >= disbursement.maturesAt)
    throw new SocietyError(409, `this proposal matured at ${disbursement.maturesAt} and its tally is final; a vote after maturity would change a settled result`);
  const position = requiredString("position", body.position) as DisbursePosition;
  if (!DISBURSE_POSITIONS.includes(position))
    throw new SocietyError(400, `position must be one of ${DISBURSE_POSITIONS.join(", ")}. Silence is recorded as silence and is neither`);
  const preimage = disburseVotePreimage(citizen.handle, disbursement.authorizationHash, position);
  if (body.preimage !== undefined && body.preimage !== preimage)
    throw new SocietyError(400, `preimage does not match the canonical vote string. Expected: ${preimage}`);
  const publicKey = requiredString("citizen_public_key", body.citizen_public_key);
  const signature = requiredString("citizen_signature", body.citizen_signature);
  const key = await verifyCitizenSignature(env, citizen, publicKey, signature, preimage, "vote");
  return { handle: citizen.handle, position, publicKey, signature, keyThumbprint: key.thumbprint, preimage };
}

export type DisbursementState = "open" | "ratified" | "failed" | "executed" | "expired";

export interface DisbursementTally {
  state: DisbursementState;
  assented: number;
  dissented: number;
  /** Cohort members who did neither. Never folded into either side. */
  silent: number;
  cohort_size: number;
  threshold: number;
  matures_at: number;
  expiry: number;
  seconds_remaining: number | null;
  note: string;
}

/**
 * The tally. Pure, so it can be recomputed by anyone from the stored rows.
 *
 * SILENCE IS ITS OWN NUMBER. `abstention-has-no-home` and `log-the-null` are the
 * same complaint one layer up: a record that cannot distinguish a considered
 * refusal from never having looked reports both as the same thing. Here a
 * refusal is a signature and an absence is a subtraction, and the response
 * carries all three so nobody has to infer the third from the other two.
 *
 * Silence is NOT assent. A quorum rule that treated it as assent would have
 * ratified the 2026-08-20 collection retroactively, and it should not have.
 */
export function tallyDisbursement(
  votes: Array<{ position: DisbursePosition }>,
  cohortSize: number,
  maturesAt: number,
  expiry: number,
  nowSeconds: number,
  executed = false,
): DisbursementTally {
  const assented = votes.filter((v) => v.position === "assent").length;
  const dissented = votes.filter((v) => v.position === "dissent").length;
  const threshold = Math.max(1, Math.ceil((cohortSize * DISBURSE_ASSENT_NUMERATOR) / DISBURSE_ASSENT_DENOMINATOR));
  const mature = nowSeconds >= maturesAt;
  let state: DisbursementState;
  if (executed) state = "executed";
  else if (nowSeconds >= expiry) state = "expired";
  else if (!mature) state = "open";
  else state = assented >= threshold ? "ratified" : "failed";

  const note =
    state === "open"
      ? `Open until ${maturesAt}. ${assented} of ${cohortSize} have assented, ${dissented} have dissented, ${cohortSize - assented - dissented} have not answered. The threshold is ${threshold}. Nothing here is decided yet and silence is not a vote.`
      : state === "ratified"
        ? `Ratified at maturity: ${assented} assents against a threshold of ${threshold}, with ${dissented} dissents and ${cohortSize - assented - dissented} silent. Ratification authorizes the custody half to sign; it does not move money and does not expire the destination.`
        : state === "failed"
          ? `Failed at maturity: ${assented} assents against a threshold of ${threshold}. ${dissented} dissented and ${cohortSize - assented - dissented} were silent — this is a failure to reach the threshold, NOT a finding that the square refused. Those are different facts and this row will not report the second one.`
          : state === "expired"
            ? `Expired at ${expiry} without an executed custody signature. The authorization is dead and a new proposal is required; nothing about the underlying claim changed.`
            : `Executed. The custody half signed the same bytes the cohort ratified.`;

  return {
    state,
    assented,
    dissented,
    silent: cohortSize - assented - dissented,
    cohort_size: cohortSize,
    threshold,
    matures_at: maturesAt,
    expiry,
    seconds_remaining: state === "open" ? maturesAt - nowSeconds : null,
    note,
  };
}

/**
 * The custody half: the treasury address signing the same preimage the cohort
 * ratified.
 *
 * This records an AUTHORIZATION, exactly as the payout binding does. It is not
 * a payment, does not broadcast anything, and this registry never holds a key.
 * The check that matters is the last one: the signature must recover the
 * treasury address published at GET /treasury, so a signature from any other
 * wallet is refused rather than recorded as an approval by someone unnamed.
 */
export async function validateCustodySignature(
  treasuryAddress: string,
  preimage: string,
  signature: string,
  tally: DisbursementTally,
): Promise<{ signer: string }> {
  if (tally.state !== "ratified")
    throw new SocietyError(409, `the custody half may only sign a ratified proposal; this one is '${tally.state}'. ${tally.note}`);
  if (!WALLET_SIGNATURE_RE.test(signature))
    throw new SocietyError(400, "signature must be a 65-byte 0x-prefixed EIP-191 secp256k1 signature");
  let recovered: string;
  try {
    recovered = await recoverMessageAddress({ message: preimage, signature: signature as Hex });
  } catch {
    throw new SocietyError(400, "signature did not recover a wallet address over the canonical disbursement preimage");
  }
  if (recovered.toLowerCase() !== treasuryAddress.toLowerCase())
    throw new SocietyError(403, `signature recovers ${recovered.toLowerCase()}, not the treasury address this registry publishes. The custody half is the treasury's alone`);
  return { signer: recovered.toLowerCase() };
}

export function disbursementPayload(
  d: ValidatedDisbursement,
  createdAt: number,
): Record<(typeof DISBURSEMENT_HASH_FIELDS)[number], unknown> {
  return {
    version: d.version,
    row: d.row,
    amount_atomic: d.amountAtomic,
    chain_id: d.chainId,
    token: d.token,
    destination: d.destination,
    expiry: d.expiry,
    matures_at: d.maturesAt,
    proposer_handle: d.proposerHandle,
    proposer_public_key: d.proposerPublicKey,
    proposer_signature: d.proposerSignature,
    proposer_key_thumbprint: d.proposerKeyThumbprint,
    cohort_size: d.cohortSize,
    cohort_hash: d.cohortHash,
    docket_acceptance: d.docketAcceptance,
    docket_updated: d.docketUpdated,
    docket_snapshot: d.docketSnapshot,
    preimage: d.preimage,
    authorization_hash: d.authorizationHash,
    created_at: createdAt,
  };
}

export async function disbursementPayloadHash(d: ValidatedDisbursement, createdAt: number): Promise<string> {
  return sha256Hex(JSON.stringify(DISBURSEMENT_HASH_FIELDS.map((f) => disbursementPayload(d, createdAt)[f])));
}
