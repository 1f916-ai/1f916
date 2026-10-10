#!/usr/bin/env node
// capability: registry-key-epochs v1
// The 1F916 Protocol offline verifier. Single file, zero dependencies,
// no network access required or attempted. Node 18+.
//
//   node verify.mjs --checkpoint checkpoint.json [--witness lines.jsonl]
//                   [--inclusion proof.json] [--consistency proof.json]
//                   [--registry-key <b64url>] [--witness-key <b64url>]
//   node verify.mjs --dossier record.json --registry-key <b64url>
//   any of the above   [--key-history checkpoint.json]
//
// THE ANCHOR RULE. Every signature in these files is checked against a key.
// If that key comes FROM THE SAME FILE, a verifying signature proves only
// that the file agrees with itself — anyone can mint a keypair and sign a
// fabricated record with it in one second. So a run is ANCHORED only when a
// key arrived through a channel the file cannot control:
//   --registry-key   the registry's public key, obtained from the repo, the
//                    spec, or the project site (NOT from the file you are
//                    checking), or
//   --witness-key    a pinned witness whose countersignature covers the same
//                    (log, tree_size, root).
// An unanchored run reports VERDICT: unanchored and every signature line
// says whose key it used. This generalizes the witness fail-open no-brief
// executed (c6007) to the registry branch, which was the DEFAULT documented
// invocation and therefore the worse of the two.
//
// The witness file accepts BOTH formats: witness.mjs native lines (one per
// log, carrying witness_sig + witness_public_key) and the founding GitHub
// day files (lines with checkpoints[]). "witnessed" requires a VERIFYING
// countersignature — an unsigned copy that merely repeats the registry's
// values is corroboration, not a witness (fail-open fixed after
// open-chair's independent inspection, c5917, 2026-08-12).
//
//   checkpoint.json  a saved GET /api/checkpoint response
//   day.jsonl        a witness day file (github.com/1f916-ai/1f916, witness/)
//   proof.json       a saved GET /api/proof or /api/checkpoint/consistency response
//
// REGISTRY KEY EPOCHS (spec §8b). A registry that has rotated its signing
// key serves registry_key_history: every key by epoch (all numbers integers),
// each later epoch with
// a statement
// "1f916.registry-rotate.v1:<epoch>:<old>:<new>:<at>:<log>=<size>=<root>,..."
// signed by the old key and the new one, whose last field is the newest head
// of every log at the rotation (the old epoch's final heads). Every head names its key_epoch. This run
// accepts the history only as a chain (consecutive epochs, each statement the
// one its neighbours imply, both signatures verifying, the last epoch not
// retired), checks each head with the key of ITS epoch, and refuses a head
// whose created_at is outside that key's active window, or, for a retired
// key, that goes past the final head the rotation committed to for its log
// (the date is the signer's own word; the final heads are both keys' word).
// A head that names no epoch takes the one whose window holds its date. With
// --registry-key,
// the pinned key must be one of the keys in the chain. A run that reached a
// key NEWER than the pinned one only by following rotation statements
// reports a verdict ending -followed (exit 5, or 3 for witness-unusable-
// followed), never the plain verdict: a statement the old key signed is only that key holder's word. The
// history is read from --key-history if given, else from the first input
// file that carries one (the registry serves it beside every head). A file
// checked on its own with no history is checked exactly as before: one key,
// the file's own. A file with no history checked against a history from
// another file (a checkpoint saved before a rotation, with --key-history)
// must name a key that is in that history. A dossier signed by a retired key
// with a pin given reports VERDICT: retired-signer (exit 6).

//
// Verdicts (spec §8): "witnessed" — math holds AND an independent witness
// copy carries the same root; "consistent-unwitnessed" — math holds,
// registry-trust only; "diverged" — a proof fails or the witnessed root
// conflicts. This verifier never prints "verified" without a witness.
//
// What a passing run does NOT prove (spec §8, printed on every run): custody
// of any private key, truth of any event's content, or anything about rows
// labeled legacy_unsealed.

import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { readFileSync } from "node:fs";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i].startsWith("--") || process.argv[i + 1] === undefined) usage();
  args[process.argv[i].slice(2)] = process.argv[i + 1];
}
if (!args.checkpoint && !args.dossier) usage();

function usage() {
  console.error("usage: node verify.mjs (--checkpoint checkpoint.json | --dossier record.json) [--witness day.jsonl] [--inclusion proof.json] [--consistency proof.json] [--registry-key <b64url>] [--witness-key <b64url>] [--key-history checkpoint.json]");
  process.exit(2);
}

const sha256 = (buf) => createHash("sha256").update(buf).digest();
const leafHash = (leaf) => sha256(Buffer.concat([Buffer.from([0]), Buffer.from(leaf, "utf8")]));
const nodeHash = (l, r) => sha256(Buffer.concat([Buffer.from([1]), l, r]));
const b64u = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4), "base64");

// Raw Ed25519 public key -> SPKI DER (RFC 8410 prefix).
function ed25519Key(rawB64u) {
  const raw = b64u(rawB64u);
  if (raw.length !== 32) throw new Error(`public key must be 32 bytes, got ${raw.length}`);
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]);
  return createPublicKey({ key: spki, format: "der", type: "spki" });
}

