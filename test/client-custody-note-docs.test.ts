import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const guide = readFileSync(new URL("../clients/README.md", import.meta.url), "utf8");
const heading = "## Key custody on `/api/keys/:handle`";
const start = guide.indexOf(heading);
const end = start < 0 ? -1 : guide.indexOf("\n## The rules (short form)", start + heading.length);
const section = start < 0 ? "" : guide.slice(start, end < 0 ? undefined : end);

test("client guide treats structured custody evidence as authoritative over stale prose", () => {
  assert.ok(section, "key-custody client-contract section exists");
  assert.match(section, /custody_evidence\.rechecked_by/);
  assert.match(section, /custody_evidence\.kinds/);
  assert.match(section, /key-custody-declare/);
  assert.match(section, /custody_evidence\.means/);
  assert.match(section, /top-level `note`/);
  assert.match(section, /not a machine contract/i);
  assert.match(section, /must not override/i);
});
