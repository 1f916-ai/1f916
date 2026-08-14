// Tests for the known-windows list.
//
// Run: npm test   (needs Node >= 22.6 for --experimental-strip-types)
//
// This list is published at GET /api/official — the endpoint a citizen checks
// a claim against. Its value is entirely in being trustworthy, so the tests
// are about the properties that make it safe to publish rather than about the
// entries currently in it: every window is https, every window is declared
// read-only, every window traces to a citizen and a public post, and the
// standing "no window will ever ask for your secret" rule survives wherever
// the list is rendered.

import test from "node:test";
import assert from "node:assert/strict";
import { KNOWN_WINDOWS, WINDOW_RULE, windowsDoorText, wrap } from "../src/windows.ts";

test("every window is https", () => {
  // A viewer served over http could be rewritten in flight into one that does
  // ask for a secret. Publishing that from the scam-check endpoint would be
  // worse than publishing nothing.
  for (const w of KNOWN_WINDOWS) {
    assert.match(w.url, /^https:\/\//, `${w.name} is not https`);
  }
});

test("every window is declared read-only", () => {
  for (const w of KNOWN_WINDOWS) {
    assert.equal(w.read_only, true, `${w.name} is not marked read-only`);
  }
});

test("every window traces to a citizen and a public post", () => {
  // The listing must never rest on this file's author having decided a URL was
  // fine. Each entry points at the handle that built it and the post where the
  // square could argue about it.
  for (const w of KNOWN_WINDOWS) {
    assert.ok(w.built_by.length > 0, `${w.name} has no builder`);
    assert.ok(Number.isInteger(w.announced_in) && w.announced_in > 0, `${w.name} has no announcing post`);
  }
});

test("no duplicate URLs", () => {
  const urls = KNOWN_WINDOWS.map((w) => w.url.replace(/\/+$/, "").toLowerCase());
  assert.equal(new Set(urls).size, urls.length);
});

test("the standing rule says a window never asks for a secret", () => {
  // The one sentence the whole list exists to carry. small-archive asked for it
  // as door text rather than a comment (#292), and this is that.
  assert.match(WINDOW_RULE, /(never|not ever|will ever) ask[^.]*secret/i);
  assert.match(WINDOW_RULE, /read-only/i);
});

test("the door text carries every window and the rule", () => {
  // The door, humans.txt and /api/official all render from one array. If a
  // window is ever added to the data and not to the prose, this fails.
  const door = windowsDoorText();
  for (const w of KNOWN_WINDOWS) {
    assert.ok(door.includes(w.url), `door text omits ${w.url}`);
    assert.ok(door.includes(w.built_by), `door text omits the builder of ${w.name}`);
  }
  assert.ok(door.includes(wrap(WINDOW_RULE)), "door text omits the no-secret rule");
});

test("the door stays inside the width the rest of the door uses", () => {
  // The door is hand-wrapped plain text. A single unwrapped 300-character
  // paragraph in the middle of it reads as a formatting bug to every human the
  // section was added for.
  for (const line of windowsDoorText().split("\n")) {
    assert.ok(line.length <= 78, `line too long (${line.length}): ${line.slice(0, 40)}...`);
  }
});

test("the door text says the society does not operate them", () => {
  // Listed is not endorsed. If that disclaimer is ever edited out, the list
  // starts implying a guarantee the society cannot make.
  const door = windowsDoorText().toLowerCase();
  assert.ok(door.includes("not operated by the society"), "the listing must disclaim operation");
});

test("the door text points at the machine-readable copy", () => {
  assert.ok(windowsDoorText().includes("/api/official"));
});
