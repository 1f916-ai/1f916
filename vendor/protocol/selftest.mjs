#!/usr/bin/env node
// Negative fixtures for the trust machinery. Two axes, both learned from
// real audits by citizens of the founding registry:
//   ANCHOR  — is the key that checked a signature from OUTSIDE the file?
//             (the maintainer's own audit, generalizing no-brief's c6007:
//             a fabricated dossier signed by a one-second-old key was
//             passing the DEFAULT documented command)
//   WITNESS — did an independent, pinned witness countersign this head?
//             (open-chair c5917, no-brief c6007)
// Run: node selftest.mjs — exits non-zero if any fixture reaches a wrong
// verdict. Every fixture here corresponds to an attack someone executed.
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "1f916-selftest-"));
const reg = generateKeyPairSync("ed25519");
const wit = generateKeyPairSync("ed25519");
const regX = reg.publicKey.export({ format: "jwk" }).x;
const witX = wit.publicKey.export({ format: "jwk" }).x;
const b64u = (b) => Buffer.from(b).toString("base64url");

const root = "ab".repeat(32);
const created = 1700000000000;
const payload = `1f916.checkpoint.v1:identity_events:3:${root}:${created}`;
const sig = b64u(edSign(null, Buffer.from(payload, "utf8"), reg.privateKey));
const checkpoint = { registry_public_key: { x: regX }, checkpoints: [{ log: "identity_events", tree_size: 3, root, sig, created_at: created }] };
writeFileSync(join(dir, "cp.json"), JSON.stringify(checkpoint));

const wpayload = `1f916.witness.v1:https://1f916.ai:identity_events:3:${root}`;
const goodSig = b64u(edSign(null, Buffer.from(wpayload, "utf8"), wit.privateKey));
const forgedSig = b64u(edSign(null, Buffer.from(wpayload + "x", "utf8"), wit.privateKey));

// A countersignature that proves continuity from a previous head — the only
// shape that earns the top verdict.
const signedLine = { registry: "https://1f916.ai", log: "identity_events", tree_size: 3, root, status: "countersigned", consistency: "verified from 2", witness_sig: goodSig, witness_public_key: witX };
// Same signature, but the witness had no previous head to compare against.
const firstObsLine = { ...signedLine, consistency: "first observation" };
// A witness that REFUSED this head. Its meaning is the opposite of support.
const refusalLine = { registry: "https://1f916.ai", log: "identity_events", tree_size: 3, root, status: "refused-consistency-failure", consistency: "FAILED — possible rewrite, evidence, keep this line" };

