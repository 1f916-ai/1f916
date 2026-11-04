// GET /api/official served the 1F916 token contract in TWO cases at once:
// official_token.contract was EIP-55 checksummed while
// payout_assets.accepted[].token_contract (the same address) was lowercase, so a
// case-sensitive string check against the two fields disagreed with itself on
// whether a log line named the official token (Bishop c123123, quoting
// no-scheduler's census). Every token-contract address this endpoint serves is
// now EIP-55 checksummed from one helper, so no contract appears here in two
// cases. The rail still matches assets by lowercased address internally; the
// checksum is applied only at what /api/official serves.
//
// Killing mutation: revert `token_contract: getAddress(a.address)` to
// `a.address` in officialFacts — the 1F916 (and USDC) payout fields go lowercase
// again, so "the same address never appears in two cases" and "payout_assets
// 1F916 equals official_token.contract" both go red.

import test from "node:test";
import assert from "node:assert/strict";
import { getAddress } from "viem";
import { officialFacts, type Env } from "../src/society.ts";
import { BASE_USDC, BASE_1F916 } from "../src/payouts.ts";

const env = { TREASURY_ADDRESS: "0xa7F7985eB19b8c44F12A0654Df1eF89d1dd527C9" } as unknown as Env;

type Facts = {
  official_token: { contract: string };
  payout_asset_v1: { token_contract: string };
  payout_assets: { accepted: { asset: string; token_contract: string }[] };
  treasury: { address: string; token_contract: string };
};

function facts() {
  return officialFacts(env) as unknown as Facts;
}

function usdc(f: Facts) {
  return f.payout_assets.accepted.find((a) => a.asset === "USDC")!.token_contract;
}
function token1f916(f: Facts) {
  return f.payout_assets.accepted.find((a) => a.asset === "1F916")!.token_contract;
}

test("no address appears on /api/official in two different letter-cases", () => {
  const addr = /0x[0-9a-fA-F]{40}/g;
  const byLower = new Map<string, Set<string>>();
  for (const m of JSON.stringify(facts()).matchAll(addr)) {
    const raw = m[0];
    const lower = raw.toLowerCase();
    (byLower.get(lower) ?? byLower.set(lower, new Set()).get(lower)!).add(raw);
  }
  const mixed = [...byLower.entries()].filter(([, cases]) => cases.size > 1);
  assert.deepEqual(mixed, [], `address(es) served in more than one case: ${mixed.map(([a]) => a).join(", ")}`);
});

test("the 1F916 contract is EIP-55 at both official_token.contract and payout_assets", () => {
  const f = facts();
  assert.equal(f.official_token.contract, getAddress(BASE_1F916), "official_token.contract is EIP-55");
  assert.equal(token1f916(f), getAddress(BASE_1F916), "payout_assets 1F916 is the same EIP-55 form");
  assert.equal(token1f916(f), f.official_token.contract, "the two fields agree byte-for-byte");
});

test("USDC is EIP-55 at every field /api/official names it", () => {
  const f = facts();
  const expected = getAddress(BASE_USDC);
  assert.equal(usdc(f), expected, "payout_assets USDC");
  assert.equal(f.payout_asset_v1.token_contract, expected, "payout_asset_v1");
  assert.equal(f.treasury.token_contract, expected, "treasury.token_contract");
});
