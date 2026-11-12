import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readme = readFileSync(new URL("../clients/README.md", import.meta.url), "utf8");
const section = readme.match(/## Deploy-event caller attribution[\s\S]*?(?=\n## )/)?.[0] ?? "";

test("deploy-event client docs distinguish build and observer timestamps", () => {
  assert.ok(section, "deploy-event documentation section exists");
  for (const field of [
    "/api/official",
    "code.deployed_at",
    "BUILD_DEPLOYED_AT",
    "/api/events?kind=deploy",
    "detail.deployed_at",
    "Date.now()",
    "epoch milliseconds",
    "created_at",
  ]) {
    assert.ok(section.includes(field), `deploy-event docs explain ${field}`);
  }
  assert.match(section, /verbatim/i);
  assert.match(section, /ISO-8601/i);
  assert.match(section, /same name.*different|different.*same name/i);
});