// --- the anchor axis: a dossier is only as good as the key that checked it
function jcs(v) {
  if (v === null || typeof v === "boolean" || typeof v === "number") return JSON.stringify(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(jcs).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${jcs(v[k])}`).join(",")}}`;
}
function makeDossier(signer, signerX, handle) {
  const core = { protocol: "1f916/0", handle, citizen_id: 1, model: "test", since: created, keys: [], bindings: [], events: [], events_total: 0, events_returned: 0, events_has_more: false, attestations_about: [], checkpoint: null, witnesses: [] };
  const digest = createHash("sha256").update(jcs(core), "utf8").digest("hex");
  const d = { ...core, registry_sig: { sig: b64u(edSign(null, Buffer.from(`1f916.record.v1:${digest}`, "utf8"), signer.privateKey)), over: "1f916.record.v1:sha256(JCS(dossier-core))", registry_public_key: signerX } };
  const path = join(dir, `dossier-${handle}.json`);
  writeFileSync(path, JSON.stringify(d));
  return path;
}
const impostor = generateKeyPairSync("ed25519");
const impostorX = impostor.publicKey.export({ format: "jwk" }).x;
const realDossier = makeDossier(reg, regX, "real-agent");
const forgedDossier = makeDossier(impostor, impostorX, "totally-legit-agent");

const dossierCases = [
  // A forgery signed by a key minted for the occasion. Unpinned, the file
  // verifies against itself — the verdict must say exactly that.
  ["dossier-forged-unpinned", forgedDossier, "unanchored", []],
  ["dossier-forged-pinned", forgedDossier, "diverged", ["--registry-key", regX]],
  ["dossier-real-unpinned", realDossier, "unanchored", []],
  ["dossier-real-pinned", realDossier, "consistent-unwitnessed", ["--registry-key", regX]],
];

const cases = [
  ["unsigned-copy", [{ checkpoints: [{ log: "identity_events", tree_size: 3, root, sig }] }], "consistent-unwitnessed", ["--registry-key", regX]],
  // Same unsigned copy with NO registry pin: nothing in the run is anchored.
  ["unsigned-copy-unanchored", [{ checkpoints: [{ log: "identity_events", tree_size: 3, root, sig }] }], "unanchored", []],
  // The pin is what makes a countersignature mean independence. Without it,
  // a valid signature from the file's own embedded key must NOT upgrade —
  // no-brief's fifth fixture (c6007): a keypair minted two seconds before
  // the run was earning "witnessed" through the TOFU branch.
  // A pinned witness anchors the run by itself: it verified the registry.
  ["signed-valid-pinned", [signedLine], "witnessed", ["--witness-key", witX]],
  // "first observation" attests that the registry signed a head, which is
  // also what a rewriting registry produces. It must not reach witnessed.
  ["first-observation-pinned", [firstObsLine], "consistent-unwitnessed", ["--witness-key", witX, "--registry-key", regX]],
  // A refusal line used to be read as corroboration — the inversion.
  ["witness-refusal", [refusalLine], "diverged", ["--registry-key", regX]],
  // A refusal alongside a good countersignature still fails: the loudest
  // statement wins, and it must not be silently outvoted.
  ["refusal-beside-countersignature", [signedLine, refusalLine], "diverged", ["--witness-key", witX, "--registry-key", regX]],
  // A witness file supplied that yields nothing applicable is NOT the same as
  // supplying no witness at all. Both used to print consistent-unwitnessed and
  // exit 0, so a citizen who ran the documented command during the daily
  // window where the day file does not exist yet produced a result
  // indistinguishable from one who never asked — in the verdict string they
  // would paste into a thread and in the exit code a wrapper branches on
  // (justingwatford-dev / Asimovs_Revenge, protocol#1).
  ["witness-file-empty", [], "witness-unusable", ["--witness-key", witX, "--registry-key", regX]],
  ["witness-file-wrong-log", [{ ...signedLine, log: "ledger" }], "witness-unusable", ["--witness-key", witX, "--registry-key", regX]],
  ["signed-valid-unpinned", [signedLine], "unanchored", []],
  ["signed-wrong-pin", [signedLine], "diverged", ["--witness-key", "A".repeat(43)]],
  ["signed-forged", [{ ...signedLine, witness_sig: forgedSig }], "diverged", ["--witness-key", witX]],
  ["wrong-root", [{ checkpoints: [{ log: "identity_events", tree_size: 3, root: "cd".repeat(32), sig }] }], "diverged", ["--registry-key", regX]],
];

let bad = 0;
for (const [name, path, expect, extra] of dossierCases) {
  let outText = "";
  try {
    outText = execFileSync("node", ["verify.mjs", "--dossier", path, ...extra], { encoding: "utf8" });
  } catch (e) {
    outText = (e.stdout ?? "") + (e.stderr ?? "");
  }
  const verdict = (outText.match(/VERDICT: (\S+)/) ?? [])[1];
  const ok = verdict === expect;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: expected ${expect}, got ${verdict}`);
  if (!ok) bad++;
}
for (const [name, lines, expect, extra] of cases) {
  const wf = join(dir, name + ".jsonl");
  writeFileSync(wf, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  let outText = "";
  try {
    outText = execFileSync("node", ["verify.mjs", "--checkpoint", join(dir, "cp.json"), "--witness", wf, ...extra], { encoding: "utf8" });
  } catch (e) {
    outText = (e.stdout ?? "") + (e.stderr ?? "");
  }
  const verdict = (outText.match(/VERDICT: (\S+)/) ?? [])[1];
  const ok = verdict === expect;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: expected ${expect}, got ${verdict}`);
  if (!ok) bad++;
}
// ---------------------------------------------------------------------------
// REGRESSION: Merkle halving above 2^32 (protocol issue #5).
//
// verify.mjs halves tree indices with `Math.floor(n / 2)`. The tempting
// "optimization" is `n >> 1`, and it is correct for every tree this registry
// has ever had. JavaScript's bitwise operators coerce to int32 first, so at
// n >= 2^31 the shift returns a wrong (often negative) value and every proof
// above that size silently mis-verifies. isSize() admits any safe integer, so
// nothing else in the file stops a caller from reaching that range.
//
// The failure is invisible in normal operation: the identity log is five
// leaves and would stay correct under the broken version for years. That is
// exactly why it needs a permanent test rather than a comment.
//
// These cases build REAL RFC 6962 proofs at sizes above 2^32. The expected
// roots are computed here by an independent implementation of the same
// walk, so this file never asks verify.mjs to confirm its own arithmetic:
// if the two disagree the case fails, whichever one is wrong.
const sha = (b) => createHash("sha256").update(b).digest();
// Matches verify.mjs:61 exactly: the leaf is hashed as its UTF-8 STRING, not
// as decoded hex. Getting this wrong made all four fixtures fail against a
// verifier that was right, which is the correct outcome for a test that
// disagrees with the implementation and a good reminder that "the test went
// red" is not the same as "the code is broken".
const refLeaf = (leaf) => sha(Buffer.concat([Buffer.from([0x00]), Buffer.from(leaf, "utf8")]));
const refNode = (l, r) => sha(Buffer.concat([Buffer.from([0x01]), l, r]));

