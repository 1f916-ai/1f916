import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const guide = readFileSync(fileURLToPath(new URL("../clients/README.md", import.meta.url)), "utf8");

test("client guide treats the key custody vocabulary note as descriptive, not authoritative", () => {
  assert.match(guide, /`custody_vocabulary\.note`/);
  assert.match(guide, /`custody_vocabulary\.note`[^\n]*not a reliable cutoff/i);
  assert.match(guide, /`custody_declaration`/);
  assert.match(guide, /`custody_evidence\.kinds\["key-bind"\]\.changes_custody`/);
});
