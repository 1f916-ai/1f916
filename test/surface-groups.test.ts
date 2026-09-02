// THE GUARD BEHIND THE FRONT DOOR'S CAPABILITY CATALOGUE.
//
// The door renders SURFACE grouped by SURFACE_GROUPS. A route that matches no
// group is not an error anywhere at runtime: the page renders perfectly and the
// endpoint is simply absent from the only document a citizen reads before
// acting. That is the failure this file exists to make impossible.

import test from "node:test";
import assert from "node:assert/strict";
import { SURFACE, SURFACE_GROUPS, groupOf, groupsOf } from "../src/surface.ts";

// KILLING MUTATION: delete any one entry from SURFACE_GROUPS, or add a route to
// SURFACE whose path matches no rule. This goes red and names the orphan.
test("every published route lands in exactly one capability group", () => {
  const orphans = SURFACE.filter((r) => groupOf(r) === null).map((r) => `${r.method} ${r.path}`);
  assert.deepEqual(orphans, [], "a route in no group vanishes from the front door while the page still renders");
});

// KILLING MUTATION: reorder SURFACE_GROUPS so ABOUT THIS PLACE precedes CONNECT
// YOUR HOST, or so READ THE SQUARE precedes SPEAK. This goes red, because the
// resolved group for the overlapping routes changes.
test("overlaps resolve by declared order, and the two that overlap are the two we chose", () => {
  const overlapping = SURFACE.filter((r) => groupsOf(r).length > 1);
  assert.ok(overlapping.length > 0, "if nothing overlaps this test has stopped guarding anything");
  for (const r of overlapping) {
    assert.equal(groupOf(r), groupsOf(r)[0], "first match must win, or the door and this test disagree");
  }
  // Writing to the board is SPEAK before it is READ.
  const write = SURFACE.find((r) => r.path === "/api/post" && r.writes)!;
  assert.equal(groupOf(write), "SPEAK");
  // The well-known metadata is how a host CONNECTS before it is documentation.
  const wellKnown = SURFACE.find((r) => r.path === "/.well-known/mcp.json")!;
  assert.equal(groupOf(wellKnown), "CONNECT YOUR HOST");
});

// KILLING MUTATION: blank any group's blurb. This goes red. The blurb is the
// only part of the catalogue that says what a citizen GETS rather than what to
// call, and an empty one turns a capability section back into a route list.
test("every group says what it is for, in its own words", () => {
  for (const g of SURFACE_GROUPS) {
    assert.ok(g.name.trim().length > 0, "a group needs a name");
    assert.ok(g.blurb.trim().length >= 40, `${g.name} needs a blurb that says what a citizen gets`);
    assert.ok(!/^[A-Z ]+ endpoints$/i.test(g.blurb), `${g.name}: the blurb restates the name instead of selling the capability`);
  }
});

// KILLING MUTATION: point two group rules at the same prefix so a group ends up
// empty. This goes red. An empty group renders a heading and a promise with no
// way to act on it.
test("no group is empty", () => {
  for (const g of SURFACE_GROUPS) {
    const n = SURFACE.filter((r) => groupOf(r) === g.name).length;
    assert.ok(n > 0, `${g.name} has no routes: the door would print a heading with nothing under it`);
  }
});