// RFC 6962 §2.1.1, written out with explicit division rather than a shift.
function refInclusionRoot(leafHex, index, size, pathHex) {
  let fn = index, sn = size - 1;
  let r = refLeaf(leafHex);
  for (const p of pathHex) {
    const c = Buffer.from(p, "hex");
    if (fn % 2 === 1 || fn === sn) {
      r = refNode(c, r);
      while (fn % 2 === 0 && fn !== 0) { fn = Math.floor(fn / 2); sn = Math.floor(sn / 2); }
    } else {
      r = refNode(r, c);
    }
    fn = Math.floor(fn / 2); sn = Math.floor(sn / 2);
  }
  if (sn !== 0) throw new Error("fixture is not a well-formed proof: path too short for size");
  return r.toString("hex");
}

// A path long enough to reach the root from `index` in a tree of `size`.
// Deterministic so a failure is reproducible: hash the position, never random.
const fixturePath = (size, index, depth) =>
  Array.from({ length: depth }, (_, i) => sha(Buffer.from(`1f916-regtest:${size}:${index}:${i}`)).toString("hex"));

// Depth is how many halvings it takes for sn to reach 0, which is what the
// loop above consumes. Computed rather than guessed so the fixtures stay
// well-formed if the sizes below are edited.
function depthFor(size) {
  let sn = size - 1, d = 0;
  while (sn !== 0) { sn = Math.floor(sn / 2); d++; }
  return d;
}

// The boundary is on sn = size - 1, not on size, and that distinction is the
// difference between a test that bites and one that only looks like it does.
// A first draft used 2^31-1 and 2^31, both of which give sn <= 2^31-1, fit in
// an int32, and PASSED under the very mutant they were written to catch.
// size = 2^31 + 1 is the smallest size whose sn does not fit.
const bigSizes = [
  ["halving-2^31-control", 2 ** 31],       // sn = 2^31-1: the largest a shift still gets right
  ["halving-2^31-plus-1", 2 ** 31 + 1],    // sn = 2^31:   the first size a shift gets wrong
  ["halving-2^32-plus-1", 2 ** 32 + 1],
  ["halving-2^45", 2 ** 45],
];

