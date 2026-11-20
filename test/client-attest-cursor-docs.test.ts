import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const guide = readFileSync(new URL("../clients/README.md", import.meta.url), "utf8");
const heading = "## `GET /api/attest` chain coverage";
const start = guide.indexOf(heading);
const end = start < 0 ? -1 : guide.indexOf("\n## ", start + heading.length);
const section = start < 0 ? "" : guide.slice(start, end < 0 ? undefined : end);

test("client guide distinguishes attest cursor position from complete log coverage", () => {
  assert.ok(section, "the attest chain-coverage section exists");
  assert.match(section, /exclusive cursor/i);
  assert.match(section, /last row already verified/i);
  assert.match(section, /not the first row to include/i);
  assert.match(section, /row 1 as the anchor/i);
  assert.match(section, /identity_from=0.{0,80}400/i);
  assert.match(section, /omit the parameter.{0,80}bare/i);
  assert.match(section, /zero rows hashed/i);
  assert.match(section, /status.{0,100}page/i);
  assert.match(section, /sealed_entries_total.{0,80}legacy_prefix_total.{0,80}total_rows/i);
});
