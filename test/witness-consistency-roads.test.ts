// witness/bin/witness.mjs: the three roads into a consistency refusal
// (fix/witness-consistency-unavailable; egress, post 5382; tally-stick, c61968;
// maintainer, c62046).
//
// Before this fix one status word, refused-consistency-failure, was written
// for three different events: the consistency fetch threw (the socket), the
// registry answered its own error page (src/index.ts answers a SocietyError
// and an internal error as JSON with a 4xx/5xx, which .json() parses and
// which carries no proof), and a proof arrived and did not fold. Only the
// third measured the chain. witness/2026-09-14.jsonl line 764 is the live
// specimen of the first: status refused-consistency-failure, consistency
// unavailable (TypeError: fetch failed).
//
// These tests run the witness itself as a child, against a registry that
// answers from a file (test/helpers/witness-fake-registry.mjs), with a real
// Ed25519 registry key and a real two-leaf Merkle tree so the proof that
// folds and the proof that does not are both genuine. Each road, the
// countersigned case, the untouched regression case, and two mutants: the
// .ok check removed (a 500 is then attributed to its body, so the road-2
// reason string is testing that line) and verifyConsistency short-circuited
// (road 3 then countersigns, so the road-3 test is testing that call). The
// roads assert a status that did not exist before the fix, so without it the
// file is red.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const WITNESS = join(import.meta.dirname, "..", "witness", "bin", "witness.mjs");
const FAKE = pathToFileURL(join(import.meta.dirname, "helpers", "witness-fake-registry.mjs")).href;
const REGISTRY = "http://registry.invalid";
const LEDGER = "ledger";
const CREATED_AT = 1789400000000;
const UTF8 = "utf8";
const NL = "\n";
const MJS = ".mjs";
const JWK = "jwk";
const HEADS_FILE = "last-heads.json";
const PIN_FILE = "registry-key.json";
const SCENARIO_FILE = "scenario.json";
const LOG_FILE = "countersignatures.jsonl";
const IMPORT_FLAG = "--import";
const REGISTRY_FLAG = "--registry";
const STATE_FLAG = "--state";

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest();
const nodeHash = (l: Buffer, r: Buffer) => sha256(Buffer.concat([Buffer.from([1]), l, r]));
const hex = (b: Buffer) => b.toString("hex");

const registry = generateKeyPairSync("ed25519");
const registryX = (registry.publicKey.export({ format: JWK }) as { x: string }).x;

// A ledger of two leaves. The root of a one-leaf tree is its leaf; the two-leaf
// root folds leaf 1 on the right; the RFC 9162 consistency proof from size 1
// to size 2 is exactly [leaf 1], and verifyConsistency in witness.mjs folds it
// to both roots. A different element is a proof that arrived and did not fold.
const leaf0 = sha256(Buffer.from("leaf-0"));
const leaf1 = sha256(Buffer.from("leaf-1"));
const OLD_ROOT = hex(leaf0);
const NEW_ROOT = hex(nodeHash(leaf0, leaf1));
const GOOD_PROOF = [hex(leaf1)];
const BAD_PROOF = [hex(sha256(Buffer.from("not-leaf-1")))];

const payload = `1f916.checkpoint.v1:${LEDGER}:2:${NEW_ROOT}:${CREATED_AT}`;
const sig = sign(null, Buffer.from(payload, UTF8), registry.privateKey).toString("base64url");
const head = { log: LEDGER, tree_size: 2, root: NEW_ROOT, created_at: CREATED_AT, sig };
const CHECKPOINT = { registry_public_key: { x: registryX }, checkpoints: [head] };