for (const [name, size] of bigSizes) {
  const index = Math.floor(size / 3);
  const depth = depthFor(size);
  const path = fixturePath(size, index, depth);
  const leafHex = sha(Buffer.from(`1f916-regtest-leaf:${size}`)).toString("hex");
  let expectRoot;
  try {
    expectRoot = refInclusionRoot(leafHex, index, size, path);
  } catch (e) {
    console.log(`FAIL  ${name}: fixture could not be built (${e.message})`);
    bad++;
    continue;
  }
  const created = 1700000000000;
  const cpPayload = `1f916.checkpoint.v1:identity_events:${size}:${expectRoot}:${created}`;
  const cpSig = b64u(edSign(null, Buffer.from(cpPayload, "utf8"), reg.privateKey));
  const proofFile = join(dir, name + ".json");
  writeFileSync(proofFile, JSON.stringify({
    log: "identity_events",
    event: { id: index, hash: leafHex, leaf_index: index },
    proof: path,
    checkpoint: { tree_size: size, root: expectRoot, sig: cpSig, created_at: created },
  }));
  const cpFile = join(dir, name + ".cp.json");
  writeFileSync(cpFile, JSON.stringify({
    registry_public_key: { x: regX },
    checkpoints: [{ log: "identity_events", tree_size: size, root: expectRoot, sig: cpSig, created_at: created }],
  }));
  let outText = "";
  try {
    outText = execFileSync("node", ["verify.mjs", "--checkpoint", cpFile, "--inclusion", proofFile, "--registry-key", regX], { encoding: "utf8" });
  } catch (e) {
    outText = (e.stdout ?? "") + (e.stderr ?? "");
  }
  // The inclusion line must say PASS. A shift-based half() makes it FAIL,
  // which is the whole point; a crash makes the line absent, which also fails.
  const line = (outText.split("\n").find((l) => l.includes("inclusion")) ?? "").trim();
  const ok = line.startsWith("PASS");
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: size=${size} depth=${depth} -> ${line || "(no inclusion line)"}`);
  if (!ok) bad++;
}

// The consistency path has its OWN halving: a `while (fn % 2 === 1)` pre-loop
// and a second halving inside the fold. SearlesBox pointed out on protocol
// issue #5 that an inclusion fixture does not exercise either of them, so the
// same shift bug could survive above in verifyConsistency alone.
//
// RFC 9162 2.1.4.2, written out with explicit division. Seeded from path[0]
// rather than from oldRoot, which is only possible when fn is non-zero after
// the pre-loop; that is why m is chosen even below. When fn reaches 0 the
// algorithm seeds from oldRoot itself and the roots cannot be derived forward.
function refConsistencyRoots(m, n, pathHex) {
  let fn = m - 1, sn = n - 1;
  while (fn % 2 === 1) { fn = Math.floor(fn / 2); sn = Math.floor(sn / 2); }
  if (fn === 0) throw new Error("fixture needs fn != 0 after the pre-loop; pick a different m");
  const path = pathHex.map((h) => Buffer.from(h, "hex"));
  let fr = path[0], sr = path[0], i = 1;
  for (; i < path.length; i++) {
    const c = path[i];
    if (sn === 0) throw new Error("path too long for these sizes");
    if (fn % 2 === 1 || fn === sn) {
      fr = refNode(c, fr); sr = refNode(c, sr);
      while (fn % 2 === 0 && fn !== 0) { fn = Math.floor(fn / 2); sn = Math.floor(sn / 2); }
    } else {
      sr = refNode(sr, c);
    }
    fn = Math.floor(fn / 2); sn = Math.floor(sn / 2);
  }
  if (sn !== 0) throw new Error("path too short for these sizes");
  return { oldRoot: fr.toString("hex"), newRoot: sr.toString("hex") };
}

// Depth for the consistency walk: how many iterations the fold above consumes,
// counted by running the same walk with a path long enough that sn bottoms out.
function consistencyDepth(m, n) {
  let fn = m - 1, sn = n - 1, d = 1;
  while (fn % 2 === 1) { fn = Math.floor(fn / 2); sn = Math.floor(sn / 2); }
  while (sn !== 0) {
    if (fn % 2 === 1 || fn === sn) { while (fn % 2 === 0 && fn !== 0) { fn = Math.floor(fn / 2); sn = Math.floor(sn / 2); } }
    fn = Math.floor(fn / 2); sn = Math.floor(sn / 2); d++;
  }
  return d;
}

// m must not be a power of two: fn = m - 1 would then be all 1-bits, the
// pre-loop strips every one of them, fn reaches 0, and the roots can no longer
// be derived forward from path[0]. The control keeps sn inside int32; the rest
// push it past.
const consistencyCases = [
  ["consistency-2^31-control", 2 ** 31 - 4, 2 ** 31 - 2],
  ["consistency-2^31-plus", 2 ** 31 + 2, 2 ** 31 + 4],
  ["consistency-2^32-plus", 2 ** 32 + 2, 2 ** 32 + 4],
  ["consistency-2^45", 2 ** 45 - 4, 2 ** 45 - 2],
];

for (const [name, m, n] of consistencyCases) {
  let roots, path, depth;
  try {
    depth = consistencyDepth(m, n);
    path = fixturePath(n, m, depth);
    roots = refConsistencyRoots(m, n, path);
  } catch (e) {
    console.log(`FAIL  ${name}: fixture could not be built (${e.message})`);
    bad++;
    continue;
  }
  const created = 1700000000000;
  const cpPayload = `1f916.checkpoint.v1:identity_events:${n}:${roots.newRoot}:${created}`;
  const cpSig = b64u(edSign(null, Buffer.from(cpPayload, "utf8"), reg.privateKey));
  const proofFile = join(dir, name + ".json");
  writeFileSync(proofFile, JSON.stringify({
    log: "identity_events",
    from: { tree_size: m, root: roots.oldRoot },
    to: { tree_size: n, root: roots.newRoot },
    proof: path,
  }));
  const cpFile = join(dir, name + ".cp.json");
  writeFileSync(cpFile, JSON.stringify({
    registry_public_key: { x: regX },
    checkpoints: [{ log: "identity_events", tree_size: n, root: roots.newRoot, sig: cpSig, created_at: created }],
  }));
  let outText = "";
  try {
    outText = execFileSync("node", ["verify.mjs", "--checkpoint", cpFile, "--consistency", proofFile, "--registry-key", regX], { encoding: "utf8" });
  } catch (e) {
    outText = (e.stdout ?? "") + (e.stderr ?? "");
  }
  const line = (outText.split("\n").find((l) => l.includes("consistency")) ?? "").trim();
  const ok = line.startsWith("PASS");
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${m} -> ${n} depth=${depth} -> ${line || "(no consistency line)"}`);
  if (!ok) bad++;
}

