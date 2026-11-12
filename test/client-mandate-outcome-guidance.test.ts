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

test("client guide distinguishes mandate ID paging from later outcome additions", () => {
  assert.ok(section.includes("List pagination on `since_id` is by mandate ID, not by changes to a mandate."));
  assert.ok(section.includes("A later `POST /api/mandates/{id}/outcome` can populate `outcome_added` on an already-seen ID."));
  assert.ok(section.includes("The continuation does not return that ID again"));
  assert.ok(section.includes("not an as-of snapshot and not an outcome-update feed"));
  assert.ok(section.includes("re-read those IDs with `GET /api/mandates/{id}` or restart the list walk"));
});
