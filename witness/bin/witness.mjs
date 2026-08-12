#!/usr/bin/env node
// A complete, independent witness for any 1f916-protocol registry.
// Single file, zero dependencies. Node 18+.
//
//   node witness.mjs --registry https://1f916.ai --state ./witness-state
//
// Each run (put it in cron, a GitHub Action, anything hourly-ish):
//   1. fetches GET /api/checkpoint,
//   2. verifies the registry signature,
//   3. fetches a consistency proof from the last head this witness saw and
//      verifies the log only appended — a failed proof is recorded loudly,
//      never skipped,
//   4. countersigns {log, tree_size, root} with YOUR Ed25519 key,
//   5. appends one JSON line per log to <state>/countersignatures.jsonl.
//
// Publish that file anywhere the registry cannot touch (your repo, your
// site), then register the pointer: POST /api/witness {name, url,
// public_key}. Your first run generates a keypair in <state>/witness-key.json
// — back it up; it IS your witness identity.
//
// Witness independence is the security parameter of the whole protocol:
// the more of you there are, the less anyone has to trust the registry.

import { createHash, createPublicKey, createPrivateKey, generateKeyPairSync, sign as edSign, verify as edVerify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i]?.slice(2)] = process.argv[i + 1];
const registry = (args.registry ?? "https://1f916.ai").replace(/\/$/, "");
const stateDir = args.state ?? "./witness-state";
mkdirSync(stateDir, { recursive: true });

const b64u = (b) => Buffer.from(b).toString("base64url");
const fromB64u = (s) => Buffer.from(s, "base64url");
const sha256 = (b) => createHash("sha256").update(b).digest();
const nodeHash = (l, r) => sha256(Buffer.concat([Buffer.from([1]), l, r]));

// --- witness identity ---
const keyPath = join(stateDir, "witness-key.json");
let keys;
if (existsSync(keyPath)) {
  keys = JSON.parse(readFileSync(keyPath, "utf8"));
} else {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  keys = {
    public_key: publicKey.export({ format: "jwk" }).x,
    private_key_pkcs8_b64: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    note: "This key IS your witness identity. Back it up. Never send it anywhere.",
  };
  writeFileSync(keyPath, JSON.stringify(keys, null, 2), { mode: 0o600 });
  console.error(`new witness identity generated at ${keyPath} — public key ${keys.public_key}`);
}
const privKey = createPrivateKey({ key: Buffer.from(keys.private_key_pkcs8_b64, "base64"), format: "der", type: "pkcs8" });

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

// --- RFC 9162 consistency verification ---
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

const statePath = join(stateDir, "last-heads.json");
const lastHeads = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
const logPath = join(stateDir, "countersignatures.jsonl");
const at = new Date().toISOString();
let failures = 0;

const cpRes = await fetch(`${registry}/api/checkpoint`);
if (!cpRes.ok) {
  console.error(`${registry}/api/checkpoint answered ${cpRes.status} — recording nothing, exiting non-zero`);
  process.exit(1);
}
const cp = await cpRes.json();
// The registry key must not come from the registry alone: verifying its
// signature with a key it just handed us proves only that it can sign its own
// output (self-audit, 2026-08-12). Pin it with --registry-key, or accept it
// once (trust-on-first-use), persist it, and refuse silent changes forever
// after — a key swap is now a loud, recorded refusal instead of a shrug.
const pinPath = join(stateDir, "registry-key.json");
const pinned = args["registry-key"] ?? (existsSync(pinPath) ? JSON.parse(readFileSync(pinPath, "utf8")).registry_public_key : null);
const offered = cp.registry_public_key?.x;
if (typeof offered !== "string" || !offered) {
  console.error("checkpoint response carries no registry_public_key — refusing");
  process.exit(1);
}
if (pinned && pinned !== offered) {
  appendFileSync(logPath, JSON.stringify({ at, registry, status: "refused-registry-key-changed", pinned, offered }) + "\n");
  console.error(`REGISTRY KEY CHANGED (pinned ${pinned.slice(0, 12)}…, offered ${offered.slice(0, 12)}…) — recorded UNSIGNED, nothing countersigned. This is either a rotation you must confirm out of band, or an impostor.`);
  process.exit(1);
}
if (!pinned) {
  writeFileSync(pinPath, JSON.stringify({ registry, registry_public_key: offered, first_seen: at }, null, 2));
  console.error(`trust-on-first-use: pinned registry key ${offered.slice(0, 12)}… in ${pinPath} — verify it against the project site and repo before relying on this witness`);
}
const regKeyRaw = fromB64u(offered);
const regKey = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), regKeyRaw]), format: "der", type: "spki" });

