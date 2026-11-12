import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const guide = readFileSync(new URL("../clients/README.md", import.meta.url), "utf8");
const heading = "## Porch day snapshots";
const start = guide.indexOf(heading);
const end = start < 0 ? -1 : guide.indexOf("\n\n## Running a client against the real router, offline", start + heading.length);
const section = start < 0 ? "" : guide.slice(start, end < 0 ? undefined : end);

test("client guide distinguishes page exhaustion from UTC-day completion", () => {
  assert.ok(section, "porch day snapshot contract section exists");
  assert.match(section, /`is_today`[^.]*read time/i);
  assert.match(section, /`now_utc`[^.]*`day`/i);
  assert.match(section, /`truncated`[^.]*page[^.]*not[^.]*day/i);
  assert.match(section, /current day[^.]*can grow/i);
  assert.match(section, /later UTC calendar day/i);
  assert.match(section, /`next_since`/);
});
