// Every MCP tool description of the receipt mechanism must name the assets the
// rail actually settles in, not a single hardcoded one.
//
// WHY THIS FILE EXISTS. On 2026-09-01 the rail began settling in USDC or 1F916,
// chosen per listing (GET /api/official payout_assets; official_token
// .amended_2026_09_01 retires the old "still USDC on Base" sentence by name).
// GET /api/surface already describes the receipt route as "the binding's own
// asset (USDC or 1F916)". But three MCP tool descriptions still called receipts
// "Base-USDC" only: the payouts read tool, the payout_receipt write tool, and
// its transfer_log_index field. A payee filing a 1F916 receipt read a tool that
// told them the mechanism was dollars-only. city-desk reported the read tool in
// c55034 on post 3433; the two sibling strings on the same mechanism carried the
// identical false fact. Nothing compared the served tool prose to the closed
// asset list the same registry publishes.
//
// Killing mutation: revert any of those descriptions to say "Base-USDC" for the
// receipt/Transfer mechanism (dropping 1F916). This test then goes red because a
// non-default settlement asset is missing from a description of that mechanism.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { TOOLS } from "../src/mcp.ts";
import { SETTLEMENT_ASSETS } from "../src/payouts.ts";

// The tools whose descriptions are about recording/reading an on-chain receipt.
const RECEIPT_TOOLS = ["payouts", "payout_receipt"];

test("receipt tool descriptions name every asset the rail settles in", () => {
  const symbols = SETTLEMENT_ASSETS.map((a) => a.symbol);
  assert.ok(symbols.includes("USDC") && symbols.length > 1, "expected USDC plus at least one more settlement asset");
  const wrong: string[] = [];
  for (const name of RECEIPT_TOOLS) {
    const tool = TOOLS.find((t) => t.name === name);
    assert.ok(tool, `tool ${name} must be listed`);
    for (const sym of symbols) {
      if (!tool.description.includes(sym)) {
        wrong.push(`${name}: description omits settlement asset ${sym}, so it misstates what a receipt can be: ${tool.description}`);
      }
    }
  }
  assert.deepEqual(wrong, [], `MCP receipt prose disagrees with payout_assets.accepted:\n${wrong.join("\n")}`);
});

// Served source, with source comments removed and adjacent string literals
// joined. BOTH are required. Comments are not served, so flagging them trains
// people to route around the guard; and a served sentence split across two
// physical lines ("...may be denominated in " + "USDC on Base.") hides the
// mechanism word from the asset word unless the literals are rejoined first.
function servedLogicalLines(file: string): { line: string; n: number }[] {
  const src = readFileSync(new URL(file, import.meta.url), "utf8");
  const kept: { line: string; n: number }[] = [];
  src.split("\n").forEach((raw, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(raw)) return; // a source comment is not served
    kept.push({ line: raw, n: i + 1 });
  });
  const joined: { line: string; n: number }[] = [];
  for (const row of kept) {
    const prev = joined[joined.length - 1];
    // `"..." +` on one line and a string literal on the next is ONE served
    // sentence. Join them so the scan sees the sentence, not the fragments.
    if (prev && /\+\s*$/.test(prev.line) && /^\s*["`']/.test(row.line)) {
      prev.line = prev.line.replace(/\+\s*$/, "") + row.line.trim();
      continue;
    }
    joined.push({ ...row });
  }
  return joined;
}

// USDC-ONLY SENTENCES THAT ARE TRUE, PINNED BY CONTENT.
//
// WHY A HASH AND NOT A KEYWORD. The first version of this allowlist skipped any
// line matching /treasury|escrow|x402|patron|donation/. The pre-deploy auditor
// defeated it by appending five words to a false sentence:
//
//   "...the only asset a receipt may be denominated in; this is not the escrow path."
//
// The sentence is false for a 1F916 binding and the keyword waved it through. A
// keyword says what a line MENTIONS; it cannot say what a line is ABOUT. So the
// exception is pinned to the exact bytes instead: change one character of an
// approved sentence and it stops being approved, which is the correct default
// for prose about which assets this rail accepts.
//
// Each entry below is a mechanism that really is USDC-only, and says why.
const USDC_ONLY_APPROVED = new Map<string, string>([
  // Escrow really is USDC-only, and it is OUR limit, not the contract's. The
  // contract takes the token as a parameter; this registry refuses to publish
  // an escrow-backed listing in anything else. src/settlement.ts also pins
  // escrow_chain_id to Base. Both sentences say so and both are true.
  ["f02981f9257d40f4", "escrow: this registry refuses any asset but USDC, and says where the limit lives"],
  ["09f5f894752ab95b", "escrow: the same limit, stated on the listings surface"],
  // A treasury donation is a different mechanism from a payout receipt. It is
  // an address that accepts dollars; nobody is invited to send 1F916 to it.
  ["91329b17683a0f44", "treasury donations: direct USDC transfer to the treasury address"],
  // A recorded historical quantity that actually moved. Not a statement about
  // what any mechanism accepts, and changing it would be falsifying a measurement.
  ["388d9e353a87620b", "MEASURED: USDC the fund token actually sent, a past fact"],
  // Treasury reconciliation: onchain_cents IS balanceOf on the USDC contract,
  // because the treasury holds dollars. A reader reproducing the number needs
  // the actual contract, so naming 1F916 here would make the recipe wrong.
  ["95c53ecb9c19521d", "treasury: onchain_cents is balanceOf for USDC, the asset the treasury holds"],
  ["5ff8257295d9f016", "treasury: the eth_call recipe for that same balance"],
]);

function digest(line: string): string {
  return createHash("sha256").update(line.trim()).digest("hex").slice(0, 16);
}

test("no served string names USDC alone while describing a multi-asset mechanism", () => {
  // A served line that names USDC while describing a mechanism whose asset is
  // the binding's or the listing's must name every settlement asset. This is an
  // INCLUSION rule: it does not read word order, so it cannot be evaded by
  // re-saying the sentence differently.
  //
  // Killing mutation: describe the receipt, preimage, or funder-balance
  // mechanism as USDC in any non-approved served string, worded however you
  // like. It goes red, including the auditor's escape sentence above.
  const MECHANISM = /\b(transfer|receipt|preimage|balance|contract\b|denominat)/i;
  const others = SETTLEMENT_ASSETS.filter((a) => a.symbol !== "USDC").map((a) => a.symbol);
  const offenders: string[] = [];
  for (const file of ["../src/mcp.ts", "../src/society.ts", "../src/payouts.ts", "../src/listings.ts", "../src/settlement.ts", "../src/funded.ts"]) {
    for (const { line, n } of servedLogicalLines(file)) {
      if (!/USDC/.test(line)) continue;
      if (!MECHANISM.test(line)) continue;
      if (others.every((sym) => line.includes(sym))) continue;
      if (USDC_ONLY_APPROVED.has(digest(line))) continue;
      offenders.push(`${file}:${n} [${digest(line)}] ${line.trim().slice(0, 140)}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `a served string names USDC alone while describing a mechanism that carries the binding's or listing's own asset (${others.join(", ")} also settle here).\nIf one of these really is USDC-only, add its digest to USDC_ONLY_APPROVED with the reason:\n${offenders.join("\n")}`,
  );
});
