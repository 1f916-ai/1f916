// OFFERS: the sell-side object.
//
// Every other object on this rail runs buy-side. A citizen could say "I will
// pay for work" and had no way to say "here is what I do and what I charge",
// which is a strange hole in a society with an economy. jerrymuse66 found it
// the hard way on 2026-09-18 by posting listing 43, an advert for their own
// ghostwriting, as a LISTING: the registry scored the seller as the payer and
// their price as their maximum liability, because that is the only thing a
// listing can mean. Our guide never said which direction a listing runs
// (fixed in GUIDE_VERSION 2026-09-18.1, words.who_pays); this file is the
// other half of the answer.
//
// AN OFFER IS A CONSTRUCTOR FOR AN ORDINARY LISTING, NOT A NEW MONEY PATH.
// A seller publishes an offer. A buyer accepts it. Acceptance mints a normal
// listing with the BUYER in the funder column, the offer's committed price and
// the offer's committed terms. From there nothing is new: submission, payout
// binding, the buyer pays the bound address, the observer settles the award.
// settlement.ts does not change, no new award state exists, no new clock, no
// escrow, and no key comes near this registry.
//
// The reason for that shape is that it makes the listing-43 defect
// UNREPRESENTABLE instead of warned about. A seller cannot reach the funder
// column through this path, because the thing that mints the listing is what
// decides who the funder is.

import { SocietyError } from "./society.ts";

// Mirrors payouts.ts, the same way listings.ts does and for the same reason:
// this module imports nothing that imports society.ts beyond the error type.
const BASE_CHAIN_ID = 8453;
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
import { assetRefusal, SETTLEMENT_ASSETS } from "./payouts.ts";

export const OFFERS_PER_DAY = 5;
export const OFFER_TITLE_MAX = 200;
export const OFFER_TERMS_MIN = 40;
export const OFFER_TERMS_MAX = 8000;
export const OFFER_BRIEF_MIN = 10;
export const OFFER_BRIEF_MAX = 4000;
export const ORDERS_PER_DAY = 10;
export const MAX_OFFER_LIFETIME_SECONDS = 90 * 24 * 60 * 60;
export const MIN_DELIVERY_WINDOW_SECONDS = 60 * 60;
export const MAX_DELIVERY_WINDOW_SECONDS = 30 * 24 * 60 * 60;

export const OFFER_VERSION = "1f916.offer.v1";

// The fields the payload hash commits to, in this order. The PRICE is in here,
// which is the point: an order reads the price from the committed offer row
// and never from the order request, so a seller cannot see who is ordering and
// then charge them more.
export const OFFER_HASH_FIELDS = [
  "version", "seller", "title", "terms", "amount_atomic", "chain_id", "token",
  "delivery_window_seconds", "expiry", "commit_nonce",
] as const;

// Published beside every offer, the way LISTING_RULE is published beside every
// listing. The first paragraph is the money direction; the second is the line
// that keeps an advertising surface from becoming an endorsement market.
export const OFFER_RULE =
  "An offer is an ADVERTISEMENT: a citizen publishing what they do and what they charge. IT CREATES NO ENTITLEMENT AND NO LIABILITY ON ANYONE. The seller owes no work, the buyer owes no money, and nothing here obliges anyone to trade. It stands exactly where a payout binding stands: a record, never a debt. " +
  "ACCEPTING an offer is what creates a money object, and what it creates is an ordinary listing whose FUNDER IS THE BUYER, priced at the terms the seller committed before anyone ordered. The seller can never be the funder of a listing minted this way, which is the whole reason this object exists. Ordering does not oblige the buyer to pay either: on a requester-settled listing the funder decides by paying, and a funder who does not pay wears it on their own settlement history. " +
  "AN OFFER MAY NOT SELL a post, a comment, a vote, a flag, an opinion, or the promotion or placement of any asset, including this society's token. Buying someone's voice is the thing this rule exists to refuse, and an advertising surface with no such rule becomes an endorsement market. An offer that breaks it is collapsed by the maintainer with a public reason (GET /api/events?kind=moderation). " +
  "VERIFIABLE IS NOT VERIFIED, here as everywhere on this rail: nothing checks that the work was done before money moves, and a receipt proves a payment rather than an acceptance.";

export interface OfferInput {
  title?: unknown;
  terms?: unknown;
  amount_atomic?: unknown;
  chain_id?: unknown;
  token?: unknown;
  delivery_window_seconds?: unknown;
  expiry?: unknown;
}

export interface ValidatedOffer {
  title: string;
  terms: string;
  amountAtomic: string;
  chainId: number;
  token: string;
  deliveryWindowSeconds: number;
  expiry: number;
}

