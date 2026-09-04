// fundingDisagreement: the per-term checks that the product check masks.
//
// The mutation audit of 2026-09-04 deleted the amountPerAward and maxAwards
// comparisons in src/funded.ts fundingDisagreement and the suite stayed
// green. The reason is arithmetic: the check before them compares
// maxAwards * amountPerAward against the listing's total, and every existing
// test bent one factor without keeping the product, so the total check
// caught it first and the two per-term checks were never the one that fired.
//
// The case that reaches them is an escrow holding the RIGHT total split the
// WRONG way: $15 as 1 x $15 against a listing that promises 3 x $5. The total
// stands behind the terms and the terms are still not the terms published,
// because the third worker would find nothing to release. Each test names
// its killing mutation.

import test from "node:test";
import assert from "node:assert/strict";
import { fundingDisagreement, readEscrow, type EscrowTerms } from "../src/funded.ts";

const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

const terms = (over: Partial<EscrowTerms> = {}): EscrowTerms => ({
  funder: "0xF00D000000000000000000000000000000000000",
  token: USDC,
  amountPerAward: 5_000_000n,
  maxAwards: 3,
  released: 0,
  verifierDeadline: 1,
  claimDeadline: 2,
  refunded: false,
  committed: 15_000_000n,
  verifierSet: "0x" + "ab".repeat(32),
  ...over,
});

const listing = { payload_hash: "52".repeat(32), amount_atomic: "5000000", max_awards: 3, token: USDC };

test("the fixture agrees, so each disagreement below is the one term it changes", () => {
  assert.equal(fundingDisagreement(listing, terms()), null);
});

test("the same total split into fewer, larger awards is a disagreement on the per-award amount", () => {
  // KILLING MUTATION: src/funded.ts fundingDisagreement,
  // `if (onchain.amountPerAward !== BigInt(listing.amount_atomic))` -> `if (false)`.
  // 1 x $15 against 3 x $5: the product check passes, this is the only line
  // that can refuse it, and it must name the per-award figure.
  const found = fundingDisagreement(listing, terms({ amountPerAward: 15_000_000n, maxAwards: 1 }));
  assert.match(String(found), /pays 15000000 per award and this listing publishes 5000000/);
});

test("the same total split into more, smaller awards is a disagreement on the per-award amount too", () => {
  // Same killing mutation, the other direction: 5 x $3 against 3 x $5.
  const more = fundingDisagreement(listing, terms({ amountPerAward: 3_000_000n, maxAwards: 5 }));
  assert.match(String(more), /pays 3000000 per award and this listing publishes 5000000/);
});

// NOT TESTED, ON PURPOSE: the line after it, `if (onchain.maxAwards !==
// listing.max_awards)`, cannot be reached. It runs only after the product
// check (maxAwards * amountPerAward == amount * max_awards) and the per-award
// check (amountPerAward == amount) have both passed, and with a positive
// amount those two together force maxAwards == max_awards. The audit's
// mutation of that line survives every possible input, which is a statement
// about arithmetic and not about coverage; it stays as defence in depth
// against a future change to the order of the checks above it.
test("readEscrow returns null, not a partial record, when a verifierAuthority word is malformed", async () => {
  // KILLING MUTATION: src/funded.ts readEscrow, `if (!/^0x[0-9a-fA-F]{128}$/
  // .test(got)) return null;` -> `if (false) return null;`. The reader then
  // slices cap and used out of whatever bytes came back and serves a
  // verifier authority that no contract stated. A read that failed is not a
  // listing that is funded, and a half-read is a read that failed.
  const wordOf = (n: bigint | string) => (typeof n === "string" ? n.replace(/^0x/, "").padStart(64, "0") : n.toString(16).padStart(64, "0"));
  const listingOf = "0x" + [
    wordOf("F00D000000000000000000000000000000000000"), wordOf(USDC.slice(2)), wordOf(5_000_000n), wordOf(3n), wordOf(0n),
    wordOf(1n), wordOf(2n), wordOf(0n), wordOf(15_000_000n), "ab".repeat(32),
  ].join("");
  let calls = 0;
  const rpcCall = async (_to: string, _data: string) => {
    calls += 1;
    return calls === 1 ? listingOf : "0x1234"; // the authority word is 2 bytes, not 64
  };
  const got = await readEscrow(rpcCall, "0x" + "e".repeat(40), "52".repeat(32), "0xF00D000000000000000000000000000000000000", ["0x" + "c".repeat(40)]);
  assert.equal(got, null, "a malformed authority word means the escrow could not be read");
  assert.equal(calls, 2, "the listing word was read and the authority word was asked for once");

  // The control: a well-formed authority word reads through.
  calls = 0;
  const okCall = async () => { calls += 1; return calls === 1 ? listingOf : "0x" + wordOf(1n) + wordOf(0n); };
  const ok = await readEscrow(okCall, "0x" + "e".repeat(40), "52".repeat(32), "0xF00D000000000000000000000000000000000000", ["0x" + "c".repeat(40)]);
  assert.deepEqual(ok?.verifierAuthority, [{ address: "0x" + "c".repeat(40), cap: 1, used: 0 }]);
  assert.equal(ok?.onchain?.maxAwards, 3);
});

test("a matching split at a different scale still agrees, so the per-award check is about the term and not the total", () => {
  const two = { ...listing, max_awards: 2, amount_atomic: "7500000" };
  assert.equal(fundingDisagreement(two, terms({ amountPerAward: 7_500_000n, maxAwards: 2 })), null);
  assert.match(String(fundingDisagreement(two, terms({ amountPerAward: 5_000_000n, maxAwards: 3 }))), /pays 5000000 per award and this listing publishes 7500000/);
});
