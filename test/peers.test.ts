// Tests for the known-peers list.
//
// Run: npm test
//
// Peer worlds are published at GET /api/official. Their value is entirely in
// being trustworthy and NOT implying affiliation, so the tests guard the
// properties that make the list safe: https, public source, a square announce
// post, no duplicates, and the standing no-partnership rule surviving wherever
// the list is rendered.

import test from "node:test";
import assert from "node:assert/strict";
import { KNOWN_PEERS, PEER_RULE, peersDoorText, wrap } from "../src/peers.ts";

test("every peer is https", () => {
  for (const p of KNOWN_PEERS) {
    assert.match(p.url, /^https:\/\//, `${p.name} is not https`);
    assert.match(p.source, /^https:\/\//, `${p.name} source is not https`);
  }
});

test("every peer traces to a public announce post and a source repo", () => {
  for (const p of KNOWN_PEERS) {
    assert.ok(p.source.length > 0, `${p.name} has no source`);
    assert.ok(Number.isInteger(p.announced_in) && p.announced_in > 0, `${p.name} has no announcing post`);
    assert.ok(p.run_by.length > 0, `${p.name} has no run_by`);
    assert.ok(p.physics.length > 0, `${p.name} has no physics`);
    assert.ok(p.mark.length > 0, `${p.name} has no mark`);
  }
});

test("no duplicate peer URLs", () => {
  const urls = KNOWN_PEERS.map((p) => p.url.replace(/\/+$/, "").toLowerCase());
  assert.equal(new Set(urls).size, urls.length);
});

test("the standing rule refuses partnership and secret-paste", () => {
  assert.match(PEER_RULE, /no partnership/i);
  assert.match(PEER_RULE, /operated by this society/i);
  assert.match(PEER_RULE, /^No peer world/i);
  assert.match(PEER_RULE, /secret/i);
  assert.match(PEER_RULE, /never an endorsement/i);
});

test("the door text carries every peer and the rule", () => {
  const door = peersDoorText();
  for (const p of KNOWN_PEERS) {
    assert.ok(door.includes(p.url), `door text omits ${p.url}`);
    assert.ok(door.includes(p.source), `door text omits source of ${p.name}`);
    assert.ok(door.includes(String(p.announced_in)), `door text omits announce post of ${p.name}`);
  }
  assert.ok(door.includes(wrap(PEER_RULE)), "door text omits the peer rule");
});

test("the door stays inside the width the rest of the door uses", () => {
  for (const line of peersDoorText().split("\n")) {
    // URLs and source lines may exceed wrap width; allow the structured
    // indented lines, but refuse a runaway paragraph.
    if (line.startsWith("  http") || line.trimStart().startsWith("source http")) continue;
    assert.ok(line.length <= 78, `line too long (${line.length}): ${line.slice(0, 40)}...`);
  }
});

test("the door text says the society does not operate them", () => {
  const door = peersDoorText().toLowerCase();
  assert.ok(door.includes("no partnership"), "door omits no-partnership claim");
  assert.ok(door.includes("affiliated_sites"), "door omits affiliated_sites check pointer");
});
