// badgeSvg is a pure function of (handle, facts), so "every badge state renders
// different bytes" is a symmetric property: four states (unknown + the three key
// states) make 6 unordered pairs, not 12 transitions. This test renders all four
// for one handle with the other facts held fixed and asserts the bytes, the
// caption and the fill color each differ pairwise, so the strong ETag on
// /badge/<handle>.svg can never certify two states as one (whitehat-explorer
// #10855, c131242).
//
// KILLING MUTATIONS (applied to a scratch copy, each watched red):
//   M1  give "revoked" the color of "none"
//       -> badge_states_must_not_share_a_fill_color red.
//   M2  give "revoked" the caption "no key"
//       -> badge_states_must_not_share_a_caption red (bytes still differ by color).
//   M3  delete the "revoked" row from BADGE_KEY_LOOK
//       -> `tsc` refuses (TS2741), which is the compile-time half.
//   M4  add a fifth member to BadgeFacts["key"] with no row
//       -> `tsc` refuses (TS2741). On the old chained ternaries the same edit
//          compiled and rendered the new state as "no key".

import test from "node:test";
import assert from "node:assert/strict";
import { badgeSvg, type BadgeFacts } from "../src/record.ts";

const KEYS: BadgeFacts["key"][] = ["bound", "revoked", "none"];
const render = () => [
  badgeSvg("someone", null),
  ...KEYS.map((key) => badgeSvg("someone", { key, seals: 2, since: "2026-08" })),
];
const fill = (svg: string) => [...svg.matchAll(/fill="(#[0-9a-f]{6})"/gi)].map((m) => m[1]).join(",");
const caption = (svg: string) => (svg.match(/aria-label="[^"]*: ([^"]*)"/) ?? [])[1] ?? "";

function assertPairwiseDistinct(values: string[], what: string) {
  for (let i = 0; i < values.length; i++)
    for (let j = i + 1; j < values.length; j++)
      assert.notEqual(values[i], values[j], `${what}: state ${i} and state ${j} collide`);
}

test("badge_states_must_not_share_bytes", () => {
  assertPairwiseDistinct(render(), "svg bytes");
});

test("badge_states_must_not_share_a_caption", () => {
  const caps = render().map(caption);
  for (const c of caps) assert.ok(c.length > 0, "caption parsed");
  assertPairwiseDistinct(caps.map((c) => c.split(" · ")[0]), "caption");
});

test("badge_states_must_not_share_a_fill_color", () => {
  assertPairwiseDistinct(render().map(fill), "fill colors");
});
