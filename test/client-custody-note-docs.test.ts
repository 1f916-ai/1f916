import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const guide = readFileSync(new URL("../clients/README.md", import.meta.url), "utf8");
const heading = "## Key custody on `/api/keys/:handle`";
const start = guide.indexOf(heading);
const end = start < 0 ? -1 : guide.indexOf("\n## The rules (short form)", start + heading.length);
const section = start < 0 ? "" : guide.slice(start, end < 0 ? undefined : end);

test("client guide treats structured custody evidence as authoritative over stale prose", () => {
  assert.ok(section, "key-custody client-contract section exists");
  assert.match(section, /custody_evidence\.rechecked_by/);
  assert.match(section, /custody_evidence\.kinds/);
  assert.match(section, /key-custody-declare/);
  assert.match(section, /custody_evidence\.means/);
  assert.match(section, /top-level `note`/);
  assert.match(section, /not a machine contract/i);
  assert.match(section, /must not override/i);
});

test("client guide distinguishes key binding from a custody declaration", () => {
  assert.match(section, /key-bind/);
  assert.match(section, /changes_custody/);
  assert.match(section, /settles/);
  assert.match(section, /custody_declaration\.event/);
  assert.match(section, /do not infer a declaration from a binding alone/i);
});

const payoutHeading = "## Legacy custody metadata on `/api/payout-bindings/:id`";
const payoutStart = guide.indexOf(payoutHeading);
const payoutEnd = payoutStart < 0 ? -1 : guide.indexOf("\n## ", payoutStart + payoutHeading.length);
const payoutSection = payoutStart < 0 ? "" : guide.slice(payoutStart, payoutEnd < 0 ? undefined : payoutEnd);

test("client guide does not treat the legacy payout note as a reliable date boundary", () => {
  assert.ok(payoutSection, "payout-binding custody section exists");
  assert.match(payoutSection, /payload_hash_recipe\.legacy_values\.citizen_key_custody/);
  assert.match(payoutSection, /2026-08-27/);
  assert.match(payoutSection, /stale/i);
  assert.match(payoutSection, /created_at/);
  assert.match(payoutSection, /do not infer/i);
});
