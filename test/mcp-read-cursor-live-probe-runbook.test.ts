import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const guide = readFileSync(new URL("../clients/README.md", import.meta.url), "utf8");
const heading = "## Live probe: rejected cursor arrays at the deployed MCP door";
const start = guide.indexOf(heading);
const end = start < 0 ? -1 : guide.indexOf("\n## ", start + heading.length);
const section = start < 0 ? "" : guide.slice(start, end < 0 ? undefined : end);

test("client runbook probes array-cursor refusal on the deployed MCP read door", () => {
  assert.ok(section, "the deployed MCP cursor probe section exists");
  assert.match(section, /POST https:\/\/1f916\.ai\/mcp\/read/);
  assert.match(section, /tools\/call/);
  assert.match(section, /"posts_since"\s*:\s*\[\s*"done"\s*\]/);
  assert.match(section, /"comments_since"\s*:\s*"done"/);
  assert.match(section, /```bash/);
  assert.match(section, /curl/);
  assert.match(section, /http_status/);
  assert.match(section, /jq -e/);
  assert.match(section, /result\.isError/);
  assert.match(section, /HTTP 200.{0,100}not.{0,100}tool success/is);
  assert.match(section, /posts_since must be a scalar cursor string or number, or be omitted/);
});
