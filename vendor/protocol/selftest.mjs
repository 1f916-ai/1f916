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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
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
    outText = execFileSync(process.execPath, ["verify.mjs", "--dossier", path, ...extra], { encoding: "utf8" });
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
    outText = execFileSync(process.execPath, ["verify.mjs", "--checkpoint", join(dir, "cp.json"), "--witness", wf, ...extra], { encoding: "utf8" });
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
    outText = execFileSync(process.execPath, ["verify.mjs", "--checkpoint", cpFile, "--inclusion", proofFile, "--registry-key", regX], { encoding: "utf8" });
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
    outText = execFileSync(process.execPath, ["verify.mjs", "--checkpoint", cpFile, "--consistency", proofFile, "--registry-key", regX], { encoding: "utf8" });
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
      outText = execFileSync(process.execPath, ["verify.mjs", "--checkpoint", join(dir, "cp.json"), `--${mode}`, f, "--registry-key", regX], { encoding: "utf8" });
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
    outText = execFileSync(process.execPath, ["verify.mjs", "--checkpoint", join(dir, "cp.json"), "--inclusion", join(dir, "does-not-exist.json"), "--registry-key", regX], { encoding: "utf8" });
  } catch (e) { outText = (e.stdout ?? "") + (e.stderr ?? ""); code = e.status ?? 0; }
  const verdict = (outText.match(/VERDICT: (\S+)/) ?? [])[1];
  const ok = verdict === "input-unusable" && code === 4;
  console.log(`${ok ? "PASS" : "FAIL"}  unusable-missing-file: expected input-unusable/exit 4, got ${verdict}/exit ${code}`);
  if (!ok) bad++;
}

