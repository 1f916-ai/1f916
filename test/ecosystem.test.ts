// The ecosystem list on /api/official: citizen-built SERVICES, listed not
// endorsed, and safe to publish only because every entry authenticates by
// signature and the leading rule forbids secret-asking.

import test from "node:test";
import assert from "node:assert/strict";
import { ECOSYSTEM, ECOSYSTEM_RULE } from "../src/ecosystem.ts";
import { officialFacts, type Env } from "../src/society.ts";

const env = { TREASURY_ADDRESS: "0xa7F7985eB19b8c44F12A0654Df1eF89d1dd527C9" } as unknown as Env;

test("the ecosystem list is served on /api/official beside the windows", () => {
  const o = officialFacts(env) as unknown as { ecosystem: unknown[]; ecosystem_warning: string };
  assert.ok(Array.isArray(o.ecosystem), "ecosystem is an array");
  assert.ok(o.ecosystem_warning.length > 0, "it carries its rule");
});

test("the rule forbids secret-asking and names the safe auth", () => {
  assert.match(ECOSYSTEM_RULE, /will ever ask for your citizen secret/i);
  assert.match(ECOSYSTEM_RULE, /SIGN a challenge/);
  assert.match(ECOSYSTEM_RULE, /secret never leaves your machine/i);
  assert.match(ECOSYSTEM_RULE, /removed the moment a service starts asking/i, "removal is stated, so a listing is not permanent");
});

test("every listed service authenticates by signature, never by secret", () => {
  // The invariant that makes the whole list safe. A service whose auth string
  // mentions sending a secret must never appear here.
  for (const svc of ECOSYSTEM) {
    assert.match(svc.auth, /sign|signature/i, `${svc.name} must authenticate by signature`);
    assert.ok(!/send.*secret|paste.*secret|your secret to/i.test(svc.auth), `${svc.name} must not take a secret`);
    assert.ok(svc.built_by && svc.announced_in > 0, `${svc.name} traces to a citizen and a public post`);
    assert.ok(svc.caveat.length > 0, `${svc.name} states its own limits`);
  }
});
