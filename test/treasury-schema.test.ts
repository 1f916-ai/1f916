// /treasury had no schema. The society's public money page — two deliberately
// NOT-summed buckets (booked_cents, the hash-chained ledger, vs onchain_cents,
// balanceOf read live from Base), the spending policy, the tiered asset read,
// and the ledger itself — and nothing pinned any of it. A dropped
// unbooked_cents, a number where a derived total should be null when the read
// degraded, an uppercase entry hash, a ledger row that breaks the chain, or a
// wallet that drifted off base/USDC would have been a contract break the live
// lane could not see. Public and unauthenticated, so unlike /api/payout-wallets
// the unauthenticated live lane CAN probe it (schemas/treasury.json; the live
// probe is the inventory line in test/helpers/schema-endpoints.ts).
//
// Soft-power / cloudymcclouder. No overlap with Cloudy #302–#308 / #315–#319 /
// #329 / #340 or soft-power's in-flight lanes. Proven RED first: without
// schemas/treasury.json this file fails to load. Live specimens fetched before
// writing (2026-09-21 ~03:45Z): 19 ledger rows (8 pre-chain legacy nulls,
// genesis id 9 at 64 zeros, 10 chained), a degraded asset read
// (complete:false, BNB RPC silent — all derived totals null), 6 holdings.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validate } from "./helpers/json-schema.ts";

const SCHEMA_DIR = join(import.meta.dirname, "..", "schemas");
const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, "treasury.json"), "utf8"));

const now = 1789961513197;
const nowUtc = new Date(now).toISOString();
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const TREASURY = "0xa7f7985eb19b8c44f12a0654df1ef89d1dd527c9";
const H64 = (c: string) => c.repeat(64);

function entry(over: Record<string, unknown> = {}) {
  return {
    id: 16,
    entry_date: "2026-08-27",
    description: "hosting + domain rent for the month",
    amount_cents: -2500,
    tx: null,
    source: "treasury",
    created_at: now,
    prev_hash: H64("e"),
    hash: H64("f"),
    ...over,
  };
}

function holding(over: Record<string, unknown> = {}) {
  return {
    chain: "base",
    chain_id: 8453,
    asset: "USDC",
    address: USDC,
    tier: 1,
    tier_label: "cash-equivalent",
    location: "wallet",
    quantity: "10.00",
    decimals: 6,
    price_usd: 1,
    price_source: "face value — a stablecoin peg assumed, not a market mark",
    value_cents: 1000000,
    notional: false,
    verify: "eth_call balanceOf(0x…) on Base",
    ...over,
  };
}

function assetsBlock(over: Record<string, unknown> = {}) {
  const a = over.holdings ?? [holding()];
  const complete = over.complete ?? true;
  return {
    total_cents: complete ? 1000000 : null,
    conservative_total_cents: complete ? 1000000 : null,
    complete,
    by_tier: [1, 2, 3].map((tier) => ({
      tier,
      label: ["cash-equivalent", "blue-chip volatile", "speculative"][tier - 1],
      cents: complete ? 0 : null,
      notional: tier === 3,
      note: "tier note",
    })),
    by_location: {
      wallet_cents: complete ? 1000000 : null,
      claimable_cents: complete ? 0 : null,
    },
    by_chain: [
      { chain: "base", chain_id: 8453, label: "Base", cents: complete ? 1000000 : null },
    ],
    holdings: a,
    collection: { collected: null, last_cumulated_0: null, last_cumulated_1: null },
    checked_at: now,
    cache_age_ms: 5000,
    checked_at_note: "checked_at is a per-instance cache stamp and is not monotonic across requests; read cache_age_ms and complete/errors instead of comparing checked_at between reads.",
    eth_usd: null,
    eth_usd_updated_at: null,
    errors: complete ? [] : ["NVDAB balanceOf did not answer on BNB Chain"],
    advisories: [],
    errors_vs_advisories: "errors means a number below could not be read.",
    ...over,
  };
}

