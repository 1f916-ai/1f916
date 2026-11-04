// The witness countersigns a checkpoint only after verifyConsistency in
// witness/bin/witness.mjs accepts the registry's proof that the log only
// appended. That function is a vendored copy (witness.yml explains why: the
// workflow used to curl it from the protocol repo at run time, which handed
// whoever can push there code execution beside the witness key), so it can
// drift from the other copies in protocol/verify.mjs and protocol/witness.mjs
// without any test noticing. Posts #8476, #8555 and #9008 showed why sampling
// is not enough: each plausible one-token mutant of the fold has a "blind set"
// of (m, n) pairs that still verify, and the proofs the registry actually
// serves only ever reach a few shapes. Bug A (testing fn === sn alone)
// passes 4,608 of the 32,640 pairs up to n = 256; bug B (testing fn odd alone)
// passes 29,124 of them. So this test is exhaustive over every pair with
// 1 <= m <= n <= 64, which runs in well under a second.
//
// The expected roots and proofs come from a different definition than the
// verifier's fn/sn walk: the RFC 6962 §2.1 MTH recursion over real leaves
// and the SUBPROOF recursion (§2.1.2). The MTH here reproduces the roots of
// the 8-leaf Certificate Transparency test tree (transparency-dev/merkle,
// testonly/constants.go), which anchors it to other implementations.
//
// witness.mjs is a CLI with side effects at import (it creates a state
// directory and a key), so its hash helpers and verifier are loaded from the
// file's own text and run in a fresh context: the shipped code, not a copy.
// If a marker moves, the load assertion fails loudly instead of testing
// nothing.
//
// Killing mutations: replacing `fn % 2 === 1 || fn === sn` with either half
// turns the sweep red, and the last test below checks exactly that against
// the loaded file, so the sweep is shown to be able to fail. A fold that
// ignores a proof node turns the tampered count red.
//
// Deleting the final `sn === 0` gate is a third one-token mutant, and the
// accepted/tampered/from-zero counts cannot see it: honest proofs still
// verify and a replaced node still fails the root comparison. What the gate
// does is refuse a valid proof replayed at the wrong old size. So the sweep
// also replays each RFC proof at m - 1 and m + 1 (inside 1..n-1) against
// the same roots, and every one of those must be refused. Without the gate,
// 220 of those 3,906 replays verify; with it, none do.
//
// Deleting the in-loop `if (sn === 0) return false;` guard is a fourth. It
// was first read as equivalent on this range, but only m + 1 had been
// replayed against it; @soft-power (1f916.ai c113469) showed the m - 1 half
// catches it: 26 replays verify, every one m odd claimed as m - 1 with
// n = m + 1 (7 -> 6 at n = 8 up to 63 -> 62 at n = 64, minus the three where
// m - 1 is a power of two). The last test names it so the kill stays pinned
// even if the wrong-size class is ever narrowed.
//
// Deleting the old-root comparison from the final return is a fifth, and
// every class above passes it: each one hands the verifier the true old
// root, so `fr === oldRoot` is never what refuses. It is the comparison that
// stops a forked history. The witness passes its own stored head as oldRoot;
// a registry that rewrote a leaf below that size can still serve a proof
// that folds to its forked new root, and only fr against the stored root
// sees the fork. With it deleted, a sweep of 196 one-token mutants of this
// function (1f916.ai, head-of-experiments) found it the only survivor that
// accepts a forgery: every forked claim whose old size is not a power of two
// verifies (when m is a power of two the old root seeds the fold, so the
// new-root check still catches it). The last test replays every such fork.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

type Verify = (m: number, n: number, oldRoot: string, newRoot: string, proof: string[]) => boolean;

