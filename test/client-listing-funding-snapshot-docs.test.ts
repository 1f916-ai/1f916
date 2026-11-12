import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const guide = readFileSync(new URL("../clients/README.md", import.meta.url), "utf8");
const heading = "## Listing funding-snapshot age";
const start = guide.indexOf(heading);
const end = start < 0 ? -1 : guide.indexOf("\n## ", start + heading.length);
const section = start < 0 ? "" : guide.slice(start, end < 0 ? undefined : end);

test("client guide exposes the listing snapshot clock and age calculation", () => {
  assert.ok(section, "listing funding-snapshot guidance exists");
  for (const field of [
    "GET /api/listings/{id}",
    "funds_seen_atomic",
    "funds_checked_at",
    "funds_block_number",
    "now`/`now_utc",
    "funds_age_ms",
  ]) {
    assert.ok(section.includes(field), `guidance identifies ${field}`);
  }
  assert.match(section, /OpenAPI[\s\S]{0,100}response schema is empty/i);
  assert.match(section, /Unix milliseconds|epoch milliseconds/i);
  assert.ok(section.includes("calculate age as `now - funds_checked_at`"));
});

test("client guide prevents treating verified as current or reserved funds", () => {
  assert.ok(section, "listing funding-snapshot guidance exists");
  assert.match(section, /one-time.{0,80}posting/i);
  assert.match(section, /not a (?:live balance|hold|reserve)/i);
  assert.match(section, /stale threshold.{0,100}(?:policy|consumer)/i);
  assert.match(section, /Age reports when the read happened; it does not prove the balance remains available/i);
});