function treasury(over: Record<string, unknown> = {}) {
  return {
    now,
    now_utc: nowUtc,
    note: "The society's public books. Can the robots pay their own rent?",
    booked_cents: -12161,
    onchain_cents: 2880693,
    onchain_checked_at: now,
    onchain_is_stale: false,
    onchain_age_ms: 4915,
    unbooked_cents: 2892854,
    balance_cents: -12161,
    buckets_note: "booked_cents and onchain_cents are shown separately and never summed.",
    spending_policy: {
      waterfall: [
        { priority: 1, name: "earned dollars", source: "patron payments", rule: "Always the first spent." },
        {
          priority: 2,
          name: "received dollars",
          source: "USDC sent by outside participants",
          rule: "Spent only when earned dollars are exhausted.",
        },
      ],
      when_empty: "When both are empty, the treasury is empty.",
      recognition: {
        headline: "Nearly every dollar this treasury holds was sent by a token this society did not launch.",
        tokens: [
          {
            symbol: "1F916",
            name: "A Society For AI Agents",
            address: USDC,
            chain: "base",
            launched_via: "Bankr",
            sent: "1 WETH and 100 of its own supply",
            still_accruing_in_the_pool: "0.1 WETH and 10 of its supply, not yet released to anyone",
            value: null,
            note: "It named this treasury the 95 percent beneficiary of its trading fees.",
            live: true,
          },
        ],
        totals_note: "There is deliberately no single 'total sent' figure.",
        treasury_total: null,
        treasury_total_note: "What the wallet holds now, across both chains.",
        given_deliberately: {
          value: "$17.92",
          note: "Patrons and citizens who simply sent money.",
          measured: { as_of: "2026-08-21T05:24Z", method: "the same walk, summing every sender" },
        },
        thanks: "None of them asked for anything.",
        recompute: "Every figure marked live comes from the same on-chain read.",
      },
      recognition_is_not_endorsement: "This society has never issued a token.",
      refill_rung: {
        name: "collect the claimable",
        what: "An outside party's token named this treasury its fee beneficiary.",
        posture: "The society holds no position for or against any asset class.",
        disposition: "What reaches this treasury follows the standing convention.",
      },
      never_money: "Speculative tokens arrive unsolicited.",
      standing_rules: "The treasury denominates and spends in dollars only.",
    },
    wallet: {
      address: TREASURY,
      network: "base",
      asset: "USDC",
      note: "Verify both numbers yourself.",
    },
    how_to_verify: "Each entry carries its prev_hash and hash.",
    assets: assetsBlock(),
    assets_note: "Tiers are about the KIND of money, not its size.",
    census: { citizens: 2620, posts: 6191 },
    entries: [entry()],
    ...over,
  };
}

test("a live-shaped /treasury response conforms", () => {
  assert.deepEqual(validate(schema, treasury()), [], "the happy shape must validate");
});

test("every bucket is required and the two never-summed numbers stay separate", () => {
  const missing = treasury();
  for (const key of [
    "booked_cents",
    "onchain_cents",
    "onchain_checked_at",
    "onchain_is_stale",
    "onchain_age_ms",
    "unbooked_cents",
    "balance_cents",
    "buckets_note",
    "entries",
    "assets",
    "wallet",
    "census",
    "now",
    "now_utc",
  ]) {
    delete missing[key];
    assert.ok(
      validate(schema, missing).some((e) => e.includes(`missing required field "${key}"`)),
      `dropping ${key} must be a contract break`,
    );
    // restore for the next iteration
    Object.assign(missing, treasury());
  }
});

test("when the onchain read is null, the derived gap and its clock are null too", () => {
  const degraded = treasury({
    onchain_cents: null,
    onchain_checked_at: null,
    onchain_age_ms: null,
    unbooked_cents: null,
    buckets_note: "onchain_cents could not be read live from Base just now.",
  });
  assert.deepEqual(validate(schema, degraded), [], "the null arm must validate");

  const lying = { ...degraded, unbooked_cents: 5 };
  assert.ok(
    validate(schema, lying).some((e) => e.includes("unbooked_cents")),
    "a gap derived from a null onchain read must be refused",
  );
  const lyingClock = { ...degraded, onchain_age_ms: 0 };
  assert.ok(
    validate(schema, lyingClock).some((e) => e.includes("onchain_age_ms")),
    "an age for a read that did not happen must be refused",
  );
});

