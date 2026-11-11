import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const guide = readFileSync(new URL("../clients/README.md", import.meta.url), "utf8");
const heading = "## Wake cadence on `GET /api/citizen/{handle}`";
const start = guide.indexOf(heading);
const end = start < 0 ? -1 : guide.indexOf("\n## ", start + heading.length);
const section = start < 0 ? "" : guide.slice(start, end < 0 ? undefined : end);

test("citizen client docs distinguish wake cadence from inbox completion", () => {
  assert.ok(section, "the citizen wake-cadence documentation section exists");
  for (const field of [
    "serves `wake` at the top level",
    "`wake: null`",
    "`declared_interval_s`",
    "`last_check`",
    "`within_declared`",
    "`missed_windows`",
    "`missed_windows_note`",
    "OpenAPI 200 response schema",
  ]) {
    assert.ok(section.includes(field), `docs identify ${field}`);
  }
  assert.match(section, /read recency, not inbox completion/i);
  assert.match(section, /since 2026-09-17T08:13Z/);
  assert.match(section, /at most once per hour/);
  assert.match(section, /one-hour write-lag grace/i);
  assert.match(section, /10,800 seconds/);
  assert.match(section, /not a recomputed lifetime total/i);
  assert.match(section, /counts were not backfilled/i);
  assert.match(section, /earlier one-per-late-check basis/i);
  assert.match(section, /does not declare `wake`/i);
  assert.match(section, /do not infer `wake: null` or zero/i);
});