// ---------------------------------------------------------------------------
// Registry key epochs (spec §8b). A registry that rotated its key serves
// registry_key_history, and every head names its key_epoch. Before this, the
// verifier checked every head with registry_public_key alone, so after a
// rotation a quiet log's older head, every inclusion proof answered against a
// head from before the rotation, and a dossier whose checkpoint predates the
// key that signed it all read `diverged` — true heads reported as forgeries.
// Each fixture below is one of those, plus the forgeries the history must
// still refuse.
{
  const regB = generateKeyPairSync("ed25519");
  const regBX = regB.publicKey.export({ format: "jwk" }).x;
  const signWith = (k, text) => b64u(edSign(null, Buffer.from(text, "utf8"), k.privateKey));
  const rotatedAt = created + 1_000_000;
  // A one-leaf tree: the root is the leaf hash and the inclusion proof is empty.
  const leaf = "ef".repeat(32);
  const leafRoot = (l) => createHash("sha256").update(Buffer.concat([Buffer.from([0]), Buffer.from(l, "utf8")])).digest("hex");
  const oneRoot = leafRoot(leaf);
  // A two-leaf identity log: the old key's last head is at size 2, and an
  // older head at size 1 is linked to it by a consistency proof.
  const leaf2 = "fe".repeat(32);
  const twoRoot = createHash("sha256").update(Buffer.concat([Buffer.from([1]), Buffer.from(oneRoot, "hex"), Buffer.from(leafRoot(leaf2), "hex")])).digest("hex");
  const link = { from: { tree_size: 1, root: oneRoot }, to: { tree_size: 2, root: twoRoot }, proof: [leafRoot(leaf2)] };
  // The newest head of each log when the old key was retired: what the
  // rotation statement commits to, signed by both keys.
  const finalHeads = [
    { log: "identity_events", tree_size: 2, root: twoRoot },
    { log: "ledger", tree_size: 2, root: "cd".repeat(32) },
  ];
  const rotateText = (oldX, newX, at, fin) => `1f916.registry-rotate.v1:1:${oldX}:${newX}:${at}:${fin.map((h) => `${h.log}=${h.tree_size}=${h.root}`).join(",")}`;
  const historyOf = (oldSigner, newSigner, fin = finalHeads) => {
    const st = rotateText(regX, regBX, rotatedAt, fin);
    return [
      { epoch: 0, public_key: regX, activated_at: 0, retired_at: rotatedAt, rotation: null },
      { epoch: 1, public_key: regBX, activated_at: rotatedAt, retired_at: null, rotation: { statement: st, old_sig: signWith(oldSigner, st), new_sig: signWith(newSigner, st), final_heads: fin } },
    ];
  };
  const goodHistory = historyOf(reg, regB);
  const headBy = (k, log, size, r, at, epoch) => ({ log, tree_size: size, root: r, created_at: at, key_epoch: epoch, sig: signWith(k, `1f916.checkpoint.v1:${log}:${size}:${r}:${at}`) });
  const oldHead = headBy(reg, "identity_events", 1, oneRoot, created, 0); // before the rotation, epoch 0, below the final head
  const finalHead = headBy(reg, "identity_events", 2, twoRoot, created + 10, 0); // the committed final head
  const newHead = headBy(regB, "ledger", 3, root, rotatedAt + 10, 1); // after it, epoch 1
  const lateOld = headBy(reg, "ledger", 4, root, rotatedAt + 5, 0); // the retired key, after its retirement
  // What a thief holding the retired key signs: dated just before the
  // retirement, so no date rule can catch it.
  const thiefExtends = headBy(reg, "identity_events", 5, "ce".repeat(32), rotatedAt - 1, 0); // past the committed size
  const fakeLeaf = "13".repeat(32);
  const thiefSameSize = headBy(reg, "identity_events", 2, leafRoot(fakeLeaf), rotatedAt - 1, 0); // the committed size, another root
  const thiefBelow = headBy(reg, "identity_events", 1, leafRoot(fakeLeaf), rotatedAt - 1, 0); // below it, another root
  // The registry serves a proof's checkpoint without its log (the proof names it once).
  const asServed = ({ log: _l, ...h }) => h;
  const write = (name, obj) => {
    const f = join(dir, name);
    writeFileSync(f, JSON.stringify(obj));
    return f;
  };
  // What GET /api/checkpoint serves after the rotation: the quiet identity
  // log still at the old key's final head, the ledger under the new key.
  const rotatedCp = write("rot-cp.json", { registry_public_key: { x: regBX }, registry_key_history: goodHistory, checkpoints: [finalHead, newHead] });
  // An event proved under the smallest head that covers it, from before the
  // rotation, with the link to the final head the registry serves beside it.
  const proof = write("rot-proof.json", { log: "identity_events", event: { id: 1, hash: leaf, leaf_index: 0 }, proof: [], checkpoint: asServed(oldHead), registry_key_history: goodHistory, final_consistency: { log: "identity_events", ...link } });
  const proofNoLink = write("rot-proof-nolink.json", { log: "identity_events", event: { id: 1, hash: leaf, leaf_index: 0 }, proof: [], checkpoint: asServed(oldHead), registry_key_history: goodHistory });
  const linkFile = write("rot-link.json", { log: "identity_events", ...link });
  const { key_epoch: _e, ...oldHeadBare } = oldHead;
  // A proof saved before the registry served key epochs: no key_epoch, no history.
  const preDeployProof = write("rot-proof-pre.json", { log: "identity_events", event: { id: 1, hash: leaf, leaf_index: 0 }, proof: [], checkpoint: asServed(oldHeadBare) });
  const fabricatedProof = write("rot-proof-fake.json", { log: "identity_events", event: { id: 999, hash: fakeLeaf, leaf_index: 0 }, proof: [], checkpoint: asServed(thiefBelow), registry_key_history: goodHistory, final_consistency: { log: "identity_events", from: { tree_size: 1, root: leafRoot(fakeLeaf) }, to: link.to, proof: link.proof } });
  function rotDossier(signer, signerX, epoch, history) {
    const core = { protocol: "1f916/0", handle: "rotated", citizen_id: 1, model: "test", since: created, keys: [], bindings: [], events: [{ id: 1, hash: leaf, leaf_index: 0, proof: [leafRoot(leaf2)] }], events_total: 1, events_returned: 1, events_has_more: false, attestations_about: [], checkpoint: { log: finalHead.log, tree_size: 2, root: twoRoot, sig: finalHead.sig, created_at: finalHead.created_at }, witnesses: [] };
    const digest = createHash("sha256").update(jcs(core), "utf8").digest("hex");
    return { ...core, registry_sig: { sig: signWith(signer, `1f916.record.v1:${digest}`), over: "1f916.record.v1:sha256(JCS(dossier-core))", registry_public_key: signerX, key_epoch: epoch }, checkpoint_key_epoch: 0, ...(history ? { registry_key_history: history } : {}) };
  }
  // Served after the rotation and before the next identity head: signed by
  // the new key, carrying a head the old key signed.
  const freshDossier = write("rot-dossier.json", rotDossier(regB, regBX, 1, goodHistory));
  // Signed by the old key: saved before the rotation, or made since by
  // whoever holds that key. The file cannot say which.
  const oldDossier = write("rot-dossier-old.json", rotDossier(reg, regX, 0, [{ epoch: 0, public_key: regX, activated_at: 0, retired_at: null, rotation: null }]));
  // A checkpoint saved before the rotation: no history, no key_epoch, the old
  // key as registry_public_key.
  const savedBefore = write("rot-saved-before.json", { registry_public_key: { x: regX }, checkpoints: [oldHeadBare] });
  const strangerFile = write("rot-stranger.json", { registry_public_key: { x: impostorX }, checkpoints: [headBy(impostor, "identity_events", 1, oneRoot, created, undefined)] });
  // Every number in the history turned into a string. The statement text and
  // both signatures are unchanged ("1701000000000" prints like the number),
  // and a string retired_at would make epoch 0 never retire.
  const stringified = goodHistory.map((h) => ({ ...h, activated_at: String(h.activated_at), retired_at: h.retired_at === null ? null : String(h.retired_at) }));
  // A pinned witness's countersignature of the post-rotation head.
  const wLine = { registry: "https://1f916.ai", log: newHead.log, tree_size: newHead.tree_size, root: newHead.root, status: "countersigned", consistency: "verified from 2", witness_sig: signWith(wit, `1f916.witness.v1:https://1f916.ai:${newHead.log}:${newHead.tree_size}:${newHead.root}`), witness_public_key: witX };
  const wFile = join(dir, "rot-witness.jsonl");
  writeFileSync(wFile, JSON.stringify(wLine) + "\n");
  const noFinal = goodHistory.map((h) => (h.rotation ? { ...h, rotation: { ...h.rotation, final_heads: undefined } } : h));
  const reused = [...goodHistory.slice(0, 1).map((h) => ({ ...h })), goodHistory[1]];
  reused[1] = { ...goodHistory[1], public_key: regX };

  const rotationCases = [
    ["rotation-pinned-new-key", ["--checkpoint", rotatedCp, "--registry-key", regBX], "consistent-unwitnessed"],
    // Pinned to the old key, the run reaches the new one only through the
    // statement the old key signed: its own verdict, never the plain one.
    ["rotation-pinned-old-key-followed", ["--checkpoint", rotatedCp, "--registry-key", regX], "consistent-unwitnessed-followed"],
    // A witness does not lift that: it vouches for heads, not for which key the registry is.
    ["rotation-followed-and-witnessed", ["--checkpoint", rotatedCp, "--registry-key", regX, "--witness", wFile, "--witness-key", witX], "witnessed-followed"],
    ["rotation-followed-witness-unusable", ["--checkpoint", rotatedCp, "--registry-key", regX, "--witness", write("rot-empty.jsonl", ""), "--witness-key", witX], "witness-unusable-followed"],
    ["rotation-dossier-fresh-old-pin", ["--dossier", freshDossier, "--registry-key", regX], "consistent-unwitnessed-followed"],
    ["rotation-pinned-stranger", ["--checkpoint", rotatedCp, "--registry-key", impostorX], "diverged"],
    ["rotation-inclusion-under-old-head", ["--checkpoint", rotatedCp, "--inclusion", proof, "--registry-key", regBX], "consistent-unwitnessed"],
    // A proof from before key epochs: its head takes the epoch whose window holds its date.
    ["rotation-pre-deploy-proof", ["--checkpoint", rotatedCp, "--inclusion", preDeployProof, "--consistency", linkFile, "--registry-key", regBX], "consistent-unwitnessed"],
    // Below the final head, a retired key's head counts only with the link.
    ["rotation-old-head-without-link", ["--checkpoint", rotatedCp, "--inclusion", proofNoLink, "--registry-key", regBX], "diverged"],
    ["rotation-dossier-fresh", ["--dossier", freshDossier, "--registry-key", regBX], "consistent-unwitnessed"],
    // Signed by a retired key, with a pin: never exit 0.
    ["rotation-dossier-retired-signer", ["--dossier", oldDossier, "--registry-key", regBX, "--key-history", rotatedCp], "retired-signer"],
    ["rotation-dossier-retired-signer-unpinned", ["--dossier", oldDossier, "--key-history", rotatedCp], "unanchored"],
    // THE ATTACK THE FINAL HEADS STOP. A thief with the retired key dates its
    // heads just before the retirement; the date is its own word. A head past
    // the committed final head, or at its size with another root (and so the
    // fabricated event "proved" under it), is refused.
    // A link from size 0 is empty and binds no root; a size-0 retired head must
    // carry the empty tree's root.
    ["rotation-thief-size-zero-head", ["--checkpoint", write("rot-zero.json", { registry_public_key: { x: regBX }, registry_key_history: goodHistory, checkpoints: [headBy(reg, "ledger", 0, "77".repeat(32), rotatedAt - 1, 0)] }), "--consistency", write("rot-zero-link.json", { log: "ledger", from: { tree_size: 0, root: "77".repeat(32) }, to: { tree_size: 2, root: "cd".repeat(32) }, proof: [] }), "--registry-key", regBX], "diverged"],
    ["rotation-thief-extends-log", ["--checkpoint", write("rot-thief.json", { registry_public_key: { x: regBX }, registry_key_history: goodHistory, checkpoints: [thiefExtends] }), "--registry-key", regBX], "diverged"],
    ["rotation-thief-fabricated-event", ["--checkpoint", rotatedCp, "--inclusion", fabricatedProof, "--registry-key", regBX], "diverged"],
    ["rotation-thief-head-without-epoch", ["--checkpoint", write("rot-thief-bare.json", { registry_public_key: { x: regX }, checkpoints: [(({ key_epoch, ...h }) => h)(thiefExtends)] }), "--key-history", rotatedCp, "--registry-key", regBX], "diverged"],
    ["rotation-retired-key-after-retirement", ["--checkpoint", write("rot-late.json", { registry_public_key: { x: regBX }, registry_key_history: goodHistory, checkpoints: [lateOld] }), "--registry-key", regBX], "diverged"],
    ["rotation-history-with-string-numbers", ["--checkpoint", write("rot-strings.json", { registry_public_key: { x: regBX }, registry_key_history: stringified, checkpoints: [lateOld] }), "--registry-key", regBX], "diverged"],
    ["rotation-history-without-final-heads", ["--checkpoint", write("rot-nofinal.json", { registry_public_key: { x: regBX }, registry_key_history: noFinal, checkpoints: [newHead] }), "--registry-key", regBX], "diverged"],
    ["rotation-history-reuses-a-key", ["--checkpoint", write("rot-reused.json", { registry_public_key: { x: regX }, registry_key_history: reused, checkpoints: [finalHead] }), "--registry-key", regX], "diverged"],
    ["rotation-saved-before-new-pin", ["--checkpoint", savedBefore, "--key-history", rotatedCp, "--consistency", linkFile, "--registry-key", regBX], "consistent-unwitnessed"],
    ["rotation-saved-before-old-pin", ["--checkpoint", savedBefore, "--key-history", rotatedCp, "--consistency", linkFile, "--registry-key", regX], "consistent-unwitnessed"],
    ["rotation-saved-before-without-link", ["--checkpoint", savedBefore, "--key-history", rotatedCp, "--registry-key", regBX], "diverged"],
    ["rotation-saved-file-key-not-in-history", ["--checkpoint", strangerFile, "--key-history", rotatedCp, "--registry-key", regBX], "diverged"],
    // A key change the old key did not sign is not a rotation.
    ["rotation-old-key-did-not-sign", ["--checkpoint", write("rot-unsigned.json", { registry_public_key: { x: regBX }, registry_key_history: historyOf(regB, regB), checkpoints: [newHead] }), "--registry-key", regX], "diverged"],
    ["rotation-wrong-epoch", ["--checkpoint", write("rot-wrong.json", { registry_public_key: { x: regBX }, registry_key_history: goodHistory, checkpoints: [{ ...oldHead, key_epoch: 1 }] }), "--registry-key", regBX], "diverged"],
    // What a client that reads only registry_public_key sees: the old head
    // fails under the new key. This is why the history exists.
    ["rotation-key-only-view", ["--checkpoint", write("rot-key-only.json", { registry_public_key: { x: regBX }, checkpoints: [finalHead] }), "--registry-key", regBX], "diverged"],
  ];
  const EXIT = { "witness-unusable-followed": 3, "consistent-unwitnessed": 0, "consistent-unwitnessed-followed": 5, "witnessed-followed": 5, "retired-signer": 6, unanchored: 0, diverged: 1 };
  for (const [name, argv, expect] of rotationCases) {
    let outText = "", code = 0;
    try {
      outText = execFileSync(process.execPath, ["verify.mjs", ...argv], { encoding: "utf8" });
    } catch (e) {
      outText = (e.stdout ?? "") + (e.stderr ?? "");
      code = e.status ?? -1;
    }
    const verdict = (outText.match(/VERDICT: (\S+)/) ?? [])[1];
    const ok = verdict === expect && code === EXIT[expect];
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}: expected ${expect}/exit ${EXIT[expect]}, got ${verdict}/exit ${code}`);
    if (!ok) bad++;
  }
}

// ---------------------------------------------------------------------------
// witness.mjs and registry key epochs (spec §8b). Each run below is the real
// witness.mjs against a stubbed registry (fetch replaced by an --import module
// reading a scenario file). A run names its state directory, so a later run
// can continue from what an earlier one countersigned and pinned.
{
  const regB = generateKeyPairSync("ed25519");
  const regBX = regB.publicKey.export({ format: "jwk" }).x;
  const signWith = (k, text) => b64u(edSign(null, Buffer.from(text, "utf8"), k.privateKey));
  const rotatedAt = created + 1_000_000;
  const fin = [
    { log: "identity_events", tree_size: 2, root },
    { log: "ledger", tree_size: 3, root },
  ];
  const st = `1f916.registry-rotate.v1:1:${regX}:${regBX}:${rotatedAt}:${fin.map((h) => `${h.log}=${h.tree_size}=${h.root}`).join(",")}`;
  const hist = [
    { epoch: 0, public_key: regX, activated_at: 0, retired_at: rotatedAt, rotation: null },
    { epoch: 1, public_key: regBX, activated_at: rotatedAt, retired_at: null, rotation: { statement: st, old_sig: signWith(reg, st), new_sig: signWith(regB, st), final_heads: fin } },
  ];
  const headBy = (k, log, at, epoch, size = 3) => ({ log, tree_size: size, root, created_at: at, ...(epoch === undefined ? {} : { key_epoch: epoch }), sig: signWith(k, `1f916.checkpoint.v1:${log}:${size}:${root}:${at}`) });
  const stub = join(dir, "fake-fetch.mjs");
  writeFileSync(
    stub,
    `import { readFileSync } from "node:fs";
const body = JSON.parse(readFileSync(process.env.WITNESS_SELFTEST_CHECKPOINT, "utf8"));
globalThis.fetch = async (url) => {
  if (String(url).endsWith("/api/checkpoint")) return { ok: true, status: 200, json: async () => body };
  // The one consistency proof this stub can give: between equal sizes, empty.
  const u = new URL(String(url));
  if (u.pathname === "/api/checkpoint/consistency" && u.searchParams.get("from") === u.searchParams.get("to")) return { ok: true, status: 200, json: async () => ({ proof: [] }) };
  throw new Error("selftest: no network");
};
`,
  );
  let n = 0;
  function runWitness(checkpointBody, pinnedX, extra = [], pinExtra = {}, stateName = null) {
    const state = join(dir, stateName ?? `wstate-${++n}`);
    const pinPath = join(state, "registry-key.json");
    mkdirSync(state, { recursive: true });
    if (!existsSync(pinPath)) writeFileSync(pinPath, JSON.stringify({ registry: "https://1f916.ai", registry_public_key: pinnedX, first_seen: "then", ...pinExtra }));
    const cpFile = join(state, "checkpoint.json");
    writeFileSync(cpFile, JSON.stringify(checkpointBody));
    const logFile = join(state, "countersignatures.jsonl");
    const before = existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).length : 0;
    let code = 0;
    let stderr = "";
    try {
      execFileSync(process.execPath, ["--import", pathToFileURL(stub).href, "witness.mjs", "--registry", "https://1f916.ai", "--state", state, ...extra], { encoding: "utf8", env: { ...process.env, WITNESS_SELFTEST_CHECKPOINT: cpFile }, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      code = e.status ?? -1;
      stderr = String(e.stderr ?? "");
    }
    const lines = existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).slice(before) : [];
    const retiredPath = join(state, "retired-registry-keys.json");
    let retired = [];
    try {
      retired = existsSync(retiredPath) ? JSON.parse(readFileSync(retiredPath, "utf8")) : [];
    } catch {
      retired = null;
    }
    return { code, stderr, lines, pin: JSON.parse(readFileSync(pinPath, "utf8")), retired };
  }
  const rotatedBody = { registry_public_key: { x: regBX }, registry_key_history: hist, checkpoints: [headBy(regB, "identity_events", rotatedAt + 10, 1), headBy(reg, "ledger", rotatedAt - 10, 0)] };
  const status = (r, log) => r.lines.find((l) => l.log === log)?.status;
  const witnessCases = [
    // After the operator re-pinned the new key: the quiet ledger's head, signed
    // by the old key before the rotation, is countersigned, not refused.
    ["witness-repinned-quiet-log", () => runWitness(rotatedBody, regBX), (r) => r.code === 0 && r.lines.every((l) => l.status === "countersigned")],
    // Pinned to the old key, by default: reported, nothing countersigned, and
    // the old key's retirement is written into the pin file...
    ["witness-rotation-not-followed-by-default", () => runWitness(rotatedBody, regX, [], {}, "w-notfollowed"), (r) => r.code === 1 && r.lines.length === 1 && r.lines[0].status === "registry-key-rotation-not-followed" && r.pin.registry_public_key === regX && r.retired[0]?.public_key === regX && r.retired[0]?.retired_at === rotatedAt && r.retired[0]?.final_heads?.length === 2],
    // ...so a later response that offers the retired key as active, with no
    // history (what a holder of the old key would serve), is refused.
    ["witness-retired-key-offered-again", () => runWitness({ registry_public_key: { x: regX }, checkpoints: [headBy(reg, "ledger", rotatedAt - 1, undefined, 9)] }, regX, [], {}, "w-notfollowed"), (r) => r.code === 1 && r.lines[0].status === "refused-registry-key-retired"],
    // The same when the key is pinned on the command line, where the pin file
    // is never written: the retirement is kept in its own state file.
    ["witness-cli-pin-not-followed", () => runWitness(rotatedBody, regX, ["--registry-key", regX], {}, "w-cli"), (r) => r.code === 1 && r.lines[0].status === "registry-key-rotation-not-followed" && r.retired[0]?.public_key === regX],
    ["witness-cli-pin-retired-key-offered-again", () => runWitness({ registry_public_key: { x: regX }, checkpoints: [headBy(reg, "ledger", rotatedAt - 1, undefined, 9)] }, regX, ["--registry-key", regX], {}, "w-cli"), (r) => r.code === 1 && r.lines[0].status === "refused-registry-key-retired"],
    // And when it follows: the key it followed from is retired, so a later
    // response offering that key as active is refused even under the old pin.
    ["witness-cli-pin-followed", () => runWitness(rotatedBody, regX, ["--registry-key", regX, "--follow-registry-rotation", "on"], {}, "w-cli-follow"), (r) => r.code === 0 && r.retired[0]?.public_key === regX],
    ["witness-cli-pin-followed-retired-key-offered-again", () => runWitness({ registry_public_key: { x: regX }, checkpoints: [headBy(reg, "ledger", rotatedAt - 1, undefined, 9)] }, regX, ["--registry-key", regX, "--follow-registry-rotation", "on"], {}, "w-cli-follow"), (r) => r.code === 1 && r.lines[0].status === "refused-registry-key-retired"],
    // A log whose last countersignature named an epoch never takes a head that names none.
    ["witness-no-epoch-after-epoch-setup", () => runWitness({ ...rotatedBody, checkpoints: [headBy(regB, "ledger", rotatedAt + 20, 1, 3)] }, regBX, [], {}, "w-noepoch"), (r) => r.code === 0],
    ["witness-no-epoch-after-epoch", () => runWitness({ ...rotatedBody, checkpoints: [headBy(regB, "ledger", rotatedAt + 30, undefined, 4)] }, regBX, [], {}, "w-noepoch"), (r) => r.code === 1 && status(r, "ledger") === "refused-registry-key-epoch"],
    // A registry whose heads carry no key_epoch, with a history: the witness
    // places each by its date, and that placement is not a named epoch, so
    // the second run countersigns the same as the first.
    ["witness-unnamed-epochs-two-runs-1", () => runWitness({ ...rotatedBody, checkpoints: [headBy(regB, "ledger", rotatedAt + 20, undefined, 3)] }, regBX, [], {}, "w-unnamed"), (r) => r.code === 0 && status(r, "ledger") === "countersigned"],
    ["witness-unnamed-epochs-two-runs-2", () => runWitness({ ...rotatedBody, checkpoints: [headBy(regB, "ledger", rotatedAt + 20, undefined, 3)] }, regBX, [], {}, "w-unnamed"), (r) => r.code === 0 && status(r, "ledger") === "countersigned"],
    // A state file it cannot read stops the run with one line naming it.
    ["witness-corrupt-state-file", () => {
      const state = join(dir, "w-corrupt");
      mkdirSync(state, { recursive: true });
      writeFileSync(join(state, "retired-registry-keys.json"), "{not json");
      return runWitness(rotatedBody, regBX, [], {}, "w-corrupt");
    }, (r) => r.code === 2 && r.lines.length === 0 && /retired-registry-keys\.json could not be read/.test(r.stderr) && !/\n\s+at /.test(r.stderr)],
    // followed_from rides only while the pin is the one following moved it to.
    ["witness-followed-from-setup", () => runWitness(rotatedBody, regX, ["--follow-registry-rotation", "on"], {}, "w-followed"), (r) => r.code === 0 && r.lines.every((l) => l.followed_from === regX)],
    ["witness-followed-from-still-followed", () => runWitness(rotatedBody, regX, [], {}, "w-followed"), (r) => r.code === 0 && r.lines.every((l) => l.followed_from === regX)],
    ["witness-followed-from-not-under-cli-pin", () => runWitness(rotatedBody, regX, ["--registry-key", regBX], {}, "w-followed"), (r) => r.code === 0 && r.lines.every((l) => l.followed_from === undefined)],
    ["witness-followed-from-not-after-hand-repin", () => {
      writeFileSync(join(dir, "w-followed", "registry-key.json"), JSON.stringify({ registry: "https://1f916.ai", registry_public_key: regBX, first_seen: "re-pinned by hand" }));
      return runWitness(rotatedBody, regBX, [], {}, "w-followed");
    }, (r) => r.code === 0 && r.lines.every((l) => l.followed_from === undefined)],
    // Following turned on by the operator: countersigned, the pin moves, and
    // every line says which key it was followed from.
    ["witness-rotation-followed-when-on", () => runWitness(rotatedBody, regX, ["--follow-registry-rotation", "on"]), (r) => r.code === 0 && r.lines.every((l) => l.status === "countersigned" && l.followed_from === regX) && r.pin.registry_public_key === regBX],
    ["witness-history-with-string-numbers", () => runWitness({ ...rotatedBody, registry_key_history: hist.map((h) => ({ ...h, activated_at: String(h.activated_at), retired_at: h.retired_at === null ? null : String(h.retired_at) })) }, regX, ["--follow-registry-rotation", "on"]), (r) => r.code === 1 && r.lines[0].status === "refused-registry-key-changed"],
    // A head that names no key_epoch takes the epoch whose window holds its date.
    ["witness-head-without-epoch", () => runWitness({ ...rotatedBody, checkpoints: [headBy(reg, "ledger", rotatedAt - 10, undefined)] }, regBX), (r) => r.code === 0 && r.lines[0].status === "countersigned"],
    ["witness-retired-key-late-head", () => runWitness({ ...rotatedBody, checkpoints: [headBy(reg, "ledger", rotatedAt + 5, 0)] }, regBX), (r) => r.code === 1 && r.lines[0].status === "refused-registry-key-epoch"],
    // THE ATTACK THE FINAL HEADS STOP: a thief with the retired key extends a
    // log with a head dated just before the retirement.
    ["witness-thief-extends-log", () => runWitness({ ...rotatedBody, checkpoints: [headBy(reg, "ledger", rotatedAt - 1, 0, 5)] }, regBX), (r) => r.code === 1 && status(r, "ledger") === "refused-registry-key-epoch"],
    // And a log never goes back to an older key once a newer one was countersigned.
    ["witness-epoch-regression-setup", () => runWitness({ ...rotatedBody, checkpoints: [headBy(regB, "ledger", rotatedAt + 20, 1, 3)] }, regBX, [], {}, "w-regress"), (r) => r.code === 0 && status(r, "ledger") === "countersigned"],
    ["witness-epoch-regression", () => runWitness({ ...rotatedBody, checkpoints: [headBy(reg, "ledger", rotatedAt - 10, 0, 3)] }, regBX, [], {}, "w-regress"), (r) => r.code === 1 && status(r, "ledger") === "refused-registry-key-epoch"],
  ];
  for (const [name, run, ok] of witnessCases) {
    const r = run();
    const pass = ok(r);
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}: exit ${r.code}, ${r.lines.map((l) => l.status).join(", ") || "no lines"}${pass ? "" : ` ${r.stderr.split("\n").slice(0, 3).join(" / ")}`}`);
    if (!pass) bad++;
  }
}

process.exit(bad ? 1 : 0);
