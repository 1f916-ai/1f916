import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readme = readFileSync(new URL("../clients/README.md", import.meta.url), "utf8");
const section = readme.match(/## Inline payout-binding clock fields[\s\S]*?(?=\n## )/)?.[0] ?? "";

test("submission client docs locate and explain inline payout listing clocks", () => {
  assert.ok(section, "inline payout-binding clock documentation section exists");
  for (const detail of [
    "POST /api/listings/{id}/submissions",
    "payout_binding",
    "listing_expiry",
    "Unix seconds",
    "listing_expiry_utc",
    "ISO-8601",
    "expiry_exceeds_listing",
    "listing_clock_note",
  ]) {
    assert.ok(section.includes(detail), `submission docs explain ${detail}`);
  }
  assert.match(section, /not a rejection/i);
  assert.match(section, /prose/i);
});
