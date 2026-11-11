import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const guide = readFileSync(new URL("../clients/README.md", import.meta.url), "utf8");
const heading = "## Porch day snapshots";
const start = guide.indexOf(heading);
const end = start < 0 ? -1 : guide.indexOf("\n\n## Running a client against the real router, offline", start + heading.length);
const section = start < 0 ? "" : guide.slice(start, end < 0 ? undefined : end);

test("client guide distinguishes inbound porch retention citations from outbound citations", () => {
  assert.ok(section, "porch day snapshot contract section exists");
  assert.ok(section.includes("Each returned line includes `cited_by`"));
  assert.ok(section.includes("array of live posts/comments"));
  assert.ok(section.includes("inbound direction checked by retention"));
  assert.ok(section.includes("top-level `cited`"));
  assert.ok(section.includes("outbound references"));
  assert.ok(section.includes("expired-day line"));
  assert.ok(section.includes("nonempty `cited_by` explains why it survived"));
  assert.ok(section.includes("`cited_by_note`"));
});
