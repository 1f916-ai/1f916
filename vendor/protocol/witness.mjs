#!/usr/bin/env node
// capability: registry-key-epochs v1
// A complete, independent witness for any 1f916-protocol registry.
// Single file, zero dependencies. Node 18+.
//
//   node witness.mjs --registry https://1f916.ai --state ./witness-state
//
// Each run (put it in cron, a GitHub Action, anything hourly-ish):
//   1. fetches GET /api/checkpoint,
//   2. verifies the registry signature, with the key of the head's epoch — a
//      key change is refused, as it always was, unless the operator turned
//      on --follow-registry-rotation; then it is followed only through
//      rotation statements signed by BOTH the old and the new key, starting
//      from the key this witness pinned (SPEC section 8b),
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
// The witness's own state files (the pin, the retired keys). One it cannot
// read, parse or write stops the run, recording nothing: guessing past a
// broken pin or a lost retirement would be failing open. The reason is one
// line naming the file, so an operator can repair it.
function readState(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    console.error(`witness state file ${path} could not be read (${String(e?.message ?? e).split("\n")[0]}) — recording nothing; repair or remove it`);
    process.exit(2);
  }
}
function writeState(path, value) {
  try {
    writeFileSync(path, JSON.stringify(value, null, 2));
  } catch (e) {
    console.error(`witness state file ${path} could not be written (${String(e?.message ?? e).split("\n")[0]}) — stopping`);
    process.exit(2);
  }
}
const pinPath = join(stateDir, "registry-key.json");
const pinned = args["registry-key"] ?? readState(pinPath, {}).registry_public_key ?? null;
const offered = cp.registry_public_key?.x;
if (typeof offered !== "string" || !offered) {
  console.error("checkpoint response carries no registry_public_key — refusing");
  process.exit(1);
}
// --- registry key epochs (1f916.registry-rotate.v1, SPEC section 8b) ---
// A registry that rotates its key serves registry_key_history: its keys by
// epoch, oldest first and ending at the active one (the oldest may be left
// out of a long history), and for each epoch after 0 a statement
//   1f916.registry-rotate.v1:<epoch>:<old>:<new>:<at>:<log>=<size>=<root>,...
// signed by both keys, whose last field is the newest head of every log at
// the rotation: the old epoch's final heads. The history is accepted only as
// a chain: consecutive epochs, no key twice, every number an integer, each
// statement exactly the one its neighbours imply, each signed by the key
// before it AND by its own, the last entry the offered key and not retired.
// Each head is then checked with the key of its own key_epoch (a head that
// names none takes the epoch whose window holds its created_at), only if it is
// dated inside that key's window, and, for a retired key, only if it does not
// go past that epoch's committed final head for its log. The date is the
// signer's own word; the final heads are both keys' word, and they are what
// stops a holder of the retired key from extending a log.
//
// FOLLOWING IS OFF BY DEFAULT. A statement the old key signed proves only that
// whoever held the old key signed it. That is a planned key change, or it is a
// thief who took the old key and handed it over to a key of their own; the two
// look the same from here. So by default a key change that chains back to the
// pinned key is recorded as registry-key-rotation-not-followed, with the
// statements, and nothing is countersigned. Every retired key in a history
// that chains to the pinned key, followed or not and however the key was
// pinned, is written into <state>/retired-registry-keys.json: from then on
// this witness refuses any response that offers one of them as the active key. The operator confirms
// the new key out of band and re-pins it (or --registry-key). An operator who
// decides a both-signed statement is enough for them turns on following with
// --follow-registry-rotation on, or "follow_registry_rotation": true in
// <state>/registry-key.json; lines countersigned after following carry
// followed_from, the key the rotation was followed from. A key change the old
// key did not sign is refused either way, exactly as before.
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const spki = (x) => createPublicKey({ key: Buffer.concat([SPKI_PREFIX, fromB64u(x)]), format: "der", type: "spki" });
const isKey = (x) => typeof x === "string" && /^[A-Za-z0-9_-]{43}$/.test(x);
const isWhole = (n) => Number.isSafeInteger(n) && n >= 0;
// RFC 6962: the root of an empty tree is SHA-256 of the empty string.
const EMPTY_TREE_ROOT = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const edOk = (x, msg, sig) => {
  try {
    return typeof sig === "string" && sig.length > 0 && edVerify(null, Buffer.from(msg, "utf8"), spki(x), fromB64u(sig));
  } catch {
    return false;
  }
};
function readFinalHeads(raw, epoch) {
  if (!Array.isArray(raw)) return { error: `epoch ${epoch}: the rotation names no final_heads` };
  const heads = new Map();
  let prev = "";
  for (const h of raw) {
    if (!h || typeof h.log !== "string" || !/^[a-z_]{1,64}$/.test(h.log) || !isWhole(h.tree_size) || !/^[0-9a-f]{64}$/.test(h.root ?? ""))
      return { error: `epoch ${epoch}: a final head is not {log, integer tree_size, 64-hex root}` };
    if (h.log <= prev) return { error: `epoch ${epoch}: final_heads are not in strictly increasing log order` };
    prev = h.log;
    heads.set(h.log, { tree_size: h.tree_size, root: h.root });
  }
  return { heads, text: raw.map((h) => `${h.log}=${h.tree_size}=${h.root}`).join(",") };
}
function chainedHistory(h) {
  if (!Array.isArray(h) || h.length === 0) return { error: "no registry_key_history served" };
  const first = h[0]?.epoch;
  if (!isWhole(first)) return { error: "history entry 0 has no integer epoch" };
  const keys = new Map();
  const seen = new Set();
  for (let i = 0; i < h.length; i++) {
    const e = h[i];
    const epoch = first + i;
    const lastEntry = i === h.length - 1;
    if (!e || e.epoch !== epoch || !isKey(e.public_key)) return { error: `history entry ${i} is not epoch ${epoch} with a key` };
    if (seen.has(e.public_key)) return { error: `epoch ${epoch}: a key that already had an epoch` };
    seen.add(e.public_key);
    // The statement text cannot carry a number's type: "1700001000000" and
    // 1700001000000 print the same, so a string would keep both signatures
    // valid and turn the retirement into nothing.
    if (!isWhole(e.activated_at)) return { error: `epoch ${epoch}: activated_at is not an integer` };
    if (lastEntry ? e.retired_at !== null : !(isWhole(e.retired_at) && e.retired_at > e.activated_at))
      return { error: lastEntry ? `epoch ${epoch} is the last in the history, so its retired_at must be null` : `epoch ${epoch}: retired_at is not an integer after its activated_at` };
    if (i > 0) {
      const prev = h[i - 1];
      const r = e.rotation;
      const fin = readFinalHeads(r?.final_heads, epoch);
      if (fin.error) return { error: fin.error };
      const statement = `1f916.registry-rotate.v1:${epoch}:${prev.public_key}:${e.public_key}:${e.activated_at}:${fin.text}`;
      if (!r || r.statement !== statement) return { error: `epoch ${epoch}: no rotation statement, or not ${statement}` };
      if (prev.retired_at !== e.activated_at) return { error: `epoch ${epoch - 1} retired_at is not epoch ${epoch} activated_at` };
      if (!edOk(prev.public_key, statement, r.old_sig)) return { error: `epoch ${epoch}: old_sig does not verify under the epoch ${epoch - 1} key — a key change the old key did not sign is not a rotation` };
      if (!edOk(e.public_key, statement, r.new_sig)) return { error: `epoch ${epoch}: new_sig does not verify under its own key` };
      keys.get(epoch - 1).finalHeads = fin.heads;
      keys.get(epoch - 1).finalHeadsRaw = r.final_heads;
    }
    // The first entry of a shortened history links to a key not served; it
    // is trusted only through the links after it, or as the pinned key.
    keys.set(epoch, { x: e.public_key, activated_at: e.activated_at, retired_at: lastEntry ? null : e.retired_at, finalHeads: null, finalHeadsRaw: null });
  }
  const last = h[h.length - 1];
  if (last.public_key !== offered) return { error: "registry_public_key is not the last key in registry_key_history" };
  return { keys, activeEpoch: last.epoch };
}
const pinFile = readState(pinPath, {});
const follow = args["follow-registry-rotation"] === "on" || pinFile.follow_registry_rotation === true;
const chain = cp.registry_key_history === undefined ? { error: "no registry_key_history served" } : chainedHistory(cp.registry_key_history);
// Every registry key this witness has seen retired, in its own state file,
// apart from the pin: a pin given with --registry-key is never written, and a
// followed rotation moves the pin, but what was retired stays retired. Written
// only from a history that chains to the pinned key, so a stranger's history
// cannot retire anything here. A retired key is never accepted as the active
// one again, history or not: that is what a holder of the old key would serve
// (the registry itself never brings a retired key back).
const retiredPath = join(stateDir, "retired-registry-keys.json");
const retiredSeen = readState(retiredPath, []);
if (!Array.isArray(retiredSeen)) {
  console.error(`witness state file ${retiredPath} is not a list of retired keys — recording nothing; repair or remove it`);
  process.exit(2);
}
function recordRetired() {
  if (chain.error || !pinned || ![...chain.keys.values()].some((k) => k.x === pinned)) return;
  let changed = false;
  for (const [epoch, k] of chain.keys) {
    if (k.retired_at === null || retiredSeen.some((r) => r.public_key === k.x)) continue;
    retiredSeen.push({ public_key: k.x, epoch, retired_at: k.retired_at, final_heads: k.finalHeadsRaw, seen_at: at });
    changed = true;
  }
  if (changed) writeState(retiredPath, retiredSeen);
}
recordRetired();
const retiredOffered = retiredSeen.find((r) => r.public_key === offered);
if (retiredOffered) {
  appendFileSync(logPath, JSON.stringify({ at, registry, status: "refused-registry-key-retired", pinned, offered, retired_seen: retiredOffered }) + "\n");
  console.error(`REGISTRY KEY ${offered.slice(0, 12)}… IS RETIRED (this witness saw it retired at ${retiredOffered.retired_at}) and is offered as the active key — recorded UNSIGNED, nothing countersigned. Re-pin the key that replaced it once you have confirmed it out of band.`);
  process.exit(1);
}
// followed_from is stamped only while the pin is still the one a followed
// rotation moved it to: an operator who re-pins by hand, or a pin given with
// --registry-key, is a choice of key, not a followed rotation.
let followedFrom = !args["registry-key"] && pinFile.rotated_from && pinFile.followed_to === pinned && pinFile.registry_public_key === pinned ? pinFile.rotated_from : null;
if (pinned && pinned !== offered) {
  const linked = !chain.error && [...chain.keys.values()].some((k) => k.x === pinned);
  if (!linked) {
    const rotation = chain.error ?? "the pinned key is not in the served registry_key_history";
    appendFileSync(logPath, JSON.stringify({ at, registry, status: "refused-registry-key-changed", pinned, offered, rotation }) + "\n");
    console.error(`REGISTRY KEY CHANGED (pinned ${pinned.slice(0, 12)}…, offered ${offered.slice(0, 12)}…) and not by a rotation that chains back to the pinned key (${rotation}) — recorded UNSIGNED, nothing countersigned. This is either a rotation you must confirm out of band, or an impostor.`);
    process.exit(1);
  }
  const statements = cp.registry_key_history.filter((e) => e.rotation).map((e) => ({ epoch: e.epoch, statement: e.rotation.statement, old_sig: e.rotation.old_sig, new_sig: e.rotation.new_sig }));
  if (!follow) {
    appendFileSync(logPath, JSON.stringify({ at, registry, status: "registry-key-rotation-not-followed", pinned, offered, registry_key_epoch: chain.activeEpoch, rotation_statements: statements }) + "\n");
    console.error(`REGISTRY KEY ROTATED (pinned ${pinned.slice(0, 12)}…, offered ${offered.slice(0, 12)}…, epoch ${chain.activeEpoch}): every statement between them is signed by both keys, which proves the holder of the old key signed it — a planned change, or a thief who has that key. Not followed: nothing countersigned, and the pinned key's retirement is recorded (${retiredPath}) so it is never accepted as active again. Confirm the new key out of band, then re-pin it (${pinPath}) or pass --registry-key; or pass --follow-registry-rotation on to follow both-signed rotations.`);
    process.exit(1);
  }
  // A followed rotation moves the trust-on-first-use pin with it (a pin given
  // on the command line stays the operator's to change), and the pin file
  // keeps where it came from and the statements that carried it.
  followedFrom = pinned;
  if (!args["registry-key"]) {
    writeState(pinPath, { ...pinFile, registry, registry_public_key: offered, registry_key_epoch: chain.activeEpoch, rotated_from: pinned, followed_to: offered, rotated_at: at, rotation_statements: statements });
  }
  console.error(`registry key rotated: pinned ${pinned.slice(0, 12)}… → ${offered.slice(0, 12)}… (epoch ${chain.activeEpoch}), every statement between them signed by both keys — followed, as this witness's operator chose`);
}
if (!pinned) {
  writeState(pinPath, { registry, registry_public_key: offered, first_seen: at });
  console.error(`trust-on-first-use: pinned registry key ${offered.slice(0, 12)}… in ${pinPath} — verify it against the project site and repo before relying on this witness`);
}
// The key a head names. With a chain: the key of its epoch (a head that names
// none takes the epoch whose window holds its created_at), only for a head
// dated inside that key's window, and for a retired key only up to the final
// head both keys committed to for its log. Without one (a registry that
// predates epochs, or a history this witness could not chain while the key is
// unchanged): the offered key, for heads that name no epoch or the offered
// key's own.
const servedActive = Array.isArray(cp.registry_key_history) && cp.registry_key_history.length ? cp.registry_key_history.at(-1).epoch : undefined;
function epochAtTime(t) {
  if (chain.error || !isWhole(t)) return undefined;
  for (const [e, k] of chain.keys) if (t >= k.activated_at && (k.retired_at === null || t < k.retired_at)) return e;
  return undefined;
}
function keyFor(row) {
  if (!chain.error) {
    const named = row.key_epoch;
    const epoch = named === undefined || named === null ? epochAtTime(row.created_at) : named;
    if (epoch === undefined) return { refused: "the head names no key_epoch and no epoch in the served history was active at its created_at" };
    if (!isWhole(epoch)) return { refused: "the head's key_epoch is not an integer" };
    const k = chain.keys.get(epoch);
    if (!k) return { refused: `no key for epoch ${epoch} in the served history` };
    if (!isWhole(row.created_at) || row.created_at < k.activated_at) return { refused: `created_at ${row.created_at} is not inside epoch ${epoch}'s window (activated ${k.activated_at})` };
    if (k.retired_at !== null && !(row.created_at < k.retired_at)) return { refused: `created_at ${row.created_at} is not before epoch ${epoch}'s retirement at ${k.retired_at}` };
    if (k.retired_at !== null) {
      const fin = k.finalHeads?.get(row.log);
      if (!fin) return { refused: `epoch ${epoch} was retired with no final head for ${row.log}` };
      if (row.tree_size === 0 && row.root !== EMPTY_TREE_ROOT) return { refused: `a size-0 ${row.log} head under retired epoch ${epoch} must carry the empty tree's root` };
      if (!isWhole(row.tree_size) || row.tree_size > fin.tree_size) return { refused: `epoch ${epoch} was retired at ${row.log} size ${fin.tree_size}; size ${row.tree_size} under that key goes past what both keys committed to` };
      if (row.tree_size === fin.tree_size && row.root !== fin.root) return { refused: `epoch ${epoch} was retired at ${row.log} size ${fin.tree_size} with a different root` };
      // A registry serves the newest head of each log, and under a retired key
      // that is the final head itself. A smaller one is not something to
      // countersign: nothing here links it to the committed head.
      if (row.tree_size < fin.tree_size) return { refused: `epoch ${epoch} was retired at ${row.log} size ${fin.tree_size}; a smaller head under that key is not the newest head` };
    }
    return { x: k.x, epoch };
  }
  if (row.key_epoch === undefined || row.key_epoch === servedActive) return { x: offered };
  return { refused: `head names epoch ${row.key_epoch} and the served history could not be chained (${chain.error})` };
}

