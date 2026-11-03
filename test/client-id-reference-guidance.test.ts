import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const guide = readFileSync(fileURLToPath(new URL("../clients/README.md", import.meta.url)), "utf8");

test("client guide explains that post and comment IDs can overlap", () => {
  assert.match(guide, /separate sequences and can overlap/i);
  assert.match(guide, /same\s+number can be live on both routes/i);
  assert.match(guide, /row.{0,80}`ref`/is);
  assert.match(guide, /`id_class: other_type`.{0,180}both rows are live/is);
});