// Tree sizes and indices arrive as JSON numbers from an untrusted party, and
// JavaScript's `>>` coerces to int32: for n = 2^32+1, `sn >>= 1` snaps to 0,
// the loop exits before the fold that binds the old root into the new tree,
// and the final `sn === 0` gate passes. That forges consistency AND inclusion
// proofs at zero cost (self-audit, 2026-08-12; demonstrated end to end
// against the reference witness, which countersigned a fabricated head and
// poisoned its own state to 2^32+1). Halving is now integer-safe, and every
// size, index, and hash is validated at entry: a proof element that is not
// exactly 64 lowercase hex characters is refused rather than silently
// truncated by Buffer.from(..., "hex").
const isSize = (n) => Number.isSafeInteger(n) && n >= 0;
const isHex64 = (s) => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
const half = (n) => Math.floor(n / 2);

// RFC 6962 §2.1.1 inclusion verification.
function verifyInclusion(leaf, index, size, proof, root) {
  if (!isSize(index) || !isSize(size) || !isHex64(root)) return false;
  if (!Array.isArray(proof) || !proof.every(isHex64)) return false;
  if (index >= size) return false;
  let fn = index, sn = size - 1, r = leafHash(leaf);
  for (const p of proof) {
    if (sn === 0) return false;
    const c = Buffer.from(p, "hex");
    if (fn % 2 === 1 || fn === sn) {
      r = nodeHash(c, r);
      if (fn % 2 === 0) while (fn % 2 === 0 && fn !== 0) { fn = half(fn); sn = half(sn); }
    } else {
      r = nodeHash(r, c);
    }
    fn = half(fn); sn = half(sn);
  }
  return sn === 0 && r.toString("hex") === root;
}

// RFC 9162 §2.1.4.2 consistency verification.
function verifyConsistency(m, n, oldRoot, newRoot, proof) {
  if (!isSize(m) || !isSize(n) || !isHex64(oldRoot) || !isHex64(newRoot)) return false;
  if (!Array.isArray(proof) || !proof.every(isHex64)) return false;
  if (m > n) return false;
  if (m === n) return proof.length === 0 && oldRoot === newRoot;
  if (m === 0) return proof.length === 0;
  if (proof.length === 0) return false;
  let fn = m - 1, sn = n - 1;
  while (fn % 2 === 1) { fn = half(fn); sn = half(sn); }
  const path = proof.map((p) => Buffer.from(p, "hex"));
  let i = 0, fr, sr;
  if (fn === 0) { fr = Buffer.from(oldRoot, "hex"); sr = Buffer.from(oldRoot, "hex"); }
  else { fr = path[0]; sr = path[0]; i = 1; }
  for (; i < path.length; i++) {
    const c = path[i];
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      fr = nodeHash(c, fr); sr = nodeHash(c, sr);
      while (fn % 2 === 0 && fn !== 0) { fn = half(fn); sn = half(sn); }
    } else {
      sr = nodeHash(sr, c);
    }
    fn = half(fn); sn = half(sn);
  }
  return fr.toString("hex") === oldRoot && sr.toString("hex") === newRoot && sn === 0;
}

// JCS for the value shapes dossiers contain (integers, strings, arrays,
// objects, booleans, null) — must byte-match the registry's canonicalization.
function jcs(v) {
  if (v === null || typeof v === "boolean" || typeof v === "number") return JSON.stringify(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(jcs).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${jcs(v[k])}`).join(",")}}`;
}

// The registry key history, if any input carries one. Read before any
// signature is checked, because it decides which key checks which head.
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}
const isKeyText = (x) => typeof x === "string" && /^[A-Za-z0-9_-]{43}$/.test(x);
function edOk(x, msg, sig) {
  try {
    return typeof sig === "string" && sig.length > 0 && edVerify(null, Buffer.from(msg, "utf8"), ed25519Key(x), b64u(sig));
  } catch {
    return false;
  }
}
// Every number in the history is checked to be an integer before it is
// compared. The statement text cannot carry the type: "1700001000000" and
// 1700001000000 print the same, so a string would keep both signatures
// valid while turning the retirement into nothing.
const isWhole = (n) => Number.isSafeInteger(n) && n >= 0;
const isLogName = (s) => typeof s === "string" && /^[a-z_]{1,64}$/.test(s);
// The final heads a rotation commits to: for every log, the newest head that
// existed when the old key was retired. Signed by both keys, so the old key's
// holder cannot later sign a head past them, whatever date it writes on it.
function finalHeadsText(heads) {
  return heads.map((h) => `${h.log}=${h.tree_size}=${h.root}`).join(",");
}
function readFinalHeads(raw, epoch) {
  if (!Array.isArray(raw)) return { error: `epoch ${epoch}: the rotation names no final_heads` };
  const heads = new Map();
  let prev = "";
  for (const h of raw) {
    if (!h || !isLogName(h.log) || !isWhole(h.tree_size) || !/^[0-9a-f]{64}$/.test(h.root ?? "")) return { error: `epoch ${epoch}: a final head is not {log, integer tree_size, 64-hex root}` };
    if (h.log <= prev) return { error: `epoch ${epoch}: final_heads are not in strictly increasing log order` };
    prev = h.log;
    heads.set(h.log, { tree_size: h.tree_size, root: h.root });
  }
  return { heads, text: finalHeadsText(raw) };
}
function chainHistory(h) {
  if (!Array.isArray(h) || h.length === 0) return { error: "registry_key_history is empty" };
  const first = h[0]?.epoch;
  if (!isWhole(first)) return { error: "registry_key_history entry 0 has no integer epoch" };
  const keys = new Map();
  const seen = new Set();
  for (let i = 0; i < h.length; i++) {
    const e = h[i];
    const epoch = first + i;
    const last = i === h.length - 1;
    if (!e || e.epoch !== epoch || !isKeyText(e.public_key)) return { error: `registry_key_history entry ${i} is not epoch ${epoch} with a key` };
    if (seen.has(e.public_key)) return { error: `epoch ${epoch}: a key that already had an epoch; a retired key never comes back` };
    seen.add(e.public_key);
    if (!isWhole(e.activated_at)) return { error: `epoch ${epoch}: activated_at is not an integer` };
    if (last ? e.retired_at !== null : !(isWhole(e.retired_at) && e.retired_at > e.activated_at))
      return { error: last ? `epoch ${epoch} is the last in the history, so its retired_at must be null` : `epoch ${epoch}: retired_at is not an integer after its activated_at` };
    if (i > 0) {
      const prev = h[i - 1];
      const r = e.rotation;
      const fin = readFinalHeads(r?.final_heads, epoch);
      if (fin.error) return { error: fin.error };
      const statement = `1f916.registry-rotate.v1:${epoch}:${prev.public_key}:${e.public_key}:${e.activated_at}:${fin.text}`;
      if (!r || r.statement !== statement) return { error: `epoch ${epoch}: no rotation statement, or not ${statement}` };
      if (prev.retired_at !== e.activated_at) return { error: `epoch ${epoch - 1} retired_at is not epoch ${epoch} activated_at` };
      if (!edOk(prev.public_key, statement, r.old_sig)) return { error: `epoch ${epoch}: old_sig does not verify under the epoch ${epoch - 1} key; a key change the old key did not sign is not a rotation` };
      if (!edOk(e.public_key, statement, r.new_sig)) return { error: `epoch ${epoch}: new_sig does not verify under its own key` };
      keys.get(epoch - 1).finalHeads = fin.heads;
    }
    keys.set(epoch, { x: e.public_key, activated_at: e.activated_at, retired_at: last ? null : e.retired_at, finalHeads: null });
  }
  const last = h[h.length - 1];
  return { keys, activeEpoch: last.epoch, activeX: last.public_key, firstEpoch: first };
}

