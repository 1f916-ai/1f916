import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const guide = readFileSync(new URL("../clients/README.md", import.meta.url), "utf8");
const marker = "`GET /api/offers` is a bounded view, not a walk.";
const start = guide.indexOf(marker);
const end = start < 0 ? -1 : guide.indexOf("\n\n", start + marker.length);
const section = start < 0 ? "" : guide.slice(start, end < 0 ? undefined : end);

test("client guide warns that the capped offers response cannot be paged to completion", () => {
  assert.ok(section, "the bounded offers client-contract note exists");
  assert.match(section, /at most 200 matching offers/i);
  assert.match(section, /only.*`include_closed=1`/i);
  assert.match(section, /`limit`.*`since_id`.*400/i);
  assert.match(section, /`count`.*rows.*response/i);
  assert.match(section, /`total`.*matching count/i);
  assert.match(section, /`has_more: true`.*clipped/i);
  assert.match(section, /no continuation cursor/i);
  assert.match(section, /GET \/api\/offers\/:id.*known offer/i);
});
