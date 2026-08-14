// The checker has to be checked first.
//
// A hand-written hash used to verify constants is worth nothing until it is
// pinned to vectors nobody here produced. These come from the Keccak team's
// published test values and from selectors that are public knowledge — ERC-20's
// balanceOf and transfer appear in every block explorer on earth, so they are
// checkable without trusting this repo.

import test from "node:test";
import assert from "node:assert/strict";
import { keccak256, selector } from "./keccak256.ts";

const bytes = (s: string) => new TextEncoder().encode(s);

test("keccak256 matches published vectors", () => {
  // The empty input. The single most-cited Keccak-256 vector there is.
  assert.equal(keccak256(new Uint8Array(0)), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(keccak256(bytes("abc")), "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
  assert.equal(
    keccak256(bytes("The quick brown fox jumps over the lazy dog")),
    "4d741b6f1eb29cb2a9b9911c82f56fa8d73b04959d3d9d222895df6c0b28aa15",
  );
});

test("keccak256 is not sha3-256 — the padding byte is the whole difference", async () => {
  // If this ever starts passing, the implementation has drifted to NIST padding
  // and every selector it certifies is wrong.
  const { createHash } = await import("node:crypto");
  const sha3 = createHash("sha3-256").update(Buffer.alloc(0)).digest("hex");
  assert.notEqual(keccak256(new Uint8Array(0)), sha3);
});

test("keccak256 spans the rate boundary correctly", () => {
  // 135, 136 and 137 bytes: one below the 136-byte rate, exactly on it, and one
  // over. The input that exactly fills a block needs an entire extra padding
  // block, which is the classic place a sponge implementation is wrong — and it
  // is wrong silently, since shorter inputs keep passing.
  assert.equal(keccak256(bytes("a".repeat(135))), "34367dc248bbd832f4e3e69dfaac2f92638bd0bbd18f2912ba4ef454919cf446");
  assert.equal(keccak256(bytes("a".repeat(136))), "a6c4d403279fe3e0af03729caada8374b5ca54d8065329a3ebcaeb4b60aa386e");
  assert.equal(keccak256(bytes("a".repeat(137))), "d869f639c7046b4929fc92a4d988a8b22c55fbadb802c0c66ebcd484f1915f39");
});

test("selector() reproduces selectors that are public knowledge", () => {
  assert.equal(selector("balanceOf(address)"), "0x70a08231");
  assert.equal(selector("transfer(address,uint256)"), "0xa9059cbb");
  assert.equal(selector("approve(address,uint256)"), "0x095ea7b3");
  assert.equal(selector("totalSupply()"), "0x18160ddd");
  assert.equal(selector("latestRoundData()"), "0xfeaf968c");
});

test("selector() is sensitive to the exact signature text", () => {
  // Whitespace, argument names and type aliases all change the hash. This is
  // why the signature in the comment must be the canonical one.
  assert.notEqual(selector("balanceOf(address)"), selector("balanceOf(address owner)"));
  assert.notEqual(selector("balanceOf(address)"), selector("balanceOf( address )"));
  assert.notEqual(selector("transfer(address,uint256)"), selector("transfer(address, uint256)"));
});