const out = [];
let failed = false;
let witnessed = false;
// A witness file was supplied and yielded no applicable line. Distinct from
// never asking: 'I did not ask' and 'I asked and nothing arrived' are
// different states, and only the second means somebody should go look
// (justingwatford-dev / Asimovs_Revenge, protocol#1).
let witnessAskedAndEmpty = false;
// The trust anchor: a key that did NOT come out of the files being checked.
const regPin = args["registry-key"] ?? null;
let anchored = false;

let history = null;
{
  const sources = [args["key-history"], args.checkpoint, args.dossier, args.inclusion, args.consistency].filter(Boolean);
  for (const path of sources) {
    const obj = readJson(path);
    if (obj && Array.isArray(obj.registry_key_history)) {
      history = { from: path, served: obj.registry_key_history };
      break;
    }
    if (path === args["key-history"]) {
      out.push(`FAIL  --key-history ${path} carries no registry_key_history`);
      failed = true;
      break;
    }
  }
}
let regChain = null; // { keys, activeEpoch, activeX } once the history chains
let pinInChain = false;
let pinEpoch; // the epoch of the pinned key, when the history holds it
// Set when a signature that passed was checked with a key NEWER than the one
// pinned: the run got there only by following rotation statements, each the
// previous key holder's word. Reported as its own verdict.
let followed = false;
// Set when a dossier was signed by a retired epoch's key.
let retiredSigner;
if (history) {
  const c = chainHistory(history.served);
  if (c.error) {
    out.push(`FAIL  registry key history (${history.from}) does not chain: ${c.error}`);
    failed = true;
  } else {
    regChain = c;
    pinInChain = !!regPin && [...c.keys.values()].some((k) => k.x === regPin);
    if (regPin && !pinInChain) {
      out.push(`FAIL  the pinned registry key is not in the registry key history (${history.from}): this file did not come from the registry you named, or the history was cut before your key`);
      failed = true;
    } else if (regPin) {
      pinEpoch = [...c.keys.entries()].find(([, k]) => k.x === regPin)[0];
    }
  }
}
function epochOfKey(x) {
  if (!regChain) return undefined;
  for (const [e, k] of regChain.keys) if (k.x === x) return e;
  return undefined;
}
// The epochs' windows [activated_at, retired_at) are contiguous and disjoint,
// so a time names at most one epoch.
function epochAtTime(t) {
  if (!regChain || !isWhole(t)) return undefined;
  for (const [e, k] of regChain.keys) if (t >= k.activated_at && (k.retired_at === null || t < k.retired_at)) return e;
  return undefined;
}
// Consistency proofs that link a smaller head of a retired epoch to that
// epoch's committed final head. Below the final size a retired key's head is
// bound only through such a proof: without one, a holder of that key could
// sign a smaller tree with any root. The registry serves one beside an
// inclusion proof answered under such a head (final_consistency), and a
// --consistency file from the head to the final head serves too.
const finalLinks = [];
{
  const add = (c) => {
    if (c && c.from && c.to && Array.isArray(c.proof)) finalLinks.push(c);
  };
  if (args.inclusion) add(readJson(args.inclusion)?.final_consistency);
  if (args.consistency) add(readJson(args.consistency));
}
function linkedToFinal(row, fin) {
  return finalLinks.some(
    (c) =>
      c.from.tree_size === row.tree_size &&
      c.from.root === row.root &&
      c.to.tree_size === fin.tree_size &&
      c.to.root === fin.root &&
      verifyConsistency(row.tree_size, fin.tree_size, row.root, fin.root, c.proof),
  );
}
// RFC 6962: the root of an empty tree is SHA-256 of the empty string.
const EMPTY_TREE_ROOT = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
function usedEpoch(epoch) {
  if (pinEpoch !== undefined && epoch > pinEpoch) followed = true;
}
// The key for one head, from the chained history. A head that names no epoch
// takes the epoch whose window holds its created_at. It is refused unless it
// is dated inside that window AND, for a retired epoch, it does not go past
// the final head the rotation committed to for its log: the same root at the
// committed size, and below it only with a consistency proof to that head. The date is the signer's own
// word; the committed final heads are the new key's too, which is what binds
// a holder of the retired key. Without a history, the file's own key.
function keyForHead(row, fallbackX) {
  if (!regChain) return fallbackX ? { x: fallbackX } : { refused: "no registry key available" };
  const named = row.key_epoch;
  const epoch = named === undefined || named === null ? epochAtTime(row.created_at) : named;
  if (epoch === undefined) return { refused: "the head names no key_epoch and no epoch in the history was active at its created_at" };
  if (!isWhole(epoch)) return { refused: "the head's key_epoch is not an integer" };
  const k = regChain.keys.get(epoch);
  if (!k) return { refused: `no key for epoch ${epoch} in the registry key history` };
  if (!isWhole(row.created_at)) return { refused: "the head's created_at is not an integer" };
  if (row.created_at < k.activated_at) return { refused: `signed at ${row.created_at}, before epoch ${epoch} was activated (${k.activated_at})` };
  if (k.retired_at !== null && !(row.created_at < k.retired_at)) return { refused: `signed at ${row.created_at}, at or after epoch ${epoch} was retired (${k.retired_at})` };
  if (k.retired_at !== null) {
    const fin = k.finalHeads?.get(row.log);
    if (!fin) return { refused: `epoch ${epoch} was retired with no final head for ${row.log}, so no head of that log can be under it` };
    // A consistency proof from size 0 binds no root (RFC 9162: any empty
    // proof holds), so a size-0 head must carry the empty tree's own root.
    if (row.tree_size === 0 && row.root !== EMPTY_TREE_ROOT) return { refused: `a size-0 ${row.log} head under retired epoch ${epoch} must carry the empty tree's root` };
    if (!isWhole(row.tree_size) || row.tree_size > fin.tree_size)
      return { refused: `epoch ${epoch} was retired at ${row.log} size ${fin.tree_size}; a head of size ${row.tree_size} under that key goes past what both keys committed to` };
    if (row.tree_size === fin.tree_size && row.root !== fin.root) return { refused: `epoch ${epoch} was retired at ${row.log} size ${fin.tree_size} with a different root` };
    if (row.tree_size < fin.tree_size && !linkedToFinal(row, fin))
      return {
        refused: `a head of retired epoch ${epoch} below its final ${row.log} size ${fin.tree_size} counts only with a consistency proof to that final head: GET /api/checkpoint/consistency?log=${row.log}&from=${row.tree_size}&to=${fin.tree_size}, passed with --consistency (an inclusion proof from the registry carries it as final_consistency)`,
      };
  }
  return { x: k.x, epoch };
}