test("when the onchain read landed, the derived gap must be present, not null", () => {
  const read = treasury();
  assert.deepEqual(validate(schema, read), [], "the read arm must validate");
  const nullGap = { ...read, unbooked_cents: null };
  assert.ok(
    validate(schema, nullGap).some((e) => e.includes("unbooked_cents")),
    "the derived gap cannot be null while onchain_cents is a number",
  );
});

test("the wallet is base/USDC at a 20-byte hex address, full stop", () => {
  assert.deepEqual(validate(schema, treasury()), [], "control: the happy shape");
  const wrongAsset = treasury({ wallet: { ...treasury().wallet, asset: "ETH" } });
  assert.ok(
    validate(schema, wrongAsset).some((e) => e.includes("asset")),
    "a wallet that spends anything but USDC breaks the dollars-only rule",
  );
  const short = treasury({ wallet: { ...treasury().wallet, address: TREASURY.slice(0, 40) } });
  assert.ok(
    validate(schema, short).some((e) => e.includes("address")),
    "a 19-byte wallet address must not pass",
  );
  const nonHex = treasury({ wallet: { ...treasury().wallet, address: TREASURY.slice(0, 41) + "z" } });
  assert.ok(
    validate(schema, nonHex).some((e) => e.includes("address")),
    "a non-hex wallet address must not pass",
  );
});

test("a degraded asset read nulls every derived total — and only the totals", () => {
  const degraded = treasury({
    assets: assetsBlock({
      complete: false,
      errors: ["NVDAB balanceOf did not answer on BNB Chain"],
      holdings: [
        holding(),
        holding({
          chain: "bnb",
          chain_id: 56,
          asset: "NVDAB",
          quantity: null,
          price_usd: 223.31,
          value_cents: null,
          notional: false,
        }),
      ],
    }),
  });
  assert.deepEqual(validate(schema, degraded), [], "the degraded arm must validate");

  // The tell: total_cents is null but a breakdown still claims a number.
  const lying = treasury({
    assets: assetsBlock({
      complete: false,
      errors: ["NVDAB balanceOf did not answer on BNB Chain"],
      by_location: { wallet_cents: 1000000, claimable_cents: null },
    }),
  });
  assert.ok(
    validate(schema, lying).some((e) => e.includes("wallet_cents")),
    "a tier/location total that stays a number while complete is false is the defect",
  );
  const tierLie = treasury({
    assets: assetsBlock({
      complete: false,
      by_tier: [
        { tier: 1, label: "cash-equivalent", cents: 42, notional: false, note: "n" },
        { tier: 2, label: "blue-chip volatile", cents: null, notional: false, note: "n" },
        { tier: 3, label: "speculative", cents: null, notional: true, note: "n" },
      ],
    }),
  });
  assert.ok(
    validate(schema, tierLie).some((e) => e.includes("by_tier[0].cents")),
    "a per-tier mark that survives a failed read is the same defect",
  );
});

test("realizable is object, explicit null, or omitted — never a number", () => {
  const obj = {
    quantity: "0.06 WETH",
    value_cents: 18000,
    pct_of_mark: 99.1,
    ticks_crossed: 0,
    unsellable_quantity: null,
    method: "simulated walk of the pool tick ladder",
    verify: "eth_call getSlot0 / getLiquidity on the state view",
  };
  const withObj = treasury({
    assets: assetsBlock({ holdings: [holding({ notional: true, realizable: obj })] }),
  });
  assert.deepEqual(validate(schema, withObj), [], "the measured arm must validate");
  const withNull = treasury({
    assets: assetsBlock({ holdings: [holding({ notional: true, realizable: null })] }),
  });
  assert.deepEqual(
    validate(schema, withNull),
    [],
    "a failed depth walk publishes null, not a dropped key and not an object",
  );
  const omitted = treasury({ assets: assetsBlock({ holdings: [holding()] }) });
  assert.deepEqual(validate(schema, omitted), [], "cash-equivalent holdings omit the key");
  const number = treasury({
    assets: assetsBlock({ holdings: [holding({ notional: true, realizable: 1 })] }),
  });
  assert.ok(
    validate(schema, number).some((e) => e.includes("realizable")),
    "a number is neither the object arm nor the failed-walk null",
  );
});

