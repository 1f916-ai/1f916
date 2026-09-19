// Live verification of the checkpoint chain of trust.
//
// GET /api/checkpoint, /api/proof and /api/checkpoint/consistency all TELL
// a reader how to verify — the signed payload format, the RFC 6962
// construction, the witness's countersignature payload — and the registry
// publishes every input needed to check them: the public key, the roots,
// the signatures, the proofs. Until now, nothing in this repo actually
// CHECKED any of it. A reader who only ever asks us is trusting us; the
// endpoint's own prose says the math is what closes the gap, so the
// standing order deserves a machine that follows it.
//
// This probe follows the standing order end to end, from public data only
// (no citizen credentials, no private keys, nothing but the public
// endpoints and the public witness day files that already sit in this
// checkout — the registry's own how_to_verify names that directory):
//
//   1. Every head checkpoint's registry signature verifies over the
//      published payload format with the published public key.
//   2. Every countersigned record in the recent witness day files
//      verifies with the witness key the registry itself lists on
//      /api/witnesses — the registry's record of a witness key, not the
//      key embedded in the record that claims it — and, for the record
//      covering the current ledger head, carries the registry's own
//      signature over that head.
//   3. The latest sealed ledger row's inclusion proof folds to the
//      checkpoint's root under RFC 6962 §2.1.1 (verified with
//      src/merkle.ts, the same code that builds the proofs — a live
//      failure means the deployment drifted from the tree it claims).
//   4. A live consistency proof between an attested size and the current
//      head reconstructs BOTH roots from the shared prefix, RFC 6962
//      §2.1.2 / RFC 9162 §2.1.4.2: the log only appended between the two
//      checkpoints.
//
// #151: reads the deployment, so it runs only under LIVE_PROBES. A rate
// limit is a failure, not a skip — a probe that did not run is not a probe
// that passed. The one honest skip this lane allows: the witness cross-
// check needs a day file attesting the current ledger head, which this
// checkout lacks when the run lands before the day's first witness pass.

import test from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { LIVE_PROBES, LIVE_SKIP_REASON, liveFetch } from "../helpers/live.ts";
import { verifyInclusion, verifyConsistency } from "../../src/merkle.ts";

const BASE = "https://1f916.ai";
const UA = { headers: { "User-Agent": "1f916-checkpoint-trust-probe/1.0" } };

async function getJson(path: string, base: string = BASE) {
  const r = await liveFetch(base + path, UA);
  assert.ok(r.ok, `${base + path} -> ${r.status}`);
  return r.json();
}

// Ed25519 over the UTF-8 bytes of the payload, the way both signing keys
// publish: base64url signature, the public key as a JWK on
// /api/checkpoint and as a base64url raw key on the witness record.
function ed25519Valid(pub: { kty: string; crv: string; x: string } | { raw: string }, payload: string, sigB64url: string): boolean {
  const key = "raw" in pub ? { kty: "OKP", crv: "Ed25519", x: pub.raw } : pub;
  let publicKey: import("node:crypto").KeyObject;
  try {
    publicKey = createPublicKey({ key, format: "jwk" });
  } catch {
    return false; // a malformed key is a failed signature, not a crash
  }
  try {
    return verify(null, Buffer.from(payload, "utf8"), publicKey, Buffer.from(sigB64url.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
  } catch {
    return false;
  }
}

interface CheckpointRow {
  id: number;
  log: string;
  tree_size: number;
  root: string;
  sig: string;
  created_at: number;
}

interface WitnessRecord {
  type?: string;
  log: string;
  tree_size: number;
  root: string;
  registry_sig: string;
  witness_sig: string;
  witness_public_key: string;
}

// The witness day files are read from THIS checkout, not fetched: they are
// already a public input (witness/<day>.jsonl in this repository) and the
// probe's only business is comparing them against the deployment. A local
// read also stays inside the gate's letter — liveFetch is origin-locked to
// the registry on purpose. Two days: the run can cross midnight UTC, and a
// single file is empty for the first hours of the day.
function dayRecords(): WitnessRecord[] {
  const days = [new Date(), new Date(Date.now() - 86_400_000)].map((d) => d.toISOString().slice(0, 10));
  const records: WitnessRecord[] = [];
  for (const day of days) {
    const path = new URL(`../../witness/${day}.jsonl`, import.meta.url);
    if (!existsSync(path)) continue;
    records.push(...readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)) as WitnessRecord[]);
  }
  return records;
}

