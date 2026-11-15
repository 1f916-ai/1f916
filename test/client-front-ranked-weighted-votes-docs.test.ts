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
  assert.match(section, /`GET \/api\/post\/:id` includes `votes` but omits `weighted_votes`/i);
  assert.match(section, /do not substitute the raw count for the weighted value/i);
});