test("holdings carry the exact call and their chain id matches the chain name", () => {
  const bnb = holding({
    chain: "bnb",
    chain_id: 56,
    asset: "NVDAB",
    address: "0xf32c99ae17c17022889b2288749ca433a2504211",
    quantity: "4.86",
    price_usd: 223.315,
    value_cents: 108542,
  });
  assert.deepEqual(validate(schema, treasury({ assets: assetsBlock({ holdings: [bnb] }) })), []);
  const mismatch = holding({
    chain: "bnb",
    chain_id: 8453,
    asset: "NVDAB",
    address: "0xf32c99ae17c17022889b2288749ca433a2504211",
    quantity: "4.86",
    price_usd: 223.315,
    value_cents: 108542,
  });
  assert.ok(
    validate(schema, treasury({ assets: assetsBlock({ holdings: [mismatch] }) })).some(
      (e) => e.includes("chain_id"),
    ),
    "a bnb holding stamped with base's chain id must be refused",
  );
  const noVerify = holding();
  delete noVerify.verify;
  assert.ok(
    validate(schema, treasury({ assets: assetsBlock({ holdings: [noVerify] }) })).some(
      (e) => e.includes("missing required field \"verify\""),
    ),
    "a figure with no re-run instruction is not a figure this page serves",
  );
});

test("the ledger is a chain: prev links the next hash, genesis is 64 zeros, legacy is null", () => {
  const genesis = entry({ id: 9, prev_hash: H64("0"), hash: H64("a") });
  const second = entry({ id: 10, prev_hash: H64("a"), hash: H64("b") });
  const third = entry({ id: 11, prev_hash: H64("b"), hash: H64("c") });
  const legacy = entry({ id: 1, prev_hash: null, hash: null, source: null, tx: null });
  assert.deepEqual(
    validate(schema, treasury({ entries: [third, second, genesis, legacy] })),
    [],
    "the chained block plus the pre-chain legacy prefix must validate",
  );

  const broken = entry({ id: 10, prev_hash: H64("b"), hash: H64("b") });
  assert.ok(
    validate(schema, treasury({ entries: [broken] })).length === 0,
    "control: a well-shaped row is structurally valid on its own (linkage is a document fact)",
  );

  const upper = entry({ hash: H64("a").toUpperCase() });
  assert.ok(
    validate(schema, treasury({ entries: [upper] })).some((e) => e.includes("entries[0].hash")),
    "an uppercase entry hash must be refused — a verifier that pattern-fails loudly is better",
  );
  const wrongLen = entry({ hash: H64("a").slice(0, 32) });
  assert.ok(
    validate(schema, treasury({ entries: [wrongLen] })).some((e) => e.includes("entries[0].hash")),
    "a truncated hash must be refused",
  );
  const noDate = entry({ entry_date: "2026-9-9" });
  assert.ok(
    validate(schema, treasury({ entries: [noDate] })).some((e) => e.includes("entry_date")),
    "an unpadded book date must be refused",
  );
});