function skipIfOff(t: { skip: (reason: string) => void }) {
  if (!LIVE_PROBES) t.skip(LIVE_SKIP_REASON);
}

test("live: every head checkpoint's registry signature verifies", async (t) => {
  skipIfOff(t);
  const cp = await getJson<{ registry_public_key: { kty: string; crv: string; x: string }; checkpoints: CheckpointRow[] }>("/api/checkpoint");
  assert.ok(cp.checkpoints.length >= 2, "both logs should have a head checkpoint");
  for (const row of cp.checkpoints) {
    const payload = `1f916.checkpoint.v1:${row.log}:${row.tree_size}:${row.root}:${row.created_at}`;
    assert.ok(ed25519Valid(cp.registry_public_key, payload, row.sig), `checkpoint ${row.log} (id ${row.id}): registry signature does not verify over the published payload format`);
  }
});

test("live: the recent day's witness countersignatures verify against the registry's own witness key list", async (t) => {
  skipIfOff(t);
  const records = dayRecords();
  assert.ok(records.some((r) => r.witness_sig), "neither recent day file has a countersigned record — the witness has not run; nothing to cross-check");
  const [cp, reg] = await Promise.all([
    getJson<{ registry_public_key: { kty: string; crv: string; x: string }; checkpoints: CheckpointRow[] }>("/api/checkpoint"),
    getJson<{ witnesses: { name: string; public_key: string }[] }>("/api/witnesses"),
  ]);
  let checked = 0;
  let ledgerHeadChecked = false;
  for (const rec of records) {
    if (!rec.registry_sig || !rec.witness_sig) continue;
    // The witness key must be one the registry itself lists — the
    // independent copy, not the key the record embeds.
    const key = reg.witnesses.find((w) => w.public_key === rec.witness_public_key);
    assert.ok(key, `the day file names witness key ${rec.witness_public_key.slice(0, 8)}… that the registry does not list`);
    // The witness attests the head it verified, whatever size that was.
    const payload = `1f916.witness.v1:https://1f916.ai:${rec.log}:${rec.tree_size}:${rec.root}`;
    assert.ok(ed25519Valid({ raw: rec.witness_public_key }, payload, rec.witness_sig), `witness countersignature for ${rec.log} (size ${rec.tree_size}) does not verify`);
    // For the record covering a head the registry still serves, the
    // recorded registry_sig must be the registry's own signature over that
    // exact head, checked with the key from /api/checkpoint.
    const head = cp.checkpoints.find((c) => c.log === rec.log && c.tree_size === rec.tree_size);
    if (head) {
      assert.ok(ed25519Valid(cp.registry_public_key, `1f916.checkpoint.v1:${rec.log}:${rec.tree_size}:${rec.root}:${head.created_at}`, rec.registry_sig), `recorded registry signature does not match the ${rec.log} head (size ${rec.tree_size})`);
      if (rec.log === "ledger") ledgerHeadChecked = true;
    }
    checked++;
  }
  assert.ok(checked > 0, "no countersigned record in either day file");
  if (!ledgerHeadChecked) {
    // The ledger head has been stable across weeks, so this fires only
    // when the checkout's day files predate it: a lag, not a break.
    t.skip("the day files predate the current ledger head — the registry-vs-witness cross-check resumes once the witness attests it again");
  }
});

