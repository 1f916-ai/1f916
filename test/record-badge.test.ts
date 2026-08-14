// P4/P5 input hardening: the badge is served cross-origin cacheable SVG, so
// handle content must never break out of text nodes; domain validation gates
// a server-side fetch (SSRF surface), so only bare registrable hostnames pass.

import test from "node:test";
import assert from "node:assert/strict";
import { badgeSvg } from "../src/record.ts";
import { validateDomain } from "../src/bindings.ts";
import { SocietyError } from "../src/society.ts";

test("badge SVG strips markup-significant characters from the handle", () => {
  const svg = badgeSvg('a"><script>alert(1)</script>', { key: "bound", seals: 3, since: "2026-08" });
  assert.doesNotMatch(svg, /<script/);
  assert.match(svg, /ascriptalert\(1\)\/script/, "stripped to inert text, not silently dropped");
});

test("badge value carries facts, never the handle, and color keys to the bound-key fact", () => {
  const bound = badgeSvg("someone", { key: "bound", seals: 91, since: "2026-08" });
  assert.match(bound, /key bound · 91 seals · since 2026-08/);
  assert.doesNotMatch(bound, />someone</, "the visible value repeats no name the README already shows");
  assert.match(bound, /#2da44e/);

  const revoked = badgeSvg("someone", { key: "revoked", seals: 0, since: "2026-08" });
  assert.match(revoked, /key revoked/);
  assert.doesNotMatch(revoked, /0 seals/, "a zero count is noise, not a fact worth a slot");
  assert.match(revoked, /#d29922/);
  assert.doesNotMatch(revoked, /#2da44e/, "mere existence never earns the green a bound key earns");

  const none = badgeSvg("someone", { key: "none", seals: 1, since: "2026-08" });
  assert.match(none, /no key · 1 seal · since 2026-08/);
  assert.match(none, /#6e7781/);
});

test("badge for an unknown handle still answers, in grey, saying unknown", () => {
  const svg = badgeSvg("no-such-name", null);
  assert.match(svg, />unknown</);
  assert.match(svg, /#8b949e/);
  assert.doesNotMatch(svg, /key|seal|since/, "no invented facts about a record that does not exist");
});

test("a malformed since is dropped rather than rendered", () => {
  const svg = badgeSvg("someone", { key: "bound", seals: 0, since: "garbage" });
  assert.doesNotMatch(svg, /since/);
  assert.match(svg, /key bound/);
});

test("domain validation admits hostnames and refuses SSRF shapes", () => {
  assert.equal(validateDomain("Example.COM."), "example.com");
  assert.equal(validateDomain("sub.domain.example.co.uk"), "sub.domain.example.co.uk");
  for (const bad of ["localhost", "127.0.0.1", "http://x.com", "x.com/path", "x", "-a.com", "a_b.com", "internal", "10.0.0.1", "[::1]", "x.com:8080"]) {
    assert.throws(() => validateDomain(bad), SocietyError, `must refuse '${bad}'`);
  }
});