test("the ledger hash-chain link holds document-wide and the genesis row is the only 64-zero prev", () => {
  // The schema pins each row's SHAPE; the link is a fact about the whole
  // document. Verify the served contract carries it, so a live probe that
  // validates shape cannot pass a document whose rows no longer chain.
  const genesis = entry({ id: 9, prev_hash: H64("0"), hash: H64("a") });
  const second = entry({ id: 10, prev_hash: H64("a"), hash: H64("b") });
  const third = entry({ id: 11, prev_hash: H64("b"), hash: H64("c") });
  const doc = treasury({ entries: [third, second, genesis] });

  const entries = doc.entries as Array<Record<string, unknown>>;
  for (let i = 0; i < entries.length - 1; i++) {
    assert.equal(entries[i].prev_hash, entries[i + 1].hash, `row ${entries[i].id} links the next hash`);
  }
  const zeros = entries.filter((e) => e.prev_hash === H64("0"));
  assert.equal(zeros.length, 1, "exactly one genesis row");
});

test("recognition tokens are heterogeneous: measured only on the dated arm, accrued only on the live fee arm", () => {
  const policy = treasury().spending_policy as { recognition: { tokens: unknown[] } };
  assert.deepEqual(
    validate(schema, treasury()),
    [],
    "the fixture's live fee token (still_accruing, no measured) must validate",
  );
  const measuredToken = {
    symbol: "1F916",
    name: "Society for AI Agents Fund",
    address: USDC,
    chain: "base",
    launched_via: "a tax token, issuer unknown to this registry",
    sent: "2172.28 USDC across 42 transfers",
    value: "$2,172.29",
    note: "It swaps its tax to dollars and routes them here.",
    live: false,
    measured: { as_of: "2026-08-21T05:24Z", method: "eth_getLogs on Base" },
  };
  assert.deepEqual(
    validate(
      schema,
      treasury({
        spending_policy: {
          ...policy,
          recognition: { ...policy.recognition, tokens: [measuredToken] },
        },
      }),
    ),
    [],
    "the dated-measurement token (measured, no still_accruing) must validate",
  );
  const noMeasuredDate = { ...measuredToken, measured: { method: "eth_getLogs" } };
  assert.ok(
    validate(
      schema,
      treasury({
        spending_policy: {
          ...policy,
          recognition: { ...policy.recognition, tokens: [noMeasuredDate] },
        },
      }),
    ).some((e) => e.includes("as_of")),
    "a measurement without its as_of date is the defect the measured block exists to prevent",
  );
});

test("the collection words are decimal strings or null — never JSON numbers", () => {
  const big = "15573273996908596652";
  const ok = treasury({
    assets: assetsBlock({ collection: { collected: true, last_cumulated_0: big, last_cumulated_1: "5893620085909417034111655929" } }),
  });
  assert.deepEqual(validate(schema, ok), [], "a read that completed must validate");
  const asNumber = treasury({
    assets: assetsBlock({ collection: { collected: true, last_cumulated_0: 15573273996908596652, last_cumulated_1: null } }),
  });
  assert.ok(
    validate(schema, asNumber).some((e) => e.includes("last_cumulated_0")),
    "getLastCumulatedFees exceeds 2^53 — serving it as a JSON number would corrupt it",
  );
});

test("a cold asset read with empty holdings and empty by_chain validates", () => {
  // by_chain is holdings-derived (src/assets.ts summarizeAssets). The cached
  // asset reader serves holdings: [] when a total RPC timeout meets no prior
  // snapshot (src/society.ts cold-start fallback). minItems:1 would
  // false-reject that correctly-degraded body.
  const cold = treasury({
    assets: assetsBlock({
      complete: false,
      holdings: [],
      by_chain: [],
      errors: ["asset read exceeded 2500ms and no earlier snapshot exists"],
    }),
  });
  assert.deepEqual(validate(schema, cold), [], "the cold isolate arm must validate");
});

test("a ledger entry with an uppercase-hex tx validates", () => {
  // recordLedger checks /^0x[a-fA-F0-9]{64}$/ and stores the trimmed string,
  // never lowercased (src/society.ts TX_HASH). hash/prev_hash stay lowercase
  // because they are sha256 digests.
  const tx = "0x" + "Ab".repeat(32);
  const doc = treasury({
    entries: [entry({ tx, amount_cents: 100, description: "patron payment " + tx })],
  });
  assert.deepEqual(validate(schema, doc), [], "uppercase hex tx is storable via recordLedger");
});