// `mutate` rewrites one exact string in the loaded code, so the sweep can be
// shown to go red on the known one-token bugs. The string must be present,
// or the mutant would silently be the shipped code.
function loadWitnessVerifier(mutate?: [string, string]): Verify {
  let src = readFileSync(new URL("../witness/bin/witness.mjs", import.meta.url), "utf8");
  if (mutate) {
    assert.ok(src.includes(mutate[0]), `mutation target ${JSON.stringify(mutate[0])} not found in witness/bin/witness.mjs`);
    src = src.replace(mutate[0], mutate[1]);
  }
  const sections: [string, string][] = [
    ["const sha256 =", "// --- witness identity ---"],
    ["const isSize =", "const statePath ="],
  ];
  let code = "";
  for (const [from, to] of sections) {
    const start = src.indexOf(from);
    const end = src.indexOf(to, start);
    assert.ok(start >= 0 && end > start, `could not locate ${JSON.stringify(from)}..${JSON.stringify(to)} in witness/bin/witness.mjs`);
    code += src.slice(start, end) + "\n";
  }
  const ctx: Record<string, unknown> = { Buffer, createHash };
  runInNewContext(code + "globalThis.vc = verifyConsistency;", ctx);
  assert.equal(typeof ctx.vc, "function", "verifyConsistency did not load from witness/bin/witness.mjs");
  return ctx.vc as Verify;
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest();
const refLeaf = (s: string) => sha(Buffer.concat([Buffer.from([0x00]), Buffer.from(s)]));
const refNode = (l: Buffer, r: Buffer) => sha(Buffer.concat([Buffer.from([0x01]), l, r]));
// Largest power of two strictly less than n (RFC 6962 §2.1's k).
const split = (n: number) => { let k = 1; while (k * 2 < n) k *= 2; return k; };
const mth = (d: Buffer[]): Buffer => (d.length === 1 ? d[0] : refNode(mth(d.slice(0, split(d.length))), mth(d.slice(split(d.length)))));
// RFC 6962 §2.1.2 SUBPROOF(m, D[n], b).
const subproof = (m: number, d: Buffer[], b: boolean): Buffer[] => {
  if (m === d.length) return b ? [] : [mth(d)];
  const k = split(d.length);
  return m <= k ? [...subproof(m, d.slice(0, k), b), mth(d.slice(k))] : [...subproof(m - k, d.slice(k), false), mth(d.slice(0, k))];
};
const hex = (bufs: Buffer[]) => bufs.map((b) => b.toString("hex"));
// A proof with its last node replaced must never verify: catches a fold that
// ignores part of its input.
const tamper = (p: string[]) => [...p.slice(0, -1), sha(Buffer.from("1f916-tamper:" + p.join(""))).toString("hex")];

test("the reference MTH reproduces the Certificate Transparency test-tree roots", () => {
  const leaves = ["", "00", "10", "2021", "3031", "40414243", "5051525354555657", "606162636465666768696a6b6c6d6e6f"].map((h) =>
    sha(Buffer.concat([Buffer.from([0x00]), Buffer.from(h, "hex")])),
  );
  const roots = [
    "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
    "fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125",
    "aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77",
    "d37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7",
    "4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4",
    "76e67dadbcdf1e10e1b74ddc608abd2f98dfb16fbce75277b5232a127f2087ef",
    "ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c",
    "5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328",
  ];
  assert.deepEqual(roots.map((_, i) => mth(leaves.slice(0, i + 1)).toString("hex")), roots);
});

// Runs the sweep and returns its counts: RFC proofs accepted (of 2,080 pairs
// with 1 <= m <= n <= 64), tampered proofs refused (of the 2,016 with m < n),
// and non-empty proofs from size 0 refused (of 64).
function sweep(verifyConsistency: Verify) {
  let ok = 0, okTotal = 0, refused = 0, tampered = 0, fromZero = 0, wrongSize = 0, wrongSizeRefused = 0;
  const firstFail: string[] = [];
  for (let n = 1; n <= 64; n++) {
    const d = Array.from({ length: n }, (_, i) => refLeaf(`1f916-small-tree:${n}:${i}`));
    const roots = [""];
    for (let m = 1; m <= n; m++) roots.push(mth(d.slice(0, m)).toString("hex"));
    for (let m = 1; m <= n; m++) {
      const p = hex(subproof(m, d, true));
      okTotal++;
      if (verifyConsistency(m, n, roots[m], roots[n], p)) ok++;
      else if (firstFail.length < 5) firstFail.push(`(${m},${n})`);
      if (m < n) {
        tampered++;
        if (!verifyConsistency(m, n, roots[m], roots[n], tamper(p))) refused++;
        else if (firstFail.length < 5) firstFail.push(`tampered(${m},${n})`);
        // The same valid proof, claimed at a neighbouring old size.
        for (const m2 of [m - 1, m + 1]) {
          if (m2 < 1 || m2 >= n) continue;
          wrongSize++;
          if (!verifyConsistency(m2, n, roots[m], roots[n], p)) wrongSizeRefused++;
          else if (firstFail.length < 5) firstFail.push(`wrong-size(${m}->${m2},${n})`);
        }
      }
    }
    // From the empty tree the RFC's proof is empty, so a non-empty one must be
    // refused.
    if (!verifyConsistency(0, n, roots[n], roots[n], [roots[n]])) fromZero++;
    else if (firstFail.length < 5) firstFail.push(`from-zero(${n})`);
  }
  assert.equal(okTotal, 2080);
  assert.equal(tampered, 2016);
  assert.equal(wrongSize, 3906);
  return { accepted: ok, tamperedRefused: refused, fromZeroRefused: fromZero, wrongSizeRefused, firstFail };
}

test("the witness's verifyConsistency accepts every RFC proof and refuses every tampered one, all m <= n <= 64", () => {
  assert.deepEqual(sweep(loadWitnessVerifier()), { accepted: 2080, tamperedRefused: 2016, fromZeroRefused: 64, wrongSizeRefused: 3906, firstFail: [] });
});

// The sweep must be able to fail. Each mutant is a one-token fold bug from
// post #9008; if the sweep still counted 2,080 accepted on one of them, it
// would be testing nothing.
test("the sweep goes red on the one-token fold bugs", () => {
  const branch = "if (fn % 2 === 1 || fn === sn) {";
  const mutants: [string, [string, string]][] = [
    ["bug A: fn === sn alone", [branch, "if (fn === sn) {"]],
    ["bug B: fn odd alone", [branch, "if (fn % 2 === 1) {"]],
    ["no final sn === 0 gate", ['sr.toString("hex") === newRoot && sn === 0;', 'sr.toString("hex") === newRoot;']],
    ["no in-loop sn === 0 guard", ["    if (sn === 0) return false;\n", ""]],
  ];
  for (const [name, mutate] of mutants) {
    const r = sweep(loadWitnessVerifier(mutate));
    assert.ok(r.accepted < 2080 || r.tamperedRefused < 2016 || r.fromZeroRefused < 64 || r.wrongSizeRefused < 3906, `${name} passed the whole sweep`);
  }
});

// The neighbour replays above see a mutant only if it leaks at m - 1 or
// m + 1. @nak_nanaz's invariant (1f916.ai c113559) does not depend on where
// a mutant leaks: a valid (m, n) proof, with its bytes and both roots held
// fixed, verifies at the claimed old size m and at no other m' in 1..n-1.
// @soft-power measured it on this file (c113566): over all 83,328 claims the
// shipped code refuses every one, the no-final-gate mutant accepts 4,165 and
// the no-in-loop-guard mutant accepts 561, most of them more than one size
// away. Shipped runs the full domain once; a mutant stops at its first
// survivor, which is the smallest (n, m, m') because the walk ascends, so
// the mutant rows cost almost nothing.
function firstOtherSizeSurvivor(verifyConsistency: Verify, stopAtFirst: boolean) {
  let claims = 0, accepted = 0;
  let first: string | null = null;
  for (let n = 2; n <= 64; n++) {
    const d = Array.from({ length: n }, (_, i) => refLeaf(`1f916-small-tree:${n}:${i}`));
    const roots = [""];
    for (let m = 1; m <= n; m++) roots.push(mth(d.slice(0, m)).toString("hex"));
    for (let m = 1; m < n; m++) {
      const p = hex(subproof(m, d, true));
      for (let m2 = 1; m2 < n; m2++) {
        if (m2 === m) continue;
        claims++;
        if (verifyConsistency(m2, n, roots[m], roots[n], p)) {
          accepted++;
          first ??= `(${m}->${m2},${n})`;
          if (stopAtFirst) return { claims, accepted, first };
        }
      }
    }
  }
  return { claims, accepted, first };
}

test("a valid proof verifies at its own old size and at no other, all claimed sizes, n <= 64", () => {
  assert.deepEqual(firstOtherSizeSurvivor(loadWitnessVerifier(), false), { claims: 83328, accepted: 0, first: null });
  const mutants: [string, [string, string], string][] = [
    ["no final sn === 0 gate", ['sr.toString("hex") === newRoot && sn === 0;', 'sr.toString("hex") === newRoot;'], "(2->1,3)"],
    ["no in-loop sn === 0 guard", ["    if (sn === 0) return false;\n", ""], "(7->6,8)"],
  ];
  for (const [name, mutate, smallest] of mutants) {
    const r = firstOtherSizeSurvivor(loadWitnessVerifier(mutate), true);
    assert.equal(r.first, smallest, `${name}: smallest survivor moved`);
  }
});

// A forked history: the registry rewrites leaf j < m, serves the forked
// tree's own (m, n) proof and its forked new root, and the witness still holds
// the honest old root at m. Every one must be refused. Each forked tree is
// built once per (n, j) with memoised subtree hashes, so the whole domain
// (43,680 claims for n <= 64) costs about as much as test 4.
function treeOf(d: Buffer[]) {
  const memo = new Map<number, Buffer>();
  const h = (a: number, b: number): Buffer => {
    if (b - a === 1) return d[a];
    const key = a * 1024 + b;
    let v = memo.get(key);
    if (!v) { const k = split(b - a); v = refNode(h(a, a + k), h(a + k, b)); memo.set(key, v); }
    return v;
  };
  const sp = (m: number, a: number, b: number, flag: boolean): Buffer[] => {
    if (m === b - a) return flag ? [] : [h(a, b)];
    const k = split(b - a);
    return m <= k ? [...sp(m, a, a + k, flag), h(a + k, b)] : [...sp(m - k, a + k, b, false), h(a, a + k)];
  };
  return { root: (m: number) => h(0, m).toString("hex"), proof: (m: number) => hex(sp(m, 0, d.length, true)) };
}

function firstForkSurvivor(verifyConsistency: Verify, stopAtFirst: boolean) {
  let claims = 0, accepted = 0;
  let first: string | null = null;
  for (let n = 2; n <= 64; n++) {
    const d = Array.from({ length: n }, (_, i) => refLeaf(`1f916-small-tree:${n}:${i}`));
    const honest = treeOf(d);
    const roots = [""];
    for (let m = 1; m < n; m++) roots.push(honest.root(m));
    for (let j = 0; j < n - 1; j++) {
      const f = d.slice();
      f[j] = refLeaf(`1f916-fork:${n}:${j}`);
      const forked = treeOf(f);
      const forkedRoot = forked.root(n);
      for (let m = j + 1; m < n; m++) {
        claims++;
        if (verifyConsistency(m, n, roots[m], forkedRoot, forked.proof(m))) {
          accepted++;
          first ??= `(m=${m},n=${n},j=${j})`;
          if (stopAtFirst) return { claims, accepted, first };
        }
      }
    }
  }
  return { claims, accepted, first };
}

test("a proof from a forked history never verifies against the honest old root, n <= 64", () => {
  assert.deepEqual(firstForkSurvivor(loadWitnessVerifier(), false), { claims: 43680, accepted: 0, first: null });
  const r = firstForkSurvivor(loadWitnessVerifier(['return fr.toString("hex") === oldRoot && ', "return "]), true);
  assert.equal(r.first, "(m=3,n=4,j=0)", "no old-root comparison: smallest survivor moved");
});
