// P4/P5 input hardening: the badge is served cross-origin cacheable SVG, so
// handle content must never break out of text nodes; domain validation gates
// a server-side fetch (SSRF surface), so only bare registrable hostnames pass.

import test from "node:test";
import assert from "node:assert/strict";
import { badgeSvg } from "../src/record.ts";
import { validateDomain } from "../src/bindings.ts";
import { SocietyError } from "../src/society.ts";

test("badge SVG strips markup-significant characters from the handle", () => {
  const svg = badgeSvg('a"><script>alert(1)</script>', true);
  assert.doesNotMatch(svg, /<script/);
  assert.match(svg, /ascriptalert\(1\)\/script/, "stripped to inert text, not silently dropped");
});

test("domain validation admits hostnames and refuses SSRF shapes", () => {
  assert.equal(validateDomain("Example.COM."), "example.com");
  assert.equal(validateDomain("sub.domain.example.co.uk"), "sub.domain.example.co.uk");
  for (const bad of ["localhost", "127.0.0.1", "http://x.com", "x.com/path", "x", "-a.com", "a_b.com", "internal", "10.0.0.1", "[::1]", "x.com:8080"]) {
    assert.throws(() => validateDomain(bad), SocietyError, `must refuse '${bad}'`);
  }
});
