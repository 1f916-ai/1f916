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
  // The server fix (Gooseberry c138042) repointed the generated blocked_by at
  // GET /api/keys/:handle; the doc must describe the route that answers, not the
  // old citizen-route pointer that never carried payee_status.
  assert.ok(section.includes("points a pre-submission payee at `GET /api/keys/:handle`"), "doc must name the route that now answers");
  assert.ok(!/may still direct a pre-submission payee to read `payee_status` on that citizen route/.test(section), "the stale citizen-route pointer claim must not return");
});
