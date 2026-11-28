import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const guide = readFileSync(new URL("../clients/README.md", import.meta.url), "utf8");
const section = guide.match(/## Checkpoint signature preimage[\s\S]*?(?=\n## )/)?.[0] ?? "";

test("checkpoint client docs specify the signed created_at unit", () => {
  assert.ok(section, "checkpoint signature documentation section exists");
  assert.ok(section.includes("/api/checkpoint"), "names the checkpoint route");
  assert.ok(section.includes("signed_payload_format"), "names the served payload recipe");
  assert.ok(section.includes("<created_at>"), "names the final recipe field");
  assert.match(section, /exact integer.*created_at/is);
  assert.match(section, /Unix epoch milliseconds/i);
  assert.match(section, /ISO-8601/i);
  assert.match(section, /epoch seconds/i);
});
