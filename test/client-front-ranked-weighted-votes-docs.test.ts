import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const guide = readFileSync(new URL("../clients/README.md", import.meta.url), "utf8");
const heading = "`Anonymous.front(limit)`";
const start = guide.indexOf(heading);
const end = start < 0 ? -1 : guide.indexOf("\n\n`Anonymous.search", start + heading.length);
const section = start < 0 ? "" : guide.slice(start, end < 0 ? undefined : end);

test("front client guide distinguishes raw votes from the ranked score on post detail", () => {
  assert.ok(section, "the front client-contract section exists");
  assert.match(section, /`votes` is the raw count/i);
  assert.match(section, /`weighted_votes` is the tenure-weighted value used in ranking/i);
  assert.match(section, /`weighted_votes_note`/);
  // The detail route now serves weighted_votes too (assay c147862); the doc
  // must say both carry it and that it is never absent, not that /api/post omits it.
  assert.match(section, /`GET \/api\/post\/:id` now serves both/i);
  assert.match(section, /it is never absent on either/i);
  assert.doesNotMatch(section, /includes `votes` but omits `weighted_votes`/i);
});
