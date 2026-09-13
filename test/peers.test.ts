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

test("every peer traces to a public source, and an announce post is claimed only when there is one", () => {
  // THIS TEST USED TO ASSERT A GUARANTEE THIS FILE COULD NOT KEEP. It required
  // every peer to carry a positive announced_in, and the 1F3EA entry satisfied
  // it with post 1073 -- a post that does not name 1F3EA. Measured 2026-09-11:
  // GET /api/post/1073 returns the post and all five of its comments, 14,400
  // bytes, with zero occurrences of "1f3ea" and zero of "market". A required
  // field that can be filled with any number does not prove provenance; it only
  // proves somebody typed a number.
  //
  // The real guarantee is the one the module states: no public source, no
  // listing. A square post is a bonus, and when there is none the field is null
  // and the door says so rather than naming a post that says nothing.
  //
  // KILLING MUTATION: set 1F3EA's announced_in back to 1073 (or any number).
  // This stays green -- which is the point -- but the served-truth test below
  // goes red, because the door would then claim a post that does not name it.
  for (const p of KNOWN_PEERS) {
    assert.ok(p.source.length > 0, `${p.name} has no source`);
    assert.ok(p.announced_in === null || (Number.isInteger(p.announced_in) && p.announced_in > 0), `${p.name} has a malformed announced_in`);
    assert.ok(p.run_by.length > 0, `${p.name} has no run_by`);
    assert.ok(p.physics.length > 0, `${p.name} has no physics`);
    assert.ok(p.mark.length > 0, `${p.name} has no mark`);
  }
});

test("the door claims a naming post only for peers that have one", () => {
  // KILLING MUTATION: in peersDoorText, drop the null branch so every peer
  // renders "named on the square in post ${p.announced_in}". A null peer then
  // serves "post null" and this goes red.
  const door = peersDoorText();
  for (const p of KNOWN_PEERS) {
    if (p.announced_in === null) {
      assert.ok(
        !new RegExp(`named on the square in post[^\\n]*${p.name}`).test(door),
        `${p.name} has no naming post but the door claims one`,
      );
    } else {
      assert.ok(door.includes(`post ${p.announced_in}`), `${p.name}'s naming post is not on the door`);
    }
  }
  assert.ok(!/post null|post undefined|post NaN/.test(door), "the door renders a missing post as a word, not as a value");
});

test("a peer's mark names the codepoint it actually is", () => {
  // 1F3EA shipped as "U+1F3EA DEPARTMENT STORE". U+1F3EA is CONVENIENCE STORE;
  // DEPARTMENT STORE is U+1F3EC. The peer's own front door agrees with Unicode
  // and not with us: 1f3ea.com reads "1F3EA (U+1F3EA, CONVENIENCE STORE)".
  //
  // Node ships no character-name API, so this table is PINNED rather than
  // derived, and it is deliberately tiny: it holds only the codepoints this
  // registry actually serves. A new peer with an unlisted codepoint fails here
  // and the author has to look the name up, which is the behaviour I want --
  // the alternative is a test that silently skips whatever it does not know.
  //
  // KILLING MUTATION: restore "U+1F3EA DEPARTMENT STORE". Goes red.
  const UNICODE_NAMES = new Map<string, string>([
    ["1F3D9", "CITYSCAPE"],
    ["1F3EA", "CONVENIENCE STORE"],
  ]);
  for (const p of KNOWN_PEERS) {
    const m = /^U\+([0-9A-F]{4,6})\s+(.+)$/.exec(p.mark);
    if (!m) continue; // the interface allows short prose when there is no codepoint
    const expected = UNICODE_NAMES.get(m[1]!.toUpperCase());
    assert.ok(expected, `${p.name} serves U+${m[1]}, which this test has no pinned name for; look it up and add it`);
    assert.equal(m[2]!.trim().toUpperCase(), expected, `${p.name}: U+${m[1]} is ${expected}`);
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
    // Only a peer that HAS a naming post can have it on the door. String(null)
    // is "null", so the old assertion would have been satisfied by the door
    // rendering the word "null" -- a check that passes on the broken output.
    if (p.announced_in !== null) {
      assert.ok(door.includes(String(p.announced_in)), `door text omits announce post of ${p.name}`);
    }
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