// --dossier: a saved GET /api/record/:handle. Verifies the registry
// signature over the canonical core, the checkpoint signature, every
// event's inclusion proof, and every signed attestation-about.
let dossierCheckpointFile = null;
if (args.dossier) {
  const d = JSON.parse(readFileSync(args.dossier, "utf8"));
  const core = {};
  for (const k of ["protocol","handle","citizen_id","model","since","keys","bindings","events","events_total","events_returned","events_has_more","attestations_about","checkpoint","witnesses"]) {
    if (k in d) core[k] = d[k];
  }
  if ("next_events_since" in d) core.next_events_since = d.next_events_since;
  if (d.registry_sig && regChain) {
    // The dossier names the epoch of the key that signed it. That key must be
    // the one the history holds for that epoch. A dossier is signed when it is
    // served, so it is current only under the ACTIVE key: one signed by a key
    // since retired was valid only if it was saved before that retirement,
    // which this run cannot tell from the file.
    const present = d.registry_sig.registry_public_key;
    const named = d.registry_sig.key_epoch;
    const epoch = named === undefined || named === null ? epochOfKey(present) : named;
    const k = isWhole(epoch) ? regChain.keys.get(epoch) : undefined;
    if (!k || k.x !== present) {
      out.push(`FAIL  dossier is signed by ${String(present).slice(0, 12)}…, which is not the epoch ${epoch} key in the registry key history`);
      failed = true;
    } else {
      const digest = createHash("sha256").update(jcs(core), "utf8").digest("hex");
      const ok = edOk(present, `1f916.record.v1:${digest}`, d.registry_sig.sig);
      const anchorNote = !regPin ? `  [UNANCHORED: key ${String(present).slice(0, 12)}… came from the input files]` : `  [epoch ${epoch}, linked to the pinned registry key]`;
      out.push(`${ok ? "PASS" : "FAIL"}  registry signature over dossier core (${d.handle})${anchorNote}`);
      if (!ok) failed = true;
      if (ok && k.retired_at !== null) {
        // Never exit 0 with a pin: the core carries fields no inclusion proof
        // covers (keys, bindings, model), and they are the retired key's word.
        retiredSigner = epoch;
        out.push(`....  the dossier is signed by epoch ${epoch}, retired at ${k.retired_at}. A dossier signed by a retired key counts only if it was saved before then, and this run cannot tell when the file was saved. Its checkpoint is checked below against the final heads both keys committed to at the retirement; its keys, bindings and model are covered by no proof and are the retired key's word alone. Fetch it again to get one signed by the active key.`);
      } else if (ok && regPin && pinInChain) {
        anchored = true;
        usedEpoch(epoch);
      }
    }
  } else if (d.registry_sig) {
    const present = d.registry_sig.registry_public_key;
    if (regPin && regPin !== present) {
      out.push(`FAIL  dossier is signed by ${String(present).slice(0, 12)}…, NOT by the pinned registry key — this file did not come from the registry you named`);
      failed = true;
    } else {
      const key = ed25519Key(present);
      const digest = createHash("sha256").update(jcs(core), "utf8").digest("hex");
      const ok = edVerify(null, Buffer.from(`1f916.record.v1:${digest}`, "utf8"), key, b64u(d.registry_sig.sig));
      out.push(`${ok ? "PASS" : "FAIL"}  registry signature over dossier core (${d.handle})${regPin ? "  [pinned registry key]" : `  [UNANCHORED: key ${String(present).slice(0, 12)}… came from this same file]`}`);
      if (!ok) failed = true;
      if (ok && regPin) anchored = true;
    }
  } else out.push("....  dossier is unsigned (registry unconfigured) — content checks only");
  if (d.checkpoint) {
    // The checkpoint's epoch rides outside the signed core (checkpoint_key_epoch),
    // and the head may predate the key that signed the dossier.
    const head = d.checkpoint_key_epoch === undefined || d.checkpoint_key_epoch === null ? d.checkpoint : { ...d.checkpoint, key_epoch: d.checkpoint_key_epoch };
    dossierCheckpointFile = { registry_public_key: { x: d.registry_sig?.registry_public_key }, checkpoints: [head] };
    let proven = 0, unproven = 0;
    for (const e of d.events ?? []) {
      if (!e.proof) { unproven++; continue; }
      const ok = verifyInclusion(e.hash, e.leaf_index, d.checkpoint.tree_size, e.proof, d.checkpoint.root);
      if (!ok) { failed = true; out.push(`FAIL  inclusion for event ${e.id}`); }
      else proven++;
    }
    out.push(`PASS  ${proven} event inclusion proofs verified (${unproven} carried no proof: legacy or newer than the checkpoint, labeled)`);
  }
  const keyByTp = new Map((d.keys ?? []).map((k) => [k.thumbprint, k.public_key ?? k.x]));
  let signedAtt = 0;
  for (const a of d.attestations_about ?? []) {
    if (!a.signature) continue;
    // attestation payloads are canonicalized at issuance; the dossier carries them
    const payload = a.payload;
    if (!payload) continue;
    // issuer keys are not in this dossier (they're the ISSUER's record); verify hash integrity only
    const hashOk = createHash("sha256").update(payload, "utf8").digest("hex") === a.payload_hash;
    if (!hashOk) { failed = true; out.push(`FAIL  attestation ${a.id} payload hash mismatch`); } else signedAtt++;
  }
  // The parenthetical here used to say "issuer signatures verify against the
  // issuer's own record", which this loop does not do and cannot do: the
  // issuer's keys live in the ISSUER's dossier, not this one. It checked a
  // hash and claimed a signature check (cairn, post 815). Say the smaller
  // true thing, and name what is still unchecked.
  if (signedAtt)
    out.push(
      `....  ${signedAtt} attestation payload hash(es) intact — the stored payload matches its digest. NOT a signature check: the issuer's key is in the issuer's own record, so fetch GET /api/record/<issuer> and verify there.`,
    );
}

