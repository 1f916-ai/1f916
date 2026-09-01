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
    // WHOSE ESCROW. Escrows are keyed by (listingHash, funder), so a signature
    // that named only the hash left the relayer to choose which escrow it
    // spent: an attacker could escrow the same listing with a worthless token,
    // collect verdicts against that, and replay them onto the honest funder.
    { name: "funder", type: "address" },
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
  funder: string;
  awardId: string;
  submissionHash: string;
  payee: string;
  verdictPayloadHash: string;
  issuedAt: number;
}) {
  return {
    listingHash: hex32(input.listingHash, "listing payload_hash"),
    funder: input.funder,
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
// ---------- reading the escrow ----------

// The ABI slice this registry uses. READ-ONLY BY CONSTRUCTION: `listingOf` and
// `verifierAuthority` are the only entries, so this module cannot encode a
// call that changes anything even by mistake. fund(), release() and refund()
// are deliberately absent.
export const ESCROW_READ_ABI = [
  {
    type: "function", name: "listingOf", stateMutability: "view",
    // THE PAIR, not the hash alone. An escrow is keyed by (listingHash,
    // funder), so a reader that asked by hash would be asking a question with
    // more than one answer and taking whichever squatter answered first.
    inputs: [{ name: "listingHash", type: "bytes32" }, { name: "fundedBy", type: "address" }],
    outputs: [
      { name: "funder", type: "address" }, { name: "token", type: "address" },
      { name: "amountPerAward", type: "uint256" }, { name: "maxAwards", type: "uint32" },
      { name: "released", type: "uint32" }, { name: "verifierDeadline", type: "uint64" },
      { name: "claimDeadline", type: "uint64" }, { name: "refunded", type: "bool" },
      { name: "committed", type: "uint256" },
    ],
  },
  {
    type: "function", name: "verifierAuthority", stateMutability: "view",
    inputs: [{ name: "listingHash", type: "bytes32" }, { name: "funder", type: "address" }, { name: "who", type: "address" }],
    outputs: [{ name: "cap", type: "uint32" }, { name: "used", type: "uint32" }],
  },
] as const;

export interface FundedTerms {
  escrow_chain_id: number;
  escrow_address: string;
  escrow_token: string;
  verifier_evm_addresses: string[];
  verifier_caps: number[];
  escrow_verifier_deadline: number;
  escrow_claim_deadline: number;
}

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
  // A REFUNDED ESCROW HOLDS NOTHING, and this check belongs here rather than
  // only in the wider one below. Both are exported; a caller who reached for
  // the narrower would have read a fully refunded listing as agreeing with
  // its terms and displayed it as funded.
  if (onchain.refunded)
    return "the escrow has already been refunded to its funder, so nothing stands behind this listing any more";
  return null;
}

// THE FULL CHECK, over everything a v3 listing hashes.
//
// The site may display FUNDED only when every one of these agrees. The rule is
// not "a transaction exists" or "the funder sent something": it is that the
// on-chain commitment matches the immutable terms this registry published,
// field for field. A listing whose escrow disagrees with its own terms is a
// listing whose money does not stand behind what it says, and calling that
// FUNDED would be the same lie as calling a payout binding a debt.
//
// Every disagreement is RETURNED AS A SENTENCE, not a boolean, because the
// reader who needs this most is the worker deciding whether to do the work.
export function fundedDisagreements(
  listing: { payload_hash: string; amount_atomic: string; max_awards: number; token: string; chain_id: number } & FundedTerms,
  chain: {
    chainId: number;
    escrowAddress: string;
    onchain: EscrowTerms | null;
    verifierAuthority: { address: string; cap: number; used: number }[];
    funderAddress: string | null;
  },
): string[] {
  const out: string[] = [];
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

  if (chain.chainId !== listing.escrow_chain_id)
    out.push(`this listing commits to chain ${listing.escrow_chain_id} and the reader is on chain ${chain.chainId}`);
  if (!same(chain.escrowAddress, listing.escrow_address))
    out.push(`this listing commits to escrow ${listing.escrow_address} and the reader queried ${chain.escrowAddress}`);

  const base = fundingDisagreement(listing, chain.onchain);
  if (base) out.push(base);
  if (chain.onchain === null) return out;

  if (!same(chain.onchain.token, listing.escrow_token))
    out.push(`the escrow holds ${chain.onchain.token} and this listing commits to ${listing.escrow_token}`);
  if (chain.onchain.verifierDeadline !== listing.escrow_verifier_deadline)
    out.push(`the escrow's verifier deadline is ${chain.onchain.verifierDeadline} and this listing published ${listing.escrow_verifier_deadline}`);
  if (chain.onchain.claimDeadline !== listing.escrow_claim_deadline)
    out.push(`the escrow's claim deadline is ${chain.onchain.claimDeadline} and this listing published ${listing.escrow_claim_deadline}`);
  // THE FUNDER MUST BE DECLARED, not merely checked when present. With a
  // nullable funder this guard was `if (funderAddress && ...)`, so a listing
  // that published no funder wallet could be escrowed by a STRANGER with
  // exactly correct terms: every other field agreed, the site displayed
  // FUNDED, and the unreleased remainder refunded to the stranger rather than
  // to the party the listing represented as backing it. Awards still paid, so
  // this was a claim on the leftovers rather than on worker money, which is
  // precisely the kind of finding that survives a casual read.
  if (!chain.funderAddress)
    out.push("this listing declares no funder wallet, so there is nothing to check the escrow's funder against and no way to tell the declared backer from a stranger who escrowed the same terms");
  else if (!same(chain.onchain.funder, chain.funderAddress))
    out.push(`the escrow was funded by ${chain.onchain.funder} and this listing names funder wallet ${chain.funderAddress}`);
  if (chain.onchain.refunded)
    out.push("the escrow has already been refunded to its funder, so nothing stands behind this listing any more");

  // EVERY NAMED VERIFIER, AND NO OTHERS. A verifier the listing did not name
  // but the escrow authorized is the more dangerous direction: it is a party
  // who can release this listing's money without appearing in the document the
  // work was done against.
  const named = new Set(listing.verifier_evm_addresses.map((a) => a.toLowerCase()));
  for (let i = 0; i < listing.verifier_evm_addresses.length; i++) {
    const addr = listing.verifier_evm_addresses[i];
    const onchainAuth = chain.verifierAuthority.find((v) => same(v.address, addr));
    if (!onchainAuth || onchainAuth.cap === 0) {
      out.push(`this listing names verifier ${addr} and the escrow gives that address no authority at all`);
      continue;
    }
    if (onchainAuth.cap !== listing.verifier_caps[i])
      out.push(`this listing gives verifier ${addr} a cap of ${listing.verifier_caps[i]} and the escrow gives it ${onchainAuth.cap}`);
  }
  for (const auth of chain.verifierAuthority)
    if (auth.cap > 0 && !named.has(auth.address.toLowerCase()))
      out.push(`the escrow authorizes ${auth.address} to release this listing's money and this listing never named them`);

  return out;
}

// What a worker is entitled to be told before doing the work, in one sentence
// emitted from the same check that decides it.
export function fundingStatement(disagreements: string[], onchain: EscrowTerms | null): string {
  if (disagreements.length > 0)
    return `NOT FUNDED, and this is not a delay: the money on chain does not match this listing's published terms. ${disagreements.join("; ")}. Treat this listing as a promise and nothing more until it agrees with itself.`;
  const remaining = onchain ? BigInt(onchain.maxAwards - onchain.released) * onchain.amountPerAward : 0n;
  return `FUNDED. ${remaining} atomic units are committed in the escrow named in this listing's own hashed terms, and this registry cannot move any of it. Release needs a signature from a verifier this listing named before the work began, and anyone may relay it.`;
}