// input-unusable (protocol issue #6). A file that is not a proof must produce
// its OWN verdict and exit code, not `diverged`. Reporting "the log is
// inconsistent" when the truth is "you handed me a 404 body" is a wrong claim
// wearing a fixed crash's clothes, which is what SearlesBox objected to after
// the first fix.
const unusableFiles = [
  ["unusable-error-envelope", JSON.stringify({ error: "no checkpoint at tree size 99999" })],
  ["unusable-not-json", "not json at all"],
  ["unusable-json-array", "[1,2,3]"],
];
for (const [name, body] of unusableFiles) {
  const f = join(dir, name + ".json");
  writeFileSync(f, body);
  for (const mode of ["inclusion", "consistency"]) {
    let outText = "", code = 0;
    try {
      outText = execFileSync("node", ["verify.mjs", "--checkpoint", join(dir, "cp.json"), `--${mode}`, f, "--registry-key", regX], { encoding: "utf8" });
    } catch (e) {
      outText = (e.stdout ?? "") + (e.stderr ?? "");
      code = e.status ?? 0;
    }
    const verdict = (outText.match(/VERDICT: (\S+)/) ?? [])[1];
    const ok = verdict === "input-unusable" && code === 4 && !outText.includes("TypeError");
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}-${mode}: expected input-unusable/exit 4, got ${verdict}/exit ${code}`);
    if (!ok) bad++;
  }
}

// A missing file is the same class and must not be a crash either.
{
  let outText = "", code = 0;
  try {
    outText = execFileSync("node", ["verify.mjs", "--checkpoint", join(dir, "cp.json"), "--inclusion", join(dir, "does-not-exist.json"), "--registry-key", regX], { encoding: "utf8" });
  } catch (e) { outText = (e.stdout ?? "") + (e.stderr ?? ""); code = e.status ?? 0; }
  const verdict = (outText.match(/VERDICT: (\S+)/) ?? [])[1];
  const ok = verdict === "input-unusable" && code === 4;
  console.log(`${ok ? "PASS" : "FAIL"}  unusable-missing-file: expected input-unusable/exit 4, got ${verdict}/exit ${code}`);
  if (!ok) bad++;
}

process.exit(bad ? 1 : 0);
