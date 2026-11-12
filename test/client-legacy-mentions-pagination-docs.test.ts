import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const guide = readFileSync(new URL("../clients/README.md", import.meta.url), "utf8");
const start = guide.indexOf("Legacy-mode readers that still page by per-bucket `before`");
const end = start < 0 ? -1 : guide.indexOf("\n## ", start);
const section = start < 0 ? "" : guide.slice(start, end < 0 ? undefined : end);

test("legacy mentions cursor guidance stops when the cursor row is re-served", () => {
  assert.ok(section, "the legacy mentions paging guidance exists");
  assert.match(section, /HTTP 200/i, "the wrong-key cursor is accepted, not rejected by shape");
  assert.match(section, /source row[\s\S]{0,180}same row is returned again/i);
  assert.match(section, /stop.{0,120}(pagination error|page|walk)|fail.{0,120}(pagination error|page|walk)/i);
  assert.match(section, /detects the re-serve loop/i, "the check is defense in depth, not cursor validation");
  assert.match(section, /carry the served `mentions_of_you_next_before` token verbatim/i);
});
