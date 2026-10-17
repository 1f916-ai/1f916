// Caller-supplied identifiers must not acquire a row id through JavaScript
// coercion. A boolean true and a one-element array both become 1 under
// Number()/String(); on write paths that can vote, withdraw, moderate, flag or
// amend row 1 instead of refusing the malformed request.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SocietyError, wholeNumber } from "../src/society.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

function refused(raw: unknown): void {
  assert.throws(
    () => wholeNumber(raw, "target_id", "a positive integer row id"),
    (error: Error) => error instanceof SocietyError && error.status === 400,
    `${JSON.stringify(raw)} must not acquire an id through coercion`,
  );
}

test("wholeNumber accepts only number/string scalar representations", () => {
  assert.equal(wholeNumber(1, "target_id", "a positive integer row id"), 1);
  assert.equal(wholeNumber("1", "target_id", "a positive integer row id"), 1);

  for (const raw of [true, false, [1], ["1"], { toString: () => "1" }]) refused(raw);
});

test("write identifiers use the shared strict parser instead of Number coercion", () => {
  const index = readFileSync(`${root}/src/index.ts`, "utf8");
  const society = readFileSync(`${root}/src/society.ts`, "utf8");

  for (const expression of ["Number(b.post_id)", "Number(b.parent_id)", "Number(b.target_id)"]) {
    assert.equal(index.includes(expression), false, `HTTP write route still coerces with ${expression}`);
  }
  for (const expression of ["Number(body.target_id)", "Number(targetId)", "Number(rawCandidate)"]) {
    assert.equal(society.includes(expression), false, `write implementation still coerces with ${expression}`);
  }
});

// The MCP door reaches the same write implementations as the HTTP routes, so
// it owes the same parse. Each write tool's case block in mcp.ts is cut out
// (from its `case "name":` to the next `case "`) and must not hand an id to
// the implementation through Number(args.x), which turns true into 1 and
// [57] or "0x39" into 57.
const MCP_WRITE_TOOLS = [
  "pin",
  "comment",
  "vote",
  "payout_wallet_revoke",
  "payout_receipt",
  "order_offer",
  "withdraw_offer",
  "submit_work",
  "paid_ping",
  "award_submission",
  "settle_award_from_receipt",
  "mark_award_payable",
  "withdraw_listing",
];

function caseBlock(source: string, tool: string): string {
  const start = source.indexOf(`case "${tool}":`);
  assert.notEqual(start, -1, `mcp.ts has no case for write tool ${tool}`);
  const next = source.indexOf(`case "`, start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

test("MCP write tools use the shared strict parser instead of Number coercion", () => {
  const mcp = readFileSync(`${root}/src/mcp.ts`, "utf8");
  for (const tool of MCP_WRITE_TOOLS) {
    const block = caseBlock(mcp, tool);
    // \b keeps wholeNumber(args.x) itself from matching.
    assert.equal(/\bNumber\(args\./.test(block), false, `MCP write tool ${tool} still coerces an id with Number(args.…)`);
    assert.match(block, /wholeNumber\(args\./, `MCP write tool ${tool} parses its id with wholeNumber`);
  }
});
