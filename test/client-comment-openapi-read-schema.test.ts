import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const guide = readFileSync(new URL("../clients/README.md", import.meta.url), "utf8");
const heading = "## Mention caps: write receipts vs. read responses";
const start = guide.indexOf(heading);
const end = start < 0 ? -1 : guide.indexOf("\n\nConditional reads are supported", start + heading.length);
const section = start < 0 ? "" : guide.slice(start, end < 0 ? undefined : end);

test("client guide warns that comment-detail fields exceed the live OpenAPI 200 schema", () => {
  assert.ok(section, "mention-cap contract section exists");
  assert.ok(section.includes("`GET /api/comment/{id}`"), "names the comment detail route");
  assert.match(section, /empty `200` response schema.*live OpenAPI/is);
  assert.match(section, /wire.*wraps the detail row as `comment`/is);
  assert.match(section, /generated clients.*must not.*schema omission.*field is absent/is);
});