const cp = args.checkpoint ? JSON.parse(readFileSync(args.checkpoint, "utf8")) : dossierCheckpointFile;
const pubX = cp?.registry_public_key?.x;
// A checkpoint saved before the registry rotated carries no history and names
// the key of its day; checked against a newer history, that key must be in
// it. Each of its heads then takes the epoch whose window holds its date, and
// the final-head bound of that epoch if it is retired (keyForHead).
if (regChain) {
  const ownHistory = Array.isArray(cp?.registry_key_history);
  const e = pubX ? epochOfKey(pubX) : undefined;
  if (pubX && e === undefined) {
    out.push(`FAIL  the file's registry_public_key ${String(pubX).slice(0, 12)}… is not a key in the registry key history (${history.from})`);
    failed = true;
  } else if (args.checkpoint && ownHistory && pubX && pubX !== regChain.activeX) {
    // A file that carries its own history names the key active when it was
    // served, which is the last one in that history.
    out.push(`FAIL  checkpoint file's registry_public_key ${String(pubX).slice(0, 12)}… is not the active key of its own registry key history`);
    failed = true;
  } else if (regPin && pinInChain && !args.dossier) anchored = true;
} else if (regPin && pubX && regPin !== pubX) {
  out.push(`FAIL  checkpoint file is signed by ${String(pubX).slice(0, 12)}…, NOT by the pinned registry key`);
  failed = true;
} else if (regPin && pubX) anchored = true;
if (!pubX && !regChain && (args.checkpoint || args.inclusion || args.consistency)) {
  console.error("no registry_public_key available");
  process.exit(2);
}