for (const row of cp.checkpoints ?? []) {
  // created_at is part of the checkpoint payload; without it no reader can
  // re-verify the registry signature recorded on this line — including the
  // "registry_signature_invalid" lines we publish AS evidence.
  const line = { type: "witness-countersignature", at, registry, log: row.log, tree_size: row.tree_size, root: row.root, created_at: row.created_at, registry_sig: row.sig };
  if (row.key_epoch !== undefined) line.key_epoch = row.key_epoch;
  const key = keyFor(row);
  if (key.refused) {
    line.status = "refused-registry-key-epoch";
    line.detail = key.refused;
    appendFileSync(logPath, JSON.stringify(line) + "\n");
    console.error(`${row.log}: ${key.refused} — recorded UNSIGNED`);
    failures++;
    continue;
  }
  if (followedFrom) line.followed_from = followedFrom;
  // A log's heads never go back to an older key: once this witness has
  // countersigned a head of a log under epoch N, a head of that log under an
  // older epoch is what a holder of the retired key would send.
  const prior = lastHeads[row.log];
  // Nor to a head that names no epoch once this witness countersigned one
  // that named its own (not one this witness placed by its date): a registry
  // that serves key_epoch never stops.
  if (row.key_epoch === undefined && prior && prior.named_key_epoch === true) {
    line.status = "refused-registry-key-epoch";
    line.detail = `the head names no key_epoch, and the last head of ${row.log} this witness countersigned named epoch ${prior.key_epoch}`;
    appendFileSync(logPath, JSON.stringify(line) + "\n");
    console.error(`${row.log}: ${line.detail} — recorded UNSIGNED`);
    failures++;
    continue;
  }
  if (key.epoch !== undefined && prior && isWhole(prior.key_epoch) && key.epoch < prior.key_epoch) {
    line.status = "refused-registry-key-epoch";
    line.detail = `epoch ${key.epoch} is older than epoch ${prior.key_epoch}, which this witness already countersigned for ${row.log}`;
    appendFileSync(logPath, JSON.stringify(line) + "\n");
    console.error(`${row.log}: ${line.detail} — recorded UNSIGNED`);
    failures++;
    continue;
  }
  const payload = `1f916.checkpoint.v1:${row.log}:${row.tree_size}:${row.root}:${row.created_at}`;
  if (!edOk(key.x, payload, row.sig)) {
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
  lastHeads[row.log] = { tree_size: row.tree_size, root: row.root, ...(key.epoch !== undefined ? { key_epoch: key.epoch, named_key_epoch: row.key_epoch !== undefined, created_at: row.created_at } : {}) };
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
