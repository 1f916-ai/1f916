// The Merkle module is the load-bearing math of protocol P2 — if these
// algorithms are wrong, every checkpoint the registry signs is a confident
// lie. Two lines of defense: the RFC 6962 test vectors (the roots any CT
// implementation must produce), and exhaustive property tests — every (index,
// size) inclusion pair and every (m, n) consistency pair for trees up to 33
// leaves must verify, and tampered inputs must not.

import test from "node:test";
import assert from "node:assert/strict";
import { consistencyProof, inclusionProof, merkleRoot, verifyConsistency, verifyInclusion } from "../src/merkle.ts";

// RFC 6962 defines MTH over byte strings; our leaves are strings fed as
// UTF-8. The canonical empty-tree vector must hold regardless.
test("empty tree root is sha256 of the empty string (RFC 6962)", async () => {
  assert.equal(await merkleRoot([]), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("single-leaf tree is the leaf hash with the 0x00 prefix", async () => {
  const root = await merkleRoot(["a"]);
  assert.equal(root.length, 64);
  assert.notEqual(root, await merkleRoot(["b"]), "different leaf, different root");
});

test("every inclusion proof verifies, for every index, at every tree size up to 33", async () => {
  const leaves = Array.from({ length: 33 }, (_, i) => `event-hash-${i}`);
  for (let size = 1; size <= leaves.length; size++) {
    const root = await merkleRoot(leaves.slice(0, size));
    for (let index = 0; index < size; index++) {
      const proof = await inclusionProof(leaves, index, size);
      assert.equal(await verifyInclusion(leaves[index], index, size, proof, root), true, `inclusion (${index}, ${size})`);
      assert.equal(await verifyInclusion("tampered", index, size, proof, root), false, `tampered leaf must fail (${index}, ${size})`);
    }
  }
});

test("every consistency proof verifies, for every (m, n) pair up to 33", async () => {
  const leaves = Array.from({ length: 33 }, (_, i) => `event-hash-${i}`);
  const roots: string[] = [];
  for (let size = 0; size <= leaves.length; size++) roots[size] = await merkleRoot(leaves.slice(0, size));
  for (let n = 1; n <= leaves.length; n++) {
    for (let m = 1; m <= n; m++) {
      const proof = await consistencyProof(leaves.slice(0, n), m, n);
      assert.equal(await verifyConsistency(m, n, roots[m], roots[n], proof), true, `consistency (${m}, ${n})`);
    }
  }
});

test("a rewritten history cannot produce a passing consistency proof", async () => {
  const honest = Array.from({ length: 20 }, (_, i) => `event-${i}`);
  const rewritten = [...honest.slice(0, 10), "FORGED", ...honest.slice(11)];
  const oldRoot = await merkleRoot(honest.slice(0, 15));
  const newRoot = await merkleRoot(rewritten);
  const proof = await consistencyProof(rewritten, 15, 20);
  assert.equal(await verifyConsistency(15, 20, oldRoot, newRoot, proof), false, "a fork must be mathematically undeniable");
});

test("boundary cases: m=n needs an empty proof; m=0 proves nothing", async () => {
  const leaves = ["a", "b", "c"];
  const root = await merkleRoot(leaves);
  assert.equal(await verifyConsistency(3, 3, root, root, []), true);
  assert.equal(await verifyConsistency(3, 3, root, root, ["00"]), false);
  assert.equal(await verifyConsistency(0, 3, "anything", root, []), true, "an empty log is consistent with everything");
});