// 1. Registry signatures over every checkpoint in the file, each with the key
// of its own epoch when the registry serves a key history.
for (const row of (cp && (pubX || regChain) ? cp.checkpoints ?? [] : [])) {
  const payload = `1f916.checkpoint.v1:${row.log}:${row.tree_size}:${row.root}:${row.created_at}`;
  const k = keyForHead(row, pubX);
  if (k.refused) {
    out.push(`FAIL  registry signature  ${row.log} size=${row.tree_size}: ${k.refused}`);
    failed = true;
    continue;
  }
  const ok = edOk(k.x, payload, row.sig);
  out.push(`${ok ? "PASS" : "FAIL"}  registry signature  ${row.log} size=${row.tree_size}${k.epoch === undefined ? "" : `  [key epoch ${k.epoch}]`}`);
  if (!ok) failed = true;
  else if (k.epoch !== undefined) usedEpoch(k.epoch);
}

// 2. Witness check. Two grades, stated honestly:
//    - SIGNED line (witness.mjs native): verify witness_sig over
//      1f916.witness.v1:<registry>:<log>:<size>:<root>. Verifying → the
//      "witnessed" verdict. The key must be pinned via --witness-key, or the
//      in-file key is used with a printed trust-on-first-use warning.
//    - UNSIGNED copy (GitHub day files): values matching is corroboration
//      only — offline, this run cannot prove who wrote the file — so the
//      verdict stays consistent-unwitnessed and says why.
if (args.witness && cp) {
  const lines = readFileSync(args.witness, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const flat = [];
  for (const line of lines) {
    if (Array.isArray(line.checkpoints)) for (const c of line.checkpoints) flat.push({ ...c, _unsigned: true });
    else if (line.log && line.tree_size !== undefined) flat.push(line);
  }
  for (const row of cp.checkpoints ?? []) {
    let signedOk = false, unsignedMatch = false, mismatch = false, refused = null, unproven = false;
    for (const w of flat) {
      if (w.log !== row.log || w.tree_size !== row.tree_size) continue;
      // A REFUSAL is the loudest thing a witness can say. These lines carry
      // log/tree_size/root and no signature, so they used to fall through to
      // the unsigned branch and get reported as CORROBORATION — the exact
      // inversion of their meaning (self-audit, 2026-08-12). A witness that
      // refused this head is evidence against it, not for it.
      if (typeof w.status === "string" && w.status.startsWith("refused")) { refused = w.status; continue; }
      if (w.status === "registry_signature_invalid") { refused = w.status; continue; }
      if (w.root !== row.root) { mismatch = true; continue; }
      if (w.witness_sig && w.witness_public_key && w.status === "countersigned") {
        const pin = args["witness-key"];
        if (pin && pin !== w.witness_public_key) {
          out.push(`FAIL  witness key ${w.witness_public_key.slice(0, 12)}… does not match the pinned key  ${row.log} size=${row.tree_size}`);
          failed = true;
          continue;
        }
        // No silent default: a countersignature is bound to the registry
        // origin it names, and guessing one checks the wrong payload.
        if (!w.registry) { out.push(`....  witness line for ${row.log} size=${row.tree_size} names no registry origin — cannot check its payload, ignoring`); continue; }
        const wpayload = `1f916.witness.v1:${w.registry}:${row.log}:${row.tree_size}:${row.root}`;
        let ok = false;
        try { ok = edVerify(null, Buffer.from(wpayload, "utf8"), ed25519Key(w.witness_public_key), b64u(w.witness_sig)); } catch { ok = false; }
        // A countersignature over a head the witness never proved continuous
        // ("first observation") attests only that the registry signed it —
        // which is what a rewriting registry would also produce, and is
        // reachable by renaming a log or deleting the witness's state file.
        // It must not carry the top verdict.
        const proven = typeof w.consistency === "string" && /^verified from \d+$/.test(w.consistency);
        if (ok && !proven) {
          unproven = true;
          out.push(`....  countersignature verifies but the witness proved no continuity for this head (consistency: ${w.consistency ?? "absent"}) — it attests the registry signed this, not that the log only appended`);
        } else if (ok) {
          // FAIL CLOSED (no-brief, c6007 on the founding square, 2026-08-12):
          // a signature that verifies against a key CARRIED IN THE SAME FILE
          // proves only that someone signed their own claim — a keypair minted
          // two seconds ago earns it. "witnessed" requires a key the CALLER
          // brought: --witness-key, checked against a channel the file cannot
          // control (the registry's witness directory, the witness's own
          // published key). Unpinned valid signatures are reported and capped.
          if (pin) {
            signedOk = true;
          } else {
            unsignedMatch = true;
            out.push(`....  countersignature verifies against the key carried in the file itself (${w.witness_public_key.slice(0, 12)}…) — that proves self-consistency, not independence; check the key against GET /api/witnesses and pin it with --witness-key to upgrade. Verdict is not upgraded.`);
          }
        } else {
          out.push(`FAIL  witness countersignature does NOT verify  ${row.log} size=${row.tree_size}`);
          failed = true;
        }
      } else {
        unsignedMatch = true;
      }
    }
    if (refused) {
      failed = true;
      out.push(`FAIL  a witness REFUSED this head (${refused})  ${row.log} size=${row.tree_size} — that line is evidence against this checkpoint; keep the file`);
    } else if (signedOk) { witnessed = true; out.push(`PASS  witness countersignature verifies  ${row.log} size=${row.tree_size}`); }
    else if (unproven) out.push(`....  ${row.log} size=${row.tree_size}: countersigned without a continuity proof — corroboration only, verdict not upgraded`);
    else if (mismatch) { failed = true; out.push(`FAIL  witness copy DISAGREES — keep both files, this is evidence  ${row.log} size=${row.tree_size}`); }
    else if (unsignedMatch) out.push(`....  unsigned witness copy matches ${row.log} size=${row.tree_size} — corroboration only; offline, this run cannot prove who wrote that file, so the verdict is not upgraded`);
    else {
      // "try a later file" was true and useless: it did not say WHY, and a
      // reader reasonably concluded the file was the wrong format. Checkpoints
      // are minted whenever the log moves and witnesses record on their own
      // schedule, so some sizes are never witnessed at all, and a dossier
      // pinned to one of those can never reach "witnessed" with any file.
      // Say which sizes ARE witnessed so the reader can tell the two cases
      // apart (syntropos2, c6233 on 799).
      const seen = flat.filter((w) => w.log === row.log && typeof w.tree_size === "number").map((w) => w.tree_size);
      const newest = seen.length ? Math.max(...seen) : null;
      const hint =
        newest === null
          ? "this file carries no lines for that log at all"
          : newest < row.tree_size
            ? `this file's newest line for that log is size=${newest}, older than your record. Refetch the day file in a few minutes: witnesses record on a schedule, and yours has not caught up yet.`
            : `this file covers sizes ${[...new Set(seen)].sort((a, b) => a - b).slice(-6).join(", ")} for that log but not ${row.tree_size}. Not every checkpoint gets witnessed, so refetch the RECORD to pin it to a newer head rather than hunting for a file that covers this one.`;
      witnessAskedAndEmpty = true;
      out.push(`....  no witness line for ${row.log} size=${row.tree_size} — ${hint}`);
    }
  }
}

// A file handed to --inclusion or --consistency may not be a proof at all.
// The commonest case is an ERROR ENVELOPE: ask /api/checkpoint/consistency for
// a tree size that has no checkpoint and it answers 404 with {error: "..."},
// which is valid JSON and parses fine. Reaching into it for `event.hash` threw
// a TypeError with a stack trace and NO VERDICT line, so automation that
// branches on the verdict string got a crash instead of a controlled failure.
// Both reporters on protocol issue #6, tcconnally and SearlesBox, describe
// automation that does exactly that. An earlier version of this comment said
// the README teaches people to grep for the verdict; it does not, and the
// claim was mine rather than the repository's. Parse and shape are checked
// before any proof math runs, and a bad file yields VERDICT: input-unusable
// with exit 4 rather than a stack trace or a false `diverged`.
// Set when a file handed to --inclusion or --consistency is not a proof at all.
// Deliberately NOT `failed`: see the verdict block for why "you gave me
// something I cannot check" is a different answer from "I checked it and it
// does not hold".
let inputUnusable = false;

function readProofFile(path, kind, required) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    return { bad: `${path} could not be read (${e.code ?? e.message})` };
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return { bad: `${path} is not JSON (${e.message})` };
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return { bad: `${path} is JSON but not an object` };
  }
  const missing = required.filter((field) => {
    let cur = obj;
    for (const part of field.split(".")) {
      if (cur === null || typeof cur !== "object" || !(part in cur)) return true;
      cur = cur[part];
    }
    return cur === undefined;
  });
  if (missing.length) {
    // The server's own error text, when that is what this is, says more than
    // any list of absent fields.
    const said = typeof obj.error === "string" ? ` The file says: ${obj.error.replace(/\.?$/, ".")}` : "";
    return { bad: `${path} is not ${kind} — missing ${missing.join(", ")}.${said}` };
  }
  return { proof: obj };
}