test("live: the latest sealed ledger row's inclusion proof folds to the served root (RFC 6962 §2.1.1)", async (t) => {
  skipIfOff(t);
  // The head checkpoint covers tree_size sealed leaves. A few ledger rows
  // predate sealing (legacy_unsealed, published on /api/attest), so the row
  // ids are offset by exactly the unsealed count: the newest row the head
  // proves is unsealed + tree_size, which lands at leaf tree_size - 1. One
  // fetch each, no bisection, and never a row past the last checkpoint.
  const [cp, attest] = await Promise.all([
    getJson<{ checkpoints: CheckpointRow[] }>("/api/checkpoint"),
    getJson<{ treasury: { unsealed_entries: number } }>("/api/attest"),
  ]);
  const head = cp.checkpoints.find((c) => c.log === "ledger");
  assert.ok(head, "the ledger has no head checkpoint yet — nothing to prove");
  const row = attest.treasury.unsealed_entries + head.tree_size;
  const proof = await getJson<{
    event: { id: number; hash: string; leaf_index: number };
    checkpoint: { tree_size: number; root: string };
    proof: string[];
  }>(`/api/proof?log=ledger&event=${row}`);
  assert.equal(proof.event.leaf_index, head.tree_size - 1, "the served leaf index is not the head's last leaf");
  assert.equal(proof.checkpoint.root, head.root, "the served proof does not cover the head root");
  assert.ok(
    await verifyInclusion(proof.event.hash, proof.event.leaf_index, proof.checkpoint.tree_size, proof.proof, proof.checkpoint.root),
    `ledger row ${proof.event.id} (leaf ${proof.event.leaf_index}/${proof.checkpoint.tree_size}) does not verify against the served root`,
  );
});

test("live: a consistency proof reconstructs both roots — the log only appended (RFC 6962 §2.1.2)", async (t) => {
  skipIfOff(t);
  const cp = await getJson<{ checkpoints: CheckpointRow[] }>("/api/checkpoint");
  const heads = new Map(cp.checkpoints.map((c) => [c.log, c]));
  // Candidate from-sizes come from the witness day files: a record exists
  // only where a checkpoint landed, so every recorded size is a real row in
  // the checkpoints table, and any size strictly below the current head is
  // a real append-only step to verify. The ledger is the money log: its
  // steps get first claim on the probe budget.
  const seen = new Set<string>();
  const candidates: { log: string; size: number }[] = [];
  for (const rec of dayRecords()) {
    const head = heads.get(rec.log);
    if (!head || rec.tree_size >= head.tree_size) continue;
    const key = `${rec.log}:${rec.tree_size}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ log: rec.log, size: rec.tree_size });
  }
  candidates.sort((a, b) => (a.log === b.log ? b.size - a.size : a.log === "ledger" ? -1 : b.log === "ledger" ? 1 : b.size - a.size));
  for (const { log, size } of candidates.slice(0, 6)) {
    const r = await liveFetch(`${BASE}/api/checkpoint/consistency?log=${log}&from=${size}&to=${heads.get(log)!.tree_size}`, UA);
    if (r.status === 404) {
      // The witness attested this size; its checkpoint row should still
      // exist. A vanished row is a break, not a miss.
      assert.ok(false, `the witness attested ${log} at size ${size} but the API no longer serves a checkpoint there — the history changed`);
    }
    assert.ok(r.ok, `${log} consistency ${size} -> ${heads.get(log)!.tree_size}: ${r.status}`);
    const body = await r.json();
    assert.equal(body.to.tree_size, heads.get(log)!.tree_size, "the served `to` is not the head size");
    assert.equal(body.to.root, heads.get(log)!.root, "the served `to` root is not the head root");
    assert.ok(verifyConsistency(size, body.to.tree_size, body.from.root, body.to.root, body.proof), `consistency proof (${log} ${size}->${body.to.tree_size}) does not reconstruct both served roots`);
    return;
  }
  t.skip("the day files hold no checkpointed size below a current head — no append-only step to verify today");
});
