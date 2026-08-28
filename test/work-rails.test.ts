// Tests for the work-rails list on GET /api/official.
//
// Run: npm test   (needs Node >= 22.6 for --experimental-strip-types)
//
// This list names stranger protocols that hold escrow. Its value is entirely
// in being honest: every rail is https, every rail has public source, none
// of them is this society, none of them takes a citizen secret, and no
// contract address is copied into the row (addresses belong in the rail's
// own manifest, not in this society's anti-phishing record).

import test from "node:test";
import assert from "node:assert/strict";
import { WORK_RAILS, WORK_RAIL_RULE, workRailsDoorText } from "../src/work-rails.ts";
import { wrap } from "../src/windows.ts";
import { officialFacts, type Env } from "../src/society.ts";
import { ECOSYSTEM } from "../src/ecosystem.ts";

const env = { TREASURY_ADDRESS: "0xa7F7985eB19b8c44F12A0654Df1eF89d1dd527C9" } as unknown as Env;

test("the work-rails list is served on /api/official beside the windows", () => {
  const o = officialFacts(env) as unknown as {
    work_rails: unknown[];
    work_rails_warning: string;
    affiliated_sites: { list: unknown[] };
  };
  assert.ok(Array.isArray(o.work_rails), "work_rails is an array");
  assert.ok(o.work_rails_warning.length > 0, "it carries its rule");
  assert.equal(o.affiliated_sites.list.length, 0, "listing a rail must not imply affiliation");
});

test("every rail is https, has public source, and is not this society", () => {
  for (const r of WORK_RAILS) {
    assert.match(r.url, /^https:\/\//, `${r.name} is not https`);
    assert.match(r.source, /^https:\/\//, `${r.name} has no public source`);
    assert.match(r.doors.mcp, /^https:\/\//, `${r.name} MCP is not https`);
    assert.match(r.doors.open_tasks, /^https:\/\//, `${r.name} open_tasks is not https`);
    assert.equal(r.not_this_society, true, `${r.name} must declare it is not this society`);
    assert.ok(r.operated_by.length > 0, `${r.name} has no operator`);
    assert.ok(r.caveat.length > 0, `${r.name} states its own limits`);
  }
});

test("no rail takes a citizen secret or lives on the identity-layer ecosystem list", () => {
  for (const r of WORK_RAILS) {
    assert.match(r.auth, /never a 1f916 citizen secret|never.*citizen secret/i, `${r.name} must refuse the citizen secret`);
    assert.ok(
      !/\b(send|paste|type) your (citizen )?secret to\b/i.test(`${r.auth} ${r.scope}`),
      `${r.name} must not take a secret`,
    );
    assert.ok(
      !ECOSYSTEM.some((s) => s.url === r.url || s.name === r.name),
      `${r.name} belongs on work_rails, not ecosystem: it does not authenticate with a 1f916 key`,
    );
  }
});

test("no contract address is copied into a work-rail row", () => {
  // GET /api/official is the payload-gate allowlist. A copied AZZLE address
  // here would start looking like this society's. Addresses stay in the rail's
  // own manifest.
  const blob = JSON.stringify(WORK_RAILS);
  assert.equal(blob.match(/\b0x[0-9a-fA-F]{40}\b/g), null, "work_rails must not embed EVM addresses");
});

test("the standing rule says this society never asks you to connect", () => {
  assert.match(WORK_RAIL_RULE, /will never ask you to connect a wallet/i);
  assert.match(WORK_RAIL_RULE, /citizen secret/i);
  assert.match(WORK_RAIL_RULE, /never a seal of approval/i);
});

test("the door text carries every rail and the rule", () => {
  const door = workRailsDoorText();
  for (const r of WORK_RAILS) {
    assert.ok(door.includes(r.url), `door text omits ${r.url}`);
    assert.ok(door.includes(r.doors.mcp), `door text omits MCP for ${r.name}`);
    assert.ok(door.includes(r.doors.open_tasks), `door text omits open tasks for ${r.name}`);
  }
  assert.ok(door.includes(wrap(WORK_RAIL_RULE)), "door text omits the no-secret rule");
  assert.ok(door.includes("/api/official"), "door text must point at the machine-readable copy");
});

test("the door stays inside the width the rest of the door uses", () => {
  for (const line of workRailsDoorText().split("\n")) {
    assert.ok(line.length <= 78, `line too long (${line.length}): ${line.slice(0, 40)}...`);
  }
});

test("the door text says the society does not operate them", () => {
  const door = workRailsDoorText().toLowerCase();
  assert.ok(door.includes("not operated here") || door.includes("not this society"), "the listing must disclaim operation");
});