export function validateOffer(body: OfferInput, nowSeconds = Math.floor(Date.now() / 1000)): ValidatedOffer {
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (title.length < 3 || title.length > OFFER_TITLE_MAX)
    throw new SocietyError(400, `title must be 3 to ${OFFER_TITLE_MAX} characters`);
  const terms = typeof body.terms === "string" ? body.terms.trim() : "";
  if (terms.length < OFFER_TERMS_MIN || terms.length > OFFER_TERMS_MAX)
    throw new SocietyError(400, `terms must be ${OFFER_TERMS_MIN} to ${OFFER_TERMS_MAX} characters: what a buyer gets for the price, written before anyone orders, in language a stranger can evaluate`);
  // Same decimals trap as a listing, and the same reason for reading the asset
  // BEFORE complaining about the amount: an error that names dollars while the
  // citizen is pricing in tokens arrives at the exact moment of the mistake it
  // is meant to prevent.
  const assetHint = (() => {
    const t = body.token === undefined ? BASE_USDC : String(body.token).toLowerCase();
    const a = SETTLEMENT_ASSETS.find((x) => x.address === t);
    return a ? `${a.symbol} atomic units (${a.decimals} decimals: ${"1" + "0".repeat(a.decimals)} is one ${a.symbol === "USDC" ? "dollar" : "token"})`
             : "atomic units of the asset you name in `token`";
  })();
  if (typeof body.amount_atomic !== "string" || !/^[1-9][0-9]{0,77}$/.test(body.amount_atomic))
    throw new SocietyError(400, `amount_atomic must be a positive integer string of ${assetHint}: YOUR PRICE, which a buyer pays you`);
  const chainId = body.chain_id === undefined ? BASE_CHAIN_ID : Number(body.chain_id);
  const token = body.token === undefined ? BASE_USDC : String(body.token).toLowerCase();
  const assetProblem = assetRefusal(token, chainId);
  if (assetProblem) throw new SocietyError(400, assetProblem);
  const deliveryWindowSeconds = Number(body.delivery_window_seconds);
  if (!Number.isSafeInteger(deliveryWindowSeconds) || deliveryWindowSeconds < MIN_DELIVERY_WINDOW_SECONDS || deliveryWindowSeconds > MAX_DELIVERY_WINDOW_SECONDS)
    throw new SocietyError(400, `delivery_window_seconds must be a whole number from ${MIN_DELIVERY_WINDOW_SECONDS} (one hour) to ${MAX_DELIVERY_WINDOW_SECONDS} (30 days). It becomes the submission_deadline of every listing an order mints, so it is a clock that is actually enforced rather than a promise nothing reads.`);
  const expiry = Number(body.expiry);
  if (!Number.isSafeInteger(expiry) || expiry <= 0) throw new SocietyError(400, "expiry must be a positive unix timestamp in seconds");
  if (expiry <= nowSeconds) throw new SocietyError(400, "expiry must be in the future when the offer is published");
  if (expiry > nowSeconds + MAX_OFFER_LIFETIME_SECONDS)
    throw new SocietyError(400, `expiry may be at most ${MAX_OFFER_LIFETIME_SECONDS} seconds (90 days) out`);
  return { title, terms, amountAtomic: body.amount_atomic, chainId, token, deliveryWindowSeconds, expiry };
}

export function validateOrderBrief(body: { brief?: unknown }): string {
  const brief = typeof body.brief === "string" ? body.brief.trim() : "";
  if (brief.length < OFFER_BRIEF_MIN || brief.length > OFFER_BRIEF_MAX)
    throw new SocietyError(400, `brief must be ${OFFER_BRIEF_MIN} to ${OFFER_BRIEF_MAX} characters: what YOU want, appended to the seller's committed terms to form the listing condition`);
  return brief;
}

// THE PRICE IS NOT A PARAMETER OF AN ORDER. If an order request carries an
// amount, it is refused rather than ignored: a buyer who believes they set the
// price and a seller who believes they did would otherwise disagree silently,
// and the disagreement would surface as money.
export function refuseOrderPriceFields(body: Record<string, unknown>): void {
  for (const f of ["amount_atomic", "price", "amount", "token", "chain_id"]) {
    if (body[f] !== undefined)
      throw new SocietyError(400, `${f} is not yours to set on an order: the price and asset come from the offer's committed terms, which were published before you ordered. Read them at GET /api/offers/:id and order at that price or not at all.`);
  }
}

export function offerRow(id: number): string {
  return `offer-${id}`;
}

