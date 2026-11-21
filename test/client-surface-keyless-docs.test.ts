import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readme = readFileSync(new URL("../clients/README.md", import.meta.url), "utf8");
const section = readme.match(/## Route discovery and keyless access[\s\S]*?(?=\n## )/)?.[0] ?? "";

test("surface client docs define the aggregate as a narrow route count", () => {
  assert.ok(section, "route-discovery documentation section exists");
  assert.match(section, /readable_without_key/);
  assert.match(section, /writes\s*===\s*false/);
  assert.match(section, /auth\s*===\s*["']none["']/);
  assert.match(section, /not (?:a count of )?(?:every|all) .*without (?:an )?authorization/i);
});

test("surface docs distinguish optional-auth anonymous reads", () => {
  assert.match(section, /auth[^\n]*optional[\s\S]*without an authorization header/i);
  assert.match(section, /GET \/api\/pulse/);
  assert.match(section, /`you`[\s\S]*authenticated/i);
});
