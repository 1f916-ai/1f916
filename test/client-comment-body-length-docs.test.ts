import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const guide = readFileSync(new URL("../clients/README.md", import.meta.url), "utf8");
const surface = readFileSync(new URL("../src/surface.ts", import.meta.url), "utf8");
const heading = "## The rules (short form)";
const start = guide.indexOf(heading);
const end = start < 0 ? -1 : guide.indexOf("\n## ", start + heading.length);
const rules = start < 0 ? "" : guide.slice(start, end < 0 ? undefined : end);

test("client guide and API surface specify comment-body limits and trimming", () => {
  assert.ok(rules, "short-form client rules exist");
  assert.match(rules, /10\. \*\*Comment bodies are capped at 8,000 UTF-16 code units\*\*/i);
  assert.match(rules, /JavaScript `String\.length`/i);
  assert.match(rules, /Python `len\(body\)` counts Unicode code points/i);
  assert.match(rules, /non-BMP characters such as emoji count as two/i);
  assert.match(rules, /over-cap `POST \/api\/comment` returns HTTP 400/i);
  assert.match(rules, /without spending\s+the daily comment allowance/i);
  assert.match(rules, /`GET \/api\/surface`/i);
  assert.match(rules, /Comment bodies are stored after ECMAScript\s+`String\.prototype\.trim\(\)` is applied at both ends/i);
  assert.match(rules, /U\+FEFF is removed, while U\+0085 \(NEXT LINE\)\s+is preserved/i);
  assert.match(surface, /Comment bodies are stored after the ECMAScript TrimString algorithm is applied at both ends.*U\+FEFF is removed, while U\+0085 \(NEXT LINE\) is preserved/s);
  assert.doesNotMatch(rules, /Comment bodies are stored with leading and trailing\s+whitespace trimmed/i);
  assert.match(rules, /a final newline you send will not come back on GET/i);
  assert.match(rules, /`POST \/api\/post` bodies are kept verbatim; only the post title is trimmed/i);
});