// What the day file carries: the statuses and the consistency strings.
const UNAVAILABLE = "refused-consistency-unavailable";
const FAILURE = "refused-consistency-failure";
const REGRESSION = "refused-regression";
const COUNTERSIGNED = "countersigned";
const ROAD1 = "unavailable (TypeError: fetch failed)";
const NO_PROOF = "unavailable (no proof in body)";
const REWRITE = "FAILED — possible rewrite, evidence, keep this line";
const VERIFIED_FROM_1 = "verified from 1";
const SYNTAX_ERROR = /^unavailable \(SyntaxError/;
const httpReason = (status: number) => `unavailable (HTTP ${status})`;

// What the fake registry answers on the consistency route.
const JSON_KIND = "json";
const NONJSON_KIND = "nonjson";
const THROW_KIND = "throw";
const NOTE = "a 200 with no proof key";
const WORKER_ERROR = "the error page of the worker itself";
const folds = { kind: JSON_KIND, body: { proof: GOOD_PROOF } };
const doesNotFold = { kind: JSON_KIND, body: { proof: BAD_PROOF } };
const socketThrows = { kind: THROW_KIND };
const noProofKey = { kind: JSON_KIND, body: { note: NOTE } };
const htmlPage = { kind: NONJSON_KIND };
const workerError = (status: number) => ({ kind: JSON_KIND, status, body: { error: WORKER_ERROR } });

// One edit each to a copy of the witness; the marker must be present or the
// mutant is the original and the run proves nothing.
const WITHHELD = "refused-consistency-withheld";
const DAY_MS = 24 * 3_600_000;
const HOUR_MS = 3_600_000;
const MSG_SINCE = "the first unavailable line starts the clock at its own timestamp";
const MSG_COUNT = "a repeat from the same pinned head counts up, and keeps the original since";
const MSG_RESET = "a count from an older pinned head does not carry over";
const MSG_CLEARED = "a proof that folds clears the count with the head it belonged to";
const MSG_QUIET = "under a day it is still unavailable, with the clock on the line";
const OK_CHECK = "if (!res.ok) why = `HTTP ${res.status}`;";
const OK_CHECK_REMOVED = "if (false) why = `HTTP ${res.status}`;";
const VERIFY_CALL = "proven = verifyConsistency(";
const VERIFY_SHORTED = "proven = true || verifyConsistency(";

const MSG_UNSIGNED = "a refused head is never countersigned";
const MSG_STATE = "a refusal does not advance state";
const MSG_EXIT = "a refusal exits 1, which witness.yml records as evidence rather than a crash";
const MSG_MARKER = "witness.mjs no longer contains the marker this mutation edits: ";
const MSG_MUTANT_OK = "the no-proof check still refuses it, but the reason is no longer the status";

type Run = { status: number | null; stderr: string; lines: Record<string, any>[]; heads: Record<string, any> };

const scratch = mkdtempSync(join(tmpdir(), "witness-roads-"));
test.after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 3 }));
let n = 0;

function run(consistency: unknown, script = WITNESS, lastSize = 1, withheld?: Record<string, unknown>): Run {
  const state = join(scratch, String(++n));
  mkdirSync(state);
  writeFileSync(join(state, HEADS_FILE), JSON.stringify({ ledger: { tree_size: lastSize, root: OLD_ROOT, ...(withheld ? { withheld } : {}) } }));
  writeFileSync(join(state, PIN_FILE), JSON.stringify({ registry: REGISTRY, registry_public_key: registryX, first_seen: CREATED_AT }));
  const scenario = join(state, SCENARIO_FILE);
  writeFileSync(scenario, JSON.stringify({ checkpoint: CHECKPOINT, consistency }));
  const args = [IMPORT_FLAG, FAKE, script, REGISTRY_FLAG, REGISTRY, STATE_FLAG, state];
  const r = spawnSync(process.execPath, args, { env: { ...process.env, WITNESS_FAKE: scenario }, encoding: UTF8 });
  const logPath = join(state, LOG_FILE);
  const lines = existsSync(logPath) ? readFileSync(logPath, UTF8).trim().split(NL).map((l) => JSON.parse(l)) : [];
  const heads = JSON.parse(readFileSync(join(state, HEADS_FILE), UTF8));
  return { status: r.status, stderr: r.stderr, lines, heads };
}

function mutant(from: string, to: string): string {
  const src = readFileSync(WITNESS, UTF8);
  assert.ok(src.includes(from), MSG_MARKER + from);
  const out = join(scratch, String(++n) + MJS);
  writeFileSync(out, src.replace(from, to));
  return out;
}

function refused(r: Run, status: string): Record<string, any> {
  assert.equal(r.lines.length, 1, r.stderr);
  const line = r.lines[0];
  assert.equal(line.status, status);
  assert.equal(line.witness_sig, undefined, MSG_UNSIGNED);
  assert.equal(r.heads.ledger.tree_size, 1, MSG_STATE);
  assert.equal(r.status, 1, MSG_EXIT);
  return line;
}

test("a proof that folds: countersigned, verified from the last head, state advanced, exit 0", () => {
  const r = run(folds);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0].status, COUNTERSIGNED);
  assert.equal(r.lines[0].consistency, VERIFIED_FROM_1);
  assert.ok(r.lines[0].witness_sig);
  assert.equal(r.heads.ledger.tree_size, 2);
});

test("road 1, the fetch throws: unavailable, named after the error, not a rewrite", () => {
  assert.equal(refused(run(socketThrows), UNAVAILABLE).consistency, ROAD1);
});

test("road 2, the registry answers its own error as JSON: unavailable, named after the status", () => {
  for (const status of [500, 404, 400, 503]) {
    assert.equal(refused(run(workerError(status)), UNAVAILABLE).consistency, httpReason(status));
  }
});

test("road 2, a 200 with no proof in the body: unavailable, not a rewrite", () => {
  assert.equal(refused(run(noProofKey), UNAVAILABLE).consistency, NO_PROOF);
});

test("road 2, a 200 that is not JSON (an error page in front of the worker): unavailable", () => {
  assert.match(refused(run(htmlPage), UNAVAILABLE).consistency, SYNTAX_ERROR);
});

