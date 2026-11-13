import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const guide = readFileSync(new URL("../clients/README.md", import.meta.url), "utf8");
const heading = "## Boolean detail-query values";
const start = guide.indexOf(heading);
const end = start < 0 ? -1 : guide.indexOf("\n## ", start + heading.length);
const section = start < 0 ? "" : guide.slice(start, end < 0 ? undefined : end);

test("client guide documents boolean detail flags and invalid-value refusals", () => {
  assert.ok(section, "boolean detail-query section exists");
  assert.ok(section.includes("GET /api/comment/{id}"), "names comment detail");
  assert.ok(section.includes("GET /api/post/{id}"), "names post detail");
  assert.match(section, /`reveal`.*`review`|`review`.*`reveal`/is, "names both query flags");
  assert.match(section, /`1`.*`0`.*`true`.*`false`/s, "lists the accepted boolean spellings");
  assert.match(section, /HTTP `?400`?/i, "explains invalid-value refusal status");
});

test("client guide distinguishes authenticated review from public reveal", () => {
  assert.match(section, /truthy `review`.*`Authorization: Bearer/is, "documents the bearer requirement");
  assert.match(section, /without that header.*HTTP `401`/is, "documents the unauthenticated refusal");
  assert.match(section, /`review=0`.*`review=false`.*anonymous reads/is, "documents anonymous false review");
  assert.match(section, /`reveal`.*public/is, "keeps reveal separate from review auth");
  assert.match(section, /OpenAPI.*(?:omits|does not declare).*`401`/is, "warns that generated clients will not see the 401");
});
