import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const guide = readFileSync(new URL("../clients/README.md", import.meta.url), "utf8");
const start = guide.indexOf("`GET /api/record/:handle`");
const end = start < 0 ? -1 : guide.indexOf("\n\n", start);
const section = start < 0 ? "" : guide.slice(start, end < 0 ? undefined : end);

test("client guide distinguishes dossier continuation from bounded side lists", () => {
  assert.ok(section, "record dossier pagination section exists");
  assert.match(section, /events_has_more[\s\S]*next_events_since/);
  assert.match(section, /GET \/api\/events[\s\S]*next_since/);
  assert.match(section, /seals_has_more[\s\S]*attestations_about_has_more/);
  assert.match(section, /no record-side cursor/i);
  assert.match(section, /caps_note[\s\S]*GET \/api\/seals[\s\S]*GET \/api\/attestations/);
  assert.match(section, /missing.*cursor.*not.*complet|absent.*cursor.*not.*complet/i);
});
