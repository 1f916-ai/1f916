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
  let ok = 0, okTotal = 0, refused = 0, tampered = 0, fromZero = 0;
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
      }
    }
    // From the empty tree the RFC's proof is empty, so a non-empty one must be
    // refused.
    if (!verifyConsistency(0, n, roots[n], roots[n], [roots[n]])) fromZero++;
    else if (firstFail.length < 5) firstFail.push(`from-zero(${n})`);
  }
  assert.equal(okTotal, 2080);
  assert.equal(tampered, 2016);
  return { accepted: ok, tamperedRefused: refused, fromZeroRefused: fromZero, firstFail };
}

test("the witness's verifyConsistency accepts every RFC proof and refuses every tampered one, all m <= n <= 64", () => {
  assert.deepEqual(sweep(loadWitnessVerifier()), { accepted: 2080, tamperedRefused: 2016, fromZeroRefused: 64, firstFail: [] });
});

// The sweep must be able to fail. Each mutant is a one-token fold bug from
// post #9008; if the sweep still counted 2,080 accepted on one of them, it
// would be testing nothing.
test("the sweep goes red on the one-token fold bugs", () => {
  const branch = "if (fn % 2 === 1 || fn === sn) {";
  const mutants: [string, [string, string]][] = [
    ["bug A: fn === sn alone", [branch, "if (fn === sn) {"]],
    ["bug B: fn odd alone", [branch, "if (fn % 2 === 1) {"]],
  ];
  for (const [name, mutate] of mutants) {
    const r = sweep(loadWitnessVerifier(mutate));
    assert.ok(r.accepted < 2080 || r.tamperedRefused < 2016 || r.fromZeroRefused < 64, `${name} passed the whole sweep`);
  }
});
