// Every served sentence about the official contract must agree with
// official_token. (docket: token-recognition)
//
// Run: npm test
//
// WHY THIS FILE EXISTS. On 2026-08-25 official_token on GET /api/official went
// from null to the 1F916 contract on Base. The suite was 966 green and the
// typechecker was clean, and GET /treasury would still have served, in the
// SAME response body, "Listed because the position is real, not because the
// token is ours" about that exact contract. Nothing asserted that the prose
// describing an asset agrees with the endpoint that names it. The pre-deploy
// auditor found it; this is the guard that makes the class unrepeatable rather
// than a promise to be more careful next time.
//
// Two layers, because either alone leaves a door open:
//   1. BEHAVIOURAL: the provenance string a reader actually receives.
//   2. SOURCE SCAN: the same claim can be reintroduced anywhere in src/, in a
//      branch that does not render today. society.ts:8039 was exactly that:
//      false prose sitting one unrendered branch away from a reader.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { officialFacts } from "../src/society.ts";
import { CLAIM_SOURCES, provenanceFor } from "../src/assets.ts";

const TREASURY = "0xa7F7985eB19b8c44F12A0654Df1eF89d1dd527C9";
const facts = officialFacts({ TREASURY_ADDRESS: TREASURY } as never);
const token = facts.official_token as { contract: string; symbol: string };

test("the official contract is one value, not two hardcoded copies that can drift", () => {
  // society.ts and assets.ts each hardcode the address, for different reasons
  // (one names it official, the other reads its pool). If they ever disagree,
  // /treasury describes one contract while /api/official names another and a
  // citizen checking the canonical address against the treasury page finds a
  // mismatch with no way to tell which is right.
  const claim = CLAIM_SOURCES.find((c) => c.symbol === token.symbol);
  assert.ok(claim, "the official token must be the claim source the treasury reads");
  assert.equal(claim.token.toLowerCase(), token.contract.toLowerCase());
});

test("no served provenance calls the official contract not-ours", () => {
  // Every holding row that is the official token or the proceeds of its pool.
  const rows = [
    { asset: "1F916", location: "wallet" as const, chain: "base" as const },
    { asset: "1F916", location: "claimable" as const, chain: "base" as const },
    { asset: "WETH", location: "wallet" as const, chain: "base" as const },
    { asset: "WETH", location: "claimable" as const, chain: "base" as const },
  ];
  for (const row of rows) {
    const prose = provenanceFor(row);
    assert.doesNotMatch(
      prose,
      /not\s+(?:because\s+)?(?:the\s+token\s+is\s+)?ours|not\s+official/i,
      `provenance for ${row.asset}/${row.location} denies ownership of the now-official contract: ${prose}`,
    );
    // And it must not swing the other way: recognition is not endorsement, and
    // a page that drops "did not launch it" is a different lie.
    assert.match(prose, /did not launch it/i, `provenance for ${row.asset}/${row.location} must still say the society did not launch it`);
  }
  // The unsolicited BNB copycat is NOT the official token and must keep saying so.
  const bnb = provenanceFor({ asset: "NVDAB", location: "wallet", chain: "bnb" });
  assert.match(bnb, /does not endorse it/i, "the copycat's disclaimer must survive recognition of a different token");
});

test("the claim source note agrees with the endpoint", () => {
  const claim = CLAIM_SOURCES.find((c) => c.symbol === token.symbol);
  assert.ok(claim);
  assert.doesNotMatch(claim.note, /not\s+because\s+the\s+token\s+is\s+ours/i);
  assert.match(claim.note, /official token/i, "the note must name the recognition it lives beside");
});

// The class-killer. Comments may DISCUSS a retired sentence (the fix commits
// quote them, deliberately, so the next reader knows why the words changed);
// only served strings are scanned. A line whose first non-space characters
// begin a comment is skipped, which is the same rule a reader applies by eye.
const STALE = [
  /there is no official token/i,
  /there is still no official/i,
  /the society has no token/i,
  /official_token (?:is|has been) null/i,
  /not because the token is ours/i,
  /not official and not ours/i,
];

function servedLines(file: string): { n: number; text: string }[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .map((text, i) => ({ n: i + 1, text }))
    .filter(({ text }) => {
      const t = text.trimStart();
      return t.length > 0 && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    });
}

test("no source file still asserts that this society has no official token", () => {
  const dir = "src";
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => join(dir, f));
  assert.ok(files.length > 5, "the scan must actually be reading the source tree");
  const hits: string[] = [];
  for (const file of files) {
    for (const { n, text } of servedLines(file)) {
      for (const pattern of STALE) {
        if (pattern.test(text)) hits.push(`${file}:${n} ${text.trim().slice(0, 120)}`);
      }
    }
  }
  assert.deepEqual(
    hits,
    [],
    `served prose still says this society has no official token, which stopped being true on 2026-08-25:\n${hits.join("\n")}`,
  );
});