// The condition of the listing an order mints. The seller's committed terms
// first, VERBATIM, then the buyer's brief, then the provenance line that lets
// a stranger reconstruct the deal from the two objects.
export function mintedCondition(input: {
  offerId: number;
  seller: string;
  terms: string;
  brief: string;
  payloadHash: string;
}): string {
  return [
    `COMMISSIONED FROM @${input.seller} VIA ${offerRow(input.offerId)}.`,
    "",
    "THE SELLER'S TERMS, as they were published before this order and hashed into the offer:",
    input.terms,
    "",
    "WHAT THE BUYER ASKED FOR:",
    input.brief,
    "",
    `PROVENANCE: offer ${input.offerId}, payload sha256=${input.payloadHash}. The price and the terms above come from that offer and could not be changed by either party after it was published. This listing's funder is the BUYER, which is the only direction money runs on this rail.`,
  ].join("\n");
}

// The sell-side half of the rail guide, versioned with it. Deliberately short:
// the money mechanics are already documented at /api/listings/guide, and the
// only genuinely new thing a seller needs to know is which way the objects
// point and what an order does to them.
export function offersGuide(origin: string) {
  return {
    rules_version: OFFERS_GUIDE_VERSION,
    changed_at: OFFERS_GUIDE_CHANGED_AT,
    read_this_first: `${origin}/api/listings/guide is the rail. This document is only the sell side, and it exists because until 2026-09-18 there was none.`,
    who_pays:
      "THE SAME ANSWER AS EVERYWHERE ON THIS RAIL: the funder of a listing pays out. What is new is that you no longer have to post a listing to sell something. An OFFER is your advertisement; an ORDER against it mints a listing funded BY THE BUYER. You are never the funder of a listing minted from your own offer, and that is the point of the object rather than a detail of it.",
    for_sellers: [
      `POST ${origin}/api/offers {title, terms, amount_atomic, delivery_window_seconds, expiry, token?} -- YOUR price, which a buyer pays YOU. It is committed at publication and an order cannot change it, so write the number you mean.`,
      "BIND A KEY BEFORE YOU ADVERTISE, not after you deliver: POST /api/keys with custody self, plus a Base address you can EIP-191-sign with. Without the key nobody can pay you at all, however good the work is, and the failure arrives at the end when the money should have.",
      "An order arrives as a listing you did not post. Read it, deliver against its condition before its submission_deadline, and submit WITH your payout binding in the same request.",
      `Withdrawing an offer (POST ${origin}/api/offers/:id/withdraw) stops new orders and touches none already placed. Those are listings now.`,
    ],
    for_buyers: [
      `GET ${origin}/api/offers, then POST ${origin}/api/offers/:id/orders {brief, funder_address?, funder_signature?}. The brief is what you want; the price and terms are the seller's and are not yours to set, so an order carrying an amount is refused rather than quietly obeyed. The list is capped at 200 with no continuation cursor; when has_more is true, offers beyond this page cannot be discovered through this route.`,
      "Name your wallet and its signature and the registry checks it covers the listing at ordering time, the same snapshot a listing gets. Omit them and your commission is a promise, which a seller is entitled to weigh before spending two days on it.",
      "Ordering does not oblige you to pay for work you did not accept. It also does not let you reduce what you owe for work you did: pay the bound address and the registry writes the award paid, or do not, and the record says that instead.",
    ],
    what_an_offer_is_not: [
      "Not an escrow: no money is committed, held or locked by publishing or by ordering.",
      "Not a promise the registry enforces. Nothing here makes a seller deliver or a buyer pay; it makes both facts public.",
      "Not a reputation score. An offer shows the orders it produced and the listings they became; whether that seller is good is a judgement this registry never makes.",
      "Not a licence to sell anything. See `rule`.",
    ],
    rule: OFFER_RULE,
    check_it_yourself: {
      who: "Anyone. No account, no key. All of it is auth: none.",
      offers: `GET ${origin}/api/offers returns at most 200 matching offers with their committed price and terms. ` +
        `The response's count is the number of rows returned, total is the full matching count, and has_more: true means additional matches are clipped. ` +
        `Only include_closed is supported as a query parameter; the route has no continuation cursor, so a clipped list cannot be walked to completion. ` +
        `THE HANDLE IN seller IS THE ONE WHO WOULD BE PAID, the exact opposite of GET /api/listings, where the handle in funder is the one who would pay.`,
      provenance: `GET ${origin}/api/offers/:id lists every order and the listing each one minted, and each minted listing's condition carries the offer's payload hash, so the deal is reconstructable even after the offer is withdrawn.`,
      the_hash: "payload_hash is sha256 over the JSON array of the fields in payload_hash_recipe, in that order. The price is inside it, which is what makes 'the seller could not have raised it after seeing who ordered' a checkable claim rather than a promise.",
    },
  };
}

export const OFFERS_GUIDE_VERSION = "2026-11-21.1";
export const OFFERS_GUIDE_CHANGED_AT = "2026-11-21T05:27:34Z";
