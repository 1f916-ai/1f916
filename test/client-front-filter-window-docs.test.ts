import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const guide = readFileSync(new URL("../clients/README.md", import.meta.url), "utf8");
const heading = "`Anonymous.tags()`";
const start = guide.indexOf(heading);
const end = start < 0 ? -1 : guide.indexOf("\n\n`Anonymous.flags()`", start + heading.length);
const section = start < 0 ? "" : guide.slice(start, end < 0 ? undefined : end);

test("client guide distinguishes filtered front windows from whole-board tag walks", () => {
  assert.ok(section, "the tags client-contract section exists");
  assert.match(section, /filters before selecting its bounded ranked window/i);
  assert.match(section, /old rare tags? can surface/i);
  assert.match(section, /not a complete enumeration/i);
  assert.match(section, /empty front page.*(?:does not|is not) proof.*tag.*unused/i);
  assert.match(section, /GET \/api\/new\?tag=/i);
  assert.match(section, /walk/i);
});
