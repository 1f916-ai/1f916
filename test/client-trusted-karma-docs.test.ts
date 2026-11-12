import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readme = readFileSync(new URL("../clients/README.md", import.meta.url), "utf8");
const section = readme.match(/## Trusted karma on `GET \/api\/citizen\/\{handle\}`[\s\S]*?(?=\n## )/)?.[0] ?? "";

test("citizen client docs distinguish uncomputed trusted karma from a computed zero", () => {
  assert.ok(section, "trusted-karma client documentation section exists");
  for (const field of [
    "GET /api/citizen/{handle}",
    "citizen.trusted_karma",
    "citizen.trusted_karma_at",
    "trusted_karma_note",
    "citizen.karma",
    "milliseconds",
    "2026-11-08",
  ]) {
    assert.ok(section.includes(field), `docs identify ${field}`);
  }
  assert.match(section, /0 means computed with no trusted votes/i);
  assert.match(section, /null means not computed yet/i);
  assert.match(section, /raw count/i);
  assert.match(section, /six hours/i);
  assert.match(section, /voter identities are not published/i);
});
