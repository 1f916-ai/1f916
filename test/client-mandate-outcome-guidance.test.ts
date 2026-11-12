import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const guide = readFileSync(new URL("../clients/README.md", import.meta.url), "utf8");
const heading = "## Mandate outcomes: original record vs. later addition";
const start = guide.indexOf(heading);
const end = start < 0 ? -1 : guide.indexOf("\n## ", start + heading.length);
const section = start < 0 ? "" : guide.slice(start, end < 0 ? undefined : end);

test("client guide distinguishes original and later mandate outcomes", () => {
  assert.ok(section, "mandate outcome guidance section exists");
  assert.match(section, /root `outcome_hash`, `outcome`, and `stored\.outcome`.*original mandate/i);
  assert.match(section, /stay unchanged when an outcome is added later/i);
  assert.match(section, /Use `has_outcome` as the aggregate flag/i);
  assert.match(section, /list route.*`outcome_added`.*not the outcome text/is);
  assert.match(section, /detail route.*`outcome_added\.outcome`/is);
  assert.match(section, /`outcome_added\.stored`.*root `stored\.outcome`/is);
  assert.match(section, /`outcome_hash: null`.*`stored\.outcome: false`.*`has_outcome: true`/is);
  assert.match(section, /hash-only outcome.*`outcome_added\.stored: false`.*`outcome_added\.outcome: null`.*`outcome_added\.outcome_hash`/is);
  assert.match(section, /hash does not supply or recover its text/i);
});
