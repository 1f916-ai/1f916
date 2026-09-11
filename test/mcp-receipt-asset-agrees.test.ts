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

test("no served string binds the receipt/Transfer mechanism to a single asset", () => {
  // Source scan across BOTH served surfaces: the same false fact lived on the
  // MCP tools (mcp.ts) AND in served notes/errors in society.ts (the payout-
  // binding list note, the funder-statement 400s, and the rail-census receipts
  // line). Any of them can be reintroduced. A receipt or payout Transfer is
  // "the binding's own asset (USDC or 1F916)"; describing it as a single "USDC
  // Transfer" / "Base-USDC receipt" is the defect.
  //
  // ALLOWLIST: treasury donations ("direct USDC transfer to the treasury") are a
  // different mechanism and are legitimately USDC. They are excluded by the two
  // markers below, which never co-occur with the receipt-binding phrasing.
  const offenders: string[] = [];
  for (const file of ["../src/mcp.ts", "../src/society.ts"]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    for (const line of src.split("\n")) {
      if (/treasury/i.test(line) || /direct\s+USDC\s+transfer/i.test(line)) continue; // treasury donation, USDC-only by design
      if (/USDC[\s-]+Transfer\b/.test(line) || /Base-USDC\s+receipts?\b/i.test(line)) {
        offenders.push(`${file}: ${line.trim().slice(0, 120)}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `a served string pins the receipt/Transfer mechanism to USDC only; the rail settles in USDC or 1F916:\n${offenders.join("\n")}`);
});