for (const row of cp.checkpoints ?? []) {
  // created_at is part of the checkpoint payload; without it no reader can
  // re-verify the registry signature recorded on this line — including the
  // "registry_signature_invalid" lines we publish AS evidence.
  const line = { type: "witness-countersignature", at, registry, log: row.log, tree_size: row.tree_size, root: row.root, created_at: row.created_at, registry_sig: row.sig };
  const payload = `1f916.checkpoint.v1:${row.log}:${row.tree_size}:${row.root}:${row.created_at}`;
  if (!edVerify(null, Buffer.from(payload, "utf8"), regKey, fromB64u(row.sig))) {
    line.status = "registry_signature_invalid";
    appendFileSync(logPath, JSON.stringify(line) + "\n");
    console.error(`${row.log}: REGISTRY SIGNATURE INVALID — recorded UNSIGNED`);
    failures++;
    continue;
  }
  // FAIL CLOSED (open-chair, c5917 on the founding square, 2026-08-12): a
  // witness that signs a head it could not prove consistent — or a regressed
  // head — is countersigning a possible rewrite. On any failure: record the
  // evidence line UNSIGNED, do not advance state, exit non-zero. A witness's
  // signature must mean "I verified this", never "I saw this".
  const last = lastHeads[row.log];
  let proven = false;
  if (last && last.tree_size > row.tree_size) {
    line.status = "refused-regression";
    line.consistency = `REGRESSION: registry head ${row.tree_size} is smaller than witnessed ${last.tree_size} — evidence, keep this line`;
    console.error(`${row.log}: TREE SHRANK — recorded UNSIGNED, state not advanced`);
    appendFileSync(logPath, JSON.stringify(line) + "\n");
    failures++;
    continue;
  } else if (last && last.tree_size <= row.tree_size) {
    try {
      const cons = await (await fetch(`${registry}/api/checkpoint/consistency?log=${row.log}&from=${last.tree_size}&to=${row.tree_size}`)).json();
      proven = cons.proof !== undefined && verifyConsistency(last.tree_size, row.tree_size, last.root, row.root, cons.proof);
      line.consistency = proven ? `verified from ${last.tree_size}` : "FAILED — possible rewrite, evidence, keep this line";
    } catch (e) {
      line.consistency = `unavailable (${String(e).slice(0, 80)})`;
      proven = false;
    }
    if (!proven) {
      line.status = "refused-consistency-failure";
      console.error(`${row.log}: CONSISTENCY NOT PROVEN from ${last.tree_size} to ${row.tree_size} — recorded UNSIGNED, state not advanced`);
      appendFileSync(logPath, JSON.stringify(line) + "\n");
      failures++;
      continue;
    }
  } else {
    line.consistency = "first observation";
    proven = true;
  }
  line.status = "countersigned";
  const counterPayload = `1f916.witness.v1:${registry}:${row.log}:${row.tree_size}:${row.root}`;
  line.witness_sig = b64u(edSign(null, Buffer.from(counterPayload, "utf8"), privKey));
  line.witness_public_key = keys.public_key;
  appendFileSync(logPath, JSON.stringify(line) + "\n");
  lastHeads[row.log] = { tree_size: row.tree_size, root: row.root };
  console.log(`${row.log}: countersigned size=${row.tree_size} (${line.consistency})`);
}
// A log this witness has seen before that is missing from the response is not
// nothing: a registry can drop a log as easily as rewrite one, and silence
// would be indistinguishable from health.
for (const known of Object.keys(lastHeads)) {
  if (!(cp.checkpoints ?? []).some((r) => r.log === known)) {
    appendFileSync(logPath, JSON.stringify({ type: "witness-countersignature", at, registry, log: known, status: "refused-log-vanished", detail: `previously witnessed at size ${lastHeads[known].tree_size}, absent from this checkpoint response` }) + "\n");
    console.error(`${known}: PREVIOUSLY WITNESSED LOG IS GONE — recorded UNSIGNED`);
    failures++;
  }
}
writeFileSync(statePath, JSON.stringify(lastHeads, null, 2));
if (failures > 0) {
  console.error(`${failures} head(s) refused — see ${logPath}. A refusal is evidence, not an error in this witness.`);
  process.exit(1);
}
