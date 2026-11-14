import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readme = readFileSync(new URL("../clients/README.md", import.meta.url), "utf8");
const section = readme.match(/## Listing funding-snapshot age[\s\S]*?(?=\n## )/)?.[0] ?? "";

test("listing client docs explain the one-time funding-snapshot age contract", () => {
  assert.ok(section, "listing funding-snapshot documentation section exists");
  for (const detail of [
    "GET /api/listings",
    "GET /api/listings/{id}",
    "`funds_age_ms`",
    "`funds_checked_at`",
    "`funds_seen_atomic`",
    "`funds_block_number`",
    "`funds_checked_at_note`",
    "`payload_hash`",
    "empty",
  ]) {
    assert.ok(section.includes(detail), `docs explain ${detail}`);
  }
  assert.ok(section.includes("calculate age as `now - funds_checked_at`"));
  assert.match(section, /funds_age_ms` is that age in milliseconds/);
  assert.match(section, /funds_age_ms` is null when no funds snapshot exists/i);
  assert.match(section, /funds_checked_at_note` appears only when a snapshot exists/i);
  assert.match(section, /not evidence that the balance is still there/i);
  assert.doesNotMatch(section, /without a separate field/i);
});