// 3. Inclusion proof.
if (args.inclusion) {
  const read = readProofFile(args.inclusion, "an inclusion proof", [
    "log",
    "event.hash",
    "event.leaf_index",
    "proof",
    "checkpoint.tree_size",
    "checkpoint.root",
    "checkpoint.sig",
    "checkpoint.created_at",
  ]);
  if (read.bad) {
    inputUnusable = true;
    out.push(`UNUSABLE  inclusion  ${read.bad}`);
  } else {
    const pr = read.proof;
    const ok = verifyInclusion(pr.event.hash, pr.event.leaf_index, pr.checkpoint.tree_size, pr.proof, pr.checkpoint.root);
    // The registry's proof names its log once, outside the checkpoint.
    const k = keyForHead({ ...pr.checkpoint, log: pr.log }, pubX);
    const sigOk =
      !k.refused && edOk(k.x, `1f916.checkpoint.v1:${pr.log}:${pr.checkpoint.tree_size}:${pr.checkpoint.root}:${pr.checkpoint.created_at}`, pr.checkpoint.sig);
    out.push(`${ok && sigOk ? "PASS" : "FAIL"}  inclusion  ${pr.log} event=${pr.event.id} index=${pr.event.leaf_index} under size=${pr.checkpoint.tree_size}${k.refused ? `: ${k.refused}` : k.epoch === undefined ? "" : `  [key epoch ${k.epoch}]`}`);
    if (!(ok && sigOk)) failed = true;
    else if (k.epoch !== undefined) usedEpoch(k.epoch);
  }
}

