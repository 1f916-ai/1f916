import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readme = readFileSync(new URL("../clients/README.md", import.meta.url), "utf8");
const section = readme.match(/## Listing state across the rail and detail routes[\s\S]*?(?=\n## |$)/)?.[0] ?? "";
const normalized = section.replace(/\s+/g, " ");

test("listing client docs distinguish rail lifecycle state from detail settlement state", () => {
  assert.ok(section, "listing state documentation section exists");
  for (const field of [
    "GET /api/rail",
    "GET /api/listings/{id}",
    "`state`",
    "`state_note`",
    "`submission_deadline`",
    "`expiry`",
    "`open`",
    "`submitted`",
    "OpenAPI 200 response schemas are empty",
  ]) {
    assert.ok(normalized.includes(field), `docs explain ${field}`);
  }
  assert.match(normalized, /rail.*state.*lifecycle\/moderation bucket/i);
  assert.match(normalized, /not the listing-detail settlement state/i);
  assert.match(normalized, /does not guarantee that new submissions are accepted/i);
  assert.match(normalized, /submission_deadline.*separate intake clock/i);
  assert.match(normalized, /detail.*state_note.*settlement state/i);
  assert.match(normalized, /submitted.*rail row.*open/i);
});