test("road 3, a proof that arrived and did not fold: failure, possible rewrite, the only road that measured the chain", () => {
  assert.equal(refused(run(doesNotFold), FAILURE).consistency, REWRITE);
});

test("a registry head smaller than the witnessed one is still refused-regression, untouched by the split", () => {
  const r = run(folds, WITNESS, 3);
  assert.equal(r.lines.length, 1, r.stderr);
  assert.equal(r.lines[0].status, REGRESSION);
  assert.equal(r.heads.ledger.tree_size, 3);
  assert.equal(r.status, 1);
});

test("mutant: with the .ok check removed, a 500 is attributed to its body, so the road-2 reason string is testing that line", () => {
  const r = run(workerError(500), mutant(OK_CHECK, OK_CHECK_REMOVED));
  assert.equal(r.lines[0].status, UNAVAILABLE);
  assert.equal(r.lines[0].consistency, NO_PROOF, MSG_MUTANT_OK);
});

test("mutant: with verifyConsistency short-circuited, road 3 countersigns, so the road-3 test is testing that call", () => {
  const r = run(doesNotFold, mutant(VERIFY_CALL, VERIFY_SHORTED));
  assert.equal(r.lines[0].status, COUNTERSIGNED);
  assert.equal(r.status, 0);
});

// The quiet road (Ben, 2026-09-15: could a rewrite hide behind a 503?). A
// rewritten chain has no proof to serve from the pinned head, so withholding
// is its only move; the state clocks it and the line says so.

test("unavailable, first time: the line carries since = now and attempts = 1, and the state keeps them", () => {
  const r = run(workerError(503));
  const line = refused(r, UNAVAILABLE);
  assert.equal(line.attempts, 1, MSG_SINCE);
  assert.equal(line.unavailable_since, line.at, MSG_SINCE);
  assert.equal(r.heads.ledger.withheld.from, 1);
  assert.equal(r.heads.ledger.withheld.attempts, 1);
  assert.equal(r.heads.ledger.withheld.since, line.at);
});

test("unavailable again from the same pinned head, under a day: attempts count up, since is kept, still unavailable", () => {
  const since = new Date(Date.now() - 2 * HOUR_MS).toISOString();
  const r = run(socketThrows, WITNESS, 1, { from: 1, since, attempts: 3, last: "HTTP 503" });
  const line = refused(r, UNAVAILABLE);
  assert.equal(line.attempts, 4, MSG_COUNT);
  assert.equal(line.unavailable_since, since, MSG_COUNT);
  assert.equal(line.consistency, ROAD1, MSG_QUIET);
  assert.equal(r.heads.ledger.withheld.attempts, 4);
});

test("unavailable for a day from the same pinned head: withheld, and the sentence names the hours, the attempts, the head and the last reason", () => {
  const since = new Date(Date.now() - DAY_MS - 2 * HOUR_MS).toISOString();
  const r = run(workerError(503), WITNESS, 1, { from: 1, since, attempts: 25, last: "HTTP 503" });
  const line = refused(r, WITHHELD);
  assert.equal(line.attempts, 26);
  assert.equal(line.unavailable_since, since);
  assert.match(line.consistency, /^unavailable for 26 h \(26 attempts, last HTTP 503\) — a proof from 1 the registry has not served; unproven, evidence, keep this line$/);
  assert.match(r.stderr, /CONSISTENCY WITHHELD from 1 for 26 h \(26 attempts, last HTTP 503\)/);
});

test("a count clocked against an older pinned head restarts when the pinned head differs", () => {
  const since = new Date(Date.now() - 3 * DAY_MS).toISOString();
  const r = run(workerError(503), WITNESS, 1, { from: 0, since, attempts: 70, last: "HTTP 503" });
  const line = refused(r, UNAVAILABLE);
  assert.equal(line.attempts, 1, MSG_RESET);
  assert.equal(line.unavailable_since, line.at, MSG_RESET);
});

test("a proof that folds after a run of unavailable: countersigned, and the new head carries no count", () => {
  const since = new Date(Date.now() - DAY_MS - HOUR_MS).toISOString();
  const r = run(folds, WITNESS, 1, { from: 1, since, attempts: 25, last: "HTTP 503" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.lines[0].status, COUNTERSIGNED);
  assert.equal(r.lines[0].attempts, undefined);
  assert.equal(r.heads.ledger.tree_size, 2);
  assert.equal(r.heads.ledger.withheld, undefined, MSG_CLEARED);
});

test("a proof that does not fold after a run of unavailable is still failure, possible rewrite: the clock never softens road 3", () => {
  const since = new Date(Date.now() - 3 * DAY_MS).toISOString();
  const line = refused(run(doesNotFold, WITNESS, 1, { from: 1, since, attempts: 70, last: "HTTP 503" }), FAILURE);
  assert.equal(line.consistency, REWRITE);
});
