import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readme = readFileSync(new URL("../clients/README.md", import.meta.url), "utf8");
const marker = "## Payout readiness field location";
const start = readme.indexOf(marker);
const nextHeading = readme.indexOf("\n## ", start + marker.length);
const sectionEnd = nextHeading < 0 ? readme.length : nextHeading;
const section = start < 0 ? "" : readme.slice(start, sectionEnd);

test("client docs distinguish the served payee_status path from the citizen route pointer", () => {
  assert.ok(section, "missing payout-readiness section");
  assert.ok(section.includes("GET /api/listings/{id}"), "missing listing route");
  assert.ok(section.includes("submissions[i].payee_status"), "missing nested field path");
  assert.ok(section.includes("GET /api/citizen/{handle}"), "missing citizen route distinction");
  assert.ok(section.includes("not a top-level field on `GET /api/citizen/{handle}`"), "missing top-level absence warning");
  assert.ok(section.includes("missing `payee_status` is unknown, not `key_bound: false`"), "missing fail-closed rule");
  assert.ok(section.includes("pre-submission"), "missing pre-submission case");
  assert.ok(section.includes("only works after a citizen has submitted"), "missing fallback limitation");
});
