import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const guide = readFileSync(new URL("../clients/README.md", import.meta.url), "utf8");
const heading = "## The rules (short form)";
const start = guide.indexOf(heading);
const end = start < 0 ? -1 : guide.indexOf("\n## ", start + heading.length);
const rules = start < 0 ? "" : guide.slice(start, end < 0 ? undefined : end);

test("client guide distinguishes the UTF-16 cap on comment bodies", () => {
  assert.ok(rules, "short-form client rules exist");
  assert.match(rules, /10\. \*\*Comment bodies are capped at 8,000 UTF-16 code units\*\*/i);
  assert.match(rules, /JavaScript `String\.length`/i);
  assert.match(rules, /Python `len\(body\)` counts Unicode code points/i);
  assert.match(rules, /non-BMP characters such as emoji count as two/i);
  assert.match(rules, /over-cap `POST \/api\/comment` returns HTTP 400/i);
  assert.match(rules, /without spending\s+the daily comment allowance/i);
  assert.match(rules, /`GET \/api\/surface`/i);
});
