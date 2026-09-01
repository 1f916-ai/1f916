// FUNDED: the settlement adapter for money that is actually committed.
//
// WHAT THIS FILE MAY AND MAY NOT DO. It may READ the chain and it may BUILD
// the bytes someone else signs. It may not hold a key, sign a transaction, or
// move a token, and nothing in this module takes a private key as an argument.
// That is the whole custody story: the escrow contract has no owner, no admin
// and no operator, so there is no privileged call for this code to make even
// if it wanted to. Funds leave the escrow only on a verifier's EIP-712
// signature, relayed by anyone, or as a refund to the original funder after
// the claim window.
//
// So the registry's role in a FUNDED listing is exactly the role it has in a
// PROMISE listing: publish the terms, hash them, record the evidence. The
// difference is that a reader can now check the money is really there.

import { BASE_CHAIN_ID, BASE_USDC } from "./payouts.ts";
import { SocietyError } from "./society.ts";

// Base mainnet. Set when the contract is deployed and reviewed; until then
// FUNDED stays refused at the door, and this being null is what refuses it.
export const ESCROW_ADDRESS: string | null = null;

export const ESCROW_NOTE =
  "The escrow contract has no owner, no admin, no operator and no upgrade path. This registry holds no key that can move anything out of it. Money leaves along exactly two paths: a release authorized by an EIP-712 signature from a verifier NAMED BEFORE THE WORK BEGAN, which anyone may relay and which the payee normally relays themselves; or a refund to the ORIGINAL funding address after the claim window closes, where the destination is not a parameter of the call. The amount is never a parameter either: it comes from the terms committed at funding, so a verifier signature decides WHO is paid and never HOW MUCH.";

// ---------- the EIP-712 release authorization ----------

export const RELEASE_TYPE = {
  Release: [
    { name: "listingHash", type: "bytes32" },
    { name: "awardId", type: "bytes32" },
    { name: "submissionHash", type: "bytes32" },
    { name: "payee", type: "address" },
    { name: "verdictHash", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
  ],
} as const;

export function releaseDomain(escrow: string) {
  return { name: "1F916 ListingEscrow", version: "1", chainId: BASE_CHAIN_ID, verifyingContract: escrow as `0x${string}` };
}

// THE TWO SIGNATURES ARE ONE DECISION, and this is where that is enforced.
//
// A verifier signs twice: Ed25519 over the 1f916.verdict.v1 preimage, which is
// the protocol record, and secp256k1/EIP-712 over the release, which is what
// the chain can check. Two signatures over two unrelated payloads would be two
// decisions that merely happen to agree, and a verifier could later disown
// either one. So `verdictHash` in the EIP-712 payload IS the payload hash of
// the Ed25519 verdict, and the award and submission are named in both. A
// release therefore points at exactly one protocol verdict, and a verdict that
// does not exist cannot authorize money.
export function releaseMessage(input: {
  listingHash: string;
  awardId: string;
  submissionHash: string;
  payee: string;
  verdictPayloadHash: string;
  issuedAt: number;
}) {
  return {
    listingHash: hex32(input.listingHash, "listing payload_hash"),
    awardId: hex32(input.awardId, "award id"),
    submissionHash: hex32(input.submissionHash, "submission payload_hash"),
    payee: input.payee,
    // The Ed25519 verdict's own payload hash, unchanged. This is the join.
    verdictHash: hex32(input.verdictPayloadHash, "verdict payload_hash"),
    issuedAt: input.issuedAt,
  };
}

function hex32(value: string, what: string): `0x${string}` {
  const bare = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^[0-9a-f]{64}$/i.test(bare))
    throw new SocietyError(400, `${what} must be 32 bytes of hex to enter a release authorization, and this one is ${bare.length / 2} bytes`);
  return `0x${bare.toLowerCase()}` as `0x${string}`;
}

// ---------- reading the chain ----------

export interface EscrowTerms {
  funder: string;
  token: string;
  amountPerAward: bigint;
  maxAwards: number;
  released: number;
  verifierDeadline: number;
  claimDeadline: number;
  refunded: boolean;
  committed: bigint;
}

// WHAT MAY BE DISPLAYED AS FUNDED, and the rule is deliberately strict.
//
// A listing is FUNDED only if the chain says this exact listingHash is funded
// with terms that MATCH the listing this registry serves. Not "the funder sent
// some money", not "a transaction exists": the committed amount must equal
// amount_per_award times max_awards as published, the token must be the one
// published, and the verifier set must contain the verifier the listing named.
// Anything else is a listing whose on-chain money does not stand behind its
// own terms, and calling that FUNDED would be the same lie as calling a
// binding a debt.
export function fundingDisagreement(listing: {
  payload_hash: string;
  amount_atomic: string;
  max_awards: number;
  token: string;
}, onchain: EscrowTerms | null): string | null {
  if (onchain === null || onchain.funder === "0x0000000000000000000000000000000000000000")
    return "no escrow entry exists on chain for this listing's payload hash";
  const expected = BigInt(listing.amount_atomic) * BigInt(listing.max_awards);
  const held = BigInt(onchain.maxAwards) * onchain.amountPerAward;
  if (held !== expected)
    return `the escrow committed ${held} but this listing's published terms come to ${expected}: the money on chain does not stand behind the terms served here`;
  if (onchain.amountPerAward !== BigInt(listing.amount_atomic))
    return `the escrow pays ${onchain.amountPerAward} per award and this listing publishes ${listing.amount_atomic}`;
  if (onchain.maxAwards !== listing.max_awards)
    return `the escrow allows ${onchain.maxAwards} awards and this listing publishes ${listing.max_awards}`;
  if (onchain.token.toLowerCase() !== (listing.token || BASE_USDC).toLowerCase())
    return `the escrow holds ${onchain.token} and this listing prices in ${listing.token}`;
  return null;
}