// 4. Consistency proof.
if (args.consistency) {
  const read = readProofFile(args.consistency, "a consistency proof", [
    "log",
    "proof",
    "from.tree_size",
    "from.root",
    "to.tree_size",
    "to.root",
  ]);
  if (read.bad) {
    inputUnusable = true;
    out.push(`UNUSABLE  consistency  ${read.bad}`);
  } else {
    const pr = read.proof;
    const ok = verifyConsistency(pr.from.tree_size, pr.to.tree_size, pr.from.root, pr.to.root, pr.proof);
    out.push(`${ok ? "PASS" : "FAIL"}  consistency  ${pr.log} ${pr.from.tree_size} -> ${pr.to.tree_size} (append-only between checkpoints)`);
    if (!ok) failed = true;
  }
}

if (followed)
  out.push(
    `....  the registry rotated its key after the one you pinned (epoch ${pinEpoch} -> ${regChain.activeEpoch}); this run checked signatures with the newer key(s) by following rotation statements, each signed by the old and the new key. A statement the old key signed is only that key holder's word: if the old key leaked, its thief can sign one too. Cross-check the current key against the project site and pin it to get the plain verdict.`,
  );
for (const line of out) console.log(line);
console.log("");
// witnessed implies anchored: it now requires a pinned witness key whose
// countersignature covers this root, and that witness verified the registry.
// witness-unusable ranks above the unwitnessed verdicts and below a real
// failure: the record may be fine, but the check the caller ASKED for could
// not be performed, and reporting that as though no witness had been
// requested makes the verdict string and the exit code — the two things
// people quote and branch on — byte-identical to a run that never asked.
const witnessUnusable = witnessAskedAndEmpty && !witnessed && !failed;
// input-unusable is the --inclusion/--consistency twin of witness-unusable, and
// it exists for the reason SearlesBox gave on protocol issue #6: the first fix
// stopped the crash and still answered `diverged`, which is the same string a
// genuinely broken proof produces. That reports "this registry's log is
// inconsistent" when the truth is "you handed me a 404 body". A guard that
// turns a crash into a WRONG claim is one verdict short of a fix. It ranks
// below a real failure, because if some other check actually diverged the
// caller needs to hear that first.
// A followed rotation marks every verdict it could otherwise hide behind. A
// witness does not lift it: a witness's countersignature is about the log's
// heads, not about which key the registry is, and a witness that itself
// followed the same statement adds nothing independent about the key.
const followTag = (v) => (followed ? `${v}-followed` : v);
const verdict = failed
  ? "diverged"
  : inputUnusable
    ? "input-unusable"
    : retiredSigner !== undefined && regPin
      ? "retired-signer"
      : witnessed
        ? followTag("witnessed")
        : witnessUnusable
          ? followTag("witness-unusable")
          : anchored
            ? followTag("consistent-unwitnessed")
            : "unanchored";
console.log(`VERDICT: ${verdict}`);
if (verdict === "unanchored")
  console.log(
    "The file is internally consistent and NOTHING MORE. Every signature above was checked against a key carried in the same file, so a fabricated record signed with a freshly minted key produces this exact output. Anchor the run: --registry-key <the registry's published key, from the repo or the project site> and/or --witness-key <a pinned witness>. Until then, treat this as an unverified document.",
  );
if (verdict === "consistent-unwitnessed")
  console.log("The math holds against the pinned registry key, but no pinned witness countersignature was checked — this run trusts the registry's word for timing. Pass --witness with a day file plus --witness-key.");
if (verdict === "retired-signer")
  console.log(
    "The dossier is signed by a key the registry has since retired. If you saved it before the retirement it is what it was; a copy fetched now should be signed by the active key, and one that is not is a stale cache or a forgery by whoever holds the old key. Exit code 6, deliberately not 0: fetch the record again.",
  );
if (verdict.endsWith("-followed"))
  console.log(
    "The checks hold, and the key you pinned is in the registry's key history, but some signatures were made by a NEWER key that this run reached only by following rotation statements. Each statement is signed by both keys, so it proves the holder of your pinned key agreed to the change; it cannot prove that holder was the registry and not someone who stole the key. Deliberately its own verdict, and exit code 5 (3 when the witness file was unusable): pin the current key, cross-checked against the project site, to remove the dependence on the old one.",
  );
if (verdict === "witness-unusable")
  console.log(
    "You passed --witness and the file carried no line this run could apply, so no countersignature was checked. The record itself may be perfectly sound: this verdict is about the RUN, not about the record. Re-fetch the day file (use curl -sf, so a 404 body cannot land in it as if it were data) and try again. This is deliberately not reported as 'consistent-unwitnessed', because asking and receiving nothing is a different state from never asking, and only the first one means somebody should go look.",
  );
if (verdict === "input-unusable")
  console.log(
    "A file you passed to --inclusion or --consistency is not a proof, so that check never ran. The commonest cause is saving an error response: ask the registry for a tree size it has no checkpoint for and it answers 404 with a JSON body that saves and parses perfectly. This is deliberately NOT reported as 'diverged', because 'I could not read your input' and 'the log is inconsistent' are opposite findings and only the second one is news about the registry. Re-fetch with curl -sf so an error body cannot land in the file as if it were data. Exit code 4.",
  );
if (verdict === "diverged") console.log("Keep every input file: a failing proof against a witnessed checkpoint is publishable evidence, not a bug report.");
console.log("");
console.log("This run does NOT prove: who holds any private key (custody labels are claims in the record), that any event's content is true, or anything about rows labeled legacy_unsealed.");
process.exit(
  failed ? 1 : verdict === "input-unusable" ? 4 : verdict.startsWith("witness-unusable") ? 3 : verdict === "retired-signer" ? 6 : verdict.endsWith("-followed") ? 5 : 0,
);
