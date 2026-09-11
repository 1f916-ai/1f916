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

test("no served string names USDC alone while describing a multi-asset mechanism", () => {
  // WHY THIS REPLACED A BLOCKLIST. The first version scanned for the literal
  // shapes /USDC[\s-]+Transfer\b/ and /Base-USDC receipts?/. The pre-deploy
  // auditor broke it in one try, with a sentence that is false for a 1F916
  // binding and matches neither pattern:
  //
  //   "two RPC sources agreed on one canonical finalized net-positive transfer
  //    of USDC on Base, the only asset a receipt may be denominated in"
  //
  // A blocklist of phrasings can always be re-said. So this asserts INCLUSION
  // instead: a served line that names USDC while describing a mechanism whose
  // asset is the binding's or the listing's must name every settlement asset.
  // Word order cannot evade that, because the test does not read word order.
  //
  // ALLOWLIST, and each entry is a mechanism that really is USDC-only:
  //   - treasury donations (direct USDC transfer to the treasury address)
  //   - x402 patron intake, priced in dollars
  //   - escrow: GET /api/official publishes that this registry refuses to
  //     publish an escrow-backed listing in any asset but USDC. That limit is
  //     ours and it is real, so prose saying so is true and must not be flagged.
  //
  // Killing mutation: in any non-allowlisted served string, describe the
  // receipt, preimage, or funder-balance mechanism as USDC without naming
  // 1F916. This goes red however the sentence is worded.
  const MECHANISM = /\b(transfer|receipt|preimage|balance|contract\b|denominat)/i;
  //   - MEASURED.*: a recorded historical quantity of USDC that actually moved,
  //     not a description of what a mechanism accepts.
  const ALLOWED = /treasury|escrow|x402|patron|donation|still_refused|MEASURED\./i;
  const others = SETTLEMENT_ASSETS.filter((a) => a.symbol !== "USDC").map((a) => a.symbol);
  const offenders: string[] = [];
  for (const file of ["../src/mcp.ts", "../src/society.ts", "../src/payouts.ts"]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    src.split("\n").forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return; // source comments are not served
      if (!/USDC/.test(line)) return;
      if (ALLOWED.test(line)) return;
      if (!MECHANISM.test(line)) return;
      if (others.every((sym) => line.includes(sym))) return;
      offenders.push(`${file}:${i + 1}: ${line.trim().slice(0, 130)}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `a served string names USDC alone while describing a mechanism that carries the binding's or listing's own asset (${others.join(", ")} also settle here):\n${offenders.join("\n")}`,
  );
});
