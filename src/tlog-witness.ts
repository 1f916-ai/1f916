// The log's side of the public witness protocol (C2SP tlog-witness), and the
// check of what a witness sends back (C2SP tlog-cosignature).
//
// A witness is someone else's machine that remembers the last size of this
// log it signed. The log hands it a newer checkpoint with a proof that the
// newer tree only grew from that size. If the proof holds, the witness signs
// the checkpoint and returns the signature. A log that rewrote its history
// cannot produce that proof, so a countersigned checkpoint is a third party's
// statement that it never saw this log go backwards or fork.
//
//   POST <witness>/add-checkpoint
//     old <size the witness last signed>\n
//     <consistency proof, one base64 hash per line>\n
//     \n
//     <the signed checkpoint note>
//
//   200  one or more signature lines, each "— <name> <base64>\n"
//   409  the witness last signed a different size; the body is that size
//   404  the witness does not know this log     403  it does not trust the signature
//   422  the proof does not hold                400  the request is malformed
//
// The signature a witness returns (cosignature/v1) is Ed25519 over
//   cosignature/v1\n
//   time <unix seconds>\n
//   <the checkpoint text, without its signature lines>
// and its line carries base64(key id (4) || time, u64 big-endian (8) ||
// signature (64)). The key id is the first four bytes of
// SHA-256(name || "\n" || 0x04 || public key).
//
// Everything here is pure: no storage, no clock it does not take as an
// argument, and no network except the `fetchImpl` it is handed. Nothing calls
// this module yet. It is inert until a witness has agreed to list this log
// and its address and key are configured; the request to be listed was sent
// to the public witness network on 2026-10-06.
//
// What it does NOT do: it cannot check the newer ML-DSA-44 cosignature
// (type 0x06), which this runtime has no primitive for. Such a line is
// returned under `unverified` and never counted as a witness's signature.

import { parseCheckpoint, parseNote } from "./note.ts";
import { unhex } from "./merkle.ts";

const te = new TextEncoder();

export const COSIGNATURE_V1_TYPE = 0x04;
export const ML_DSA_44_TYPE = 0x06;
// The protocol caps a consistency proof at 63 lines: a tree of 2^63 leaves.
export const MAX_PROOF_LINES = 63;
// How far ahead of our clock a witness's timestamp may be before it is
// refused. The format lets a verifier reject the future; a few minutes of
// skew between two honest machines is not the future.
export const FUTURE_SKEW_SECONDS = 300;
// A witness's answer is a handful of signature lines or one number. Anything
// longer than this is not an answer this code will parse. The request's
// timeout is the caller's: `fetchImpl` is handed in, and whoever wires this
// to a schedule must give it one.
export const MAX_ANSWER_CHARS = 16_384;

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(text: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) throw new Error("witness: not base64");
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  if (b64(out) !== text) throw new Error("witness: base64 is not canonical");
  return out;
}
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export interface WitnessKey {
  name: string;
  // Lowercase hex of the four-byte key id.
  keyId: string;
  type: number;
  publicKey: Uint8Array;
}

async function keyIdOf(name: string, type: number, publicKey: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", concat(te.encode(name + "\n"), new Uint8Array([type]), publicKey) as unknown as BufferSource));
  return hex(digest.subarray(0, 4));
}

// A witness's verifier key as its operator publishes it:
// <name>+<key id, hex>+<base64(type || public key)>. The id is recomputed and
// must agree, so a key pasted under the wrong name is refused here and not
// discovered later as a signature that never verifies.
export async function parseWitnessVkey(vkey: string): Promise<WitnessKey> {
  const i = vkey.indexOf("+");
  const j = vkey.indexOf("+", i + 1);
  if (i < 1 || j < 0) throw new Error("witness: a verifier key is <name>+<key id>+<base64 key>");
  const name = vkey.slice(0, i);
  if (!/^[!-*,-~]+$/.test(name)) throw new Error("witness: a key name is printable, with no space and no plus sign");
  const claimedId = vkey.slice(i + 1, j);
  const raw = unb64(vkey.slice(j + 1));
  if (raw.length < 2) throw new Error("witness: the key holds a type byte and a public key");
  const type = raw[0];
  const publicKey = raw.subarray(1);
  if (type === COSIGNATURE_V1_TYPE) {
    if (publicKey.length !== 32) throw new Error("witness: an Ed25519 cosigner key is 32 bytes");
  } else if (type === ML_DSA_44_TYPE) {
    if (publicKey.length !== 1312) throw new Error("witness: an ML-DSA-44 cosigner key is 1312 bytes");
  } else {
    throw new Error(`witness: key type 0x${type.toString(16).padStart(2, "0")} is not a cosigner key this log reads (0x04 Ed25519, 0x06 ML-DSA-44)`);
  }
  const keyId = await keyIdOf(name, type, publicKey);
  if (keyId !== claimedId) throw new Error("witness: the verifier key's id is not the id of its key");
  return { name, keyId, type, publicKey };
}

// The request body. `proofHex` is what src/merkle.ts consistencyProof returns:
// lowercase hex, which the wire carries as base64.
export function addCheckpointBody(oldSize: number, proofHex: string[], note: string): string {
  if (!Number.isSafeInteger(oldSize) || oldSize < 0) throw new Error("witness: the old size is a whole number");
  if (proofHex.length > MAX_PROOF_LINES) throw new Error(`witness: a consistency proof is at most ${MAX_PROOF_LINES} lines`);
  if (oldSize === 0 && proofHex.length > 0) throw new Error("witness: an old size of zero takes no proof");
  const lines = proofHex.map((h) => {
    const bytes = unhex(h);
    if (bytes.length !== 32) throw new Error("witness: a proof line is a 32-byte hash");
    return b64(bytes);
  });
  // parseNote throws on anything that is not a note with a signature, so a
  // body is never built around text a witness would refuse to read.
  parseNote(note);
  return `old ${oldSize}\n${lines.map((l) => l + "\n").join("")}\n${note}`;
}

export type WitnessAnswer =
  | { kind: "cosigned"; lines: string[] }
  | { kind: "conflict"; size: number }
  | { kind: "unknown-log" }
  | { kind: "untrusted-signature" }
  | { kind: "bad-proof" }
  | { kind: "bad-request" }
  | { kind: "malformed"; status: number; reason: string }
  | { kind: "other"; status: number };

const SIGNATURE_LINE = /^— ([!-*,-~]+) ([A-Za-z0-9+/]+={0,2})$/;

// What a witness said, read strictly. A 200 whose body is not signature lines,
// or a 409 whose body is not a size, is `malformed` and never a success: an
// answer this code cannot read is not one it may act on.
export function readWitnessAnswer(status: number, body: string): WitnessAnswer {
  if (status === 200) {
    if (!body.endsWith("\n")) return { kind: "malformed", status, reason: "the last signature line is not ended" };
    const lines = body.slice(0, -1).split("\n");
    if (lines.length === 0 || lines.some((l) => !SIGNATURE_LINE.test(l))) return { kind: "malformed", status, reason: "a line is not '— <name> <base64>'" };
    return { kind: "cosigned", lines };
  }
  if (status === 409) {
    const m = body.match(/^(0|[1-9][0-9]*)\n?$/);
    if (!m) return { kind: "malformed", status, reason: "a conflict did not carry a tree size" };
    const size = Number(m[1]);
    if (!Number.isSafeInteger(size)) return { kind: "malformed", status, reason: "the conflicting size is too large" };
    return { kind: "conflict", size };
  }
  if (status === 404) return { kind: "unknown-log" };
  if (status === 403) return { kind: "untrusted-signature" };
  if (status === 422) return { kind: "bad-proof" };
  if (status === 400) return { kind: "bad-request" };
  return { kind: "other", status };
}

// Check one returned line against one witness key and the checkpoint text it
// must be over. Null means "not this witness's valid cosignature of this
// checkpoint": a different name or key id is someone else's line and is
// skipped, as the format says; a wrong length, a failed signature or a
// timestamp from the future is refused. `nowMs` is the caller's clock; without
// it the timestamp is not judged.
export async function verifyCosignatureV1(line: string, key: WitnessKey, checkpointText: string, nowMs?: number): Promise<{ timestamp: number } | null> {
  if (key.type !== COSIGNATURE_V1_TYPE) return null;
  const m = line.match(SIGNATURE_LINE);
  if (!m || m[1] !== key.name) return null;
  let raw: Uint8Array;
  try {
    raw = unb64(m[2]);
  } catch {
    return null;
  }
  if (raw.length !== 4 + 8 + 64) return null;
  if (hex(raw.subarray(0, 4)) !== key.keyId) return null;
  const view = new DataView(raw.buffer, raw.byteOffset + 4, 8);
  const big = view.getBigUint64(0, false);
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const timestamp = Number(big);
  // A witness must not send a zero timestamp for a whole-tree cosignature.
  if (timestamp === 0) return null;
  // A clock that is not a number judges nothing, and a comparison with NaN is
  // always false, which would wave every timestamp through. Refuse instead.
  if (nowMs !== undefined && !Number.isFinite(nowMs)) return null;
  if (nowMs !== undefined && timestamp > Math.floor(nowMs / 1000) + FUTURE_SKEW_SECONDS) return null;
  if (!checkpointText.endsWith("\n")) return null;
  const message = te.encode(`cosignature/v1\ntime ${timestamp}\n${checkpointText}`);
  const cryptoKey = await crypto.subtle.importKey("raw", key.publicKey as unknown as BufferSource, { name: "Ed25519" }, false, ["verify"]);
  const ok = await crypto.subtle.verify({ name: "Ed25519" }, cryptoKey, raw.subarray(12) as unknown as BufferSource, message as unknown as BufferSource);
  return ok ? { timestamp } : null;
}

export interface SubmitArgs {
  // The witness's submission prefix, without a trailing slash.
  url: string;
  key: WitnessKey;
  // The log's own signed checkpoint note, exactly as it is served.
  note: string;
  // The size this log believes the witness last signed. Zero if never.
  lastCosignedSize: number;
  // RFC 6962 consistency proof between two sizes of this log, lowercase hex.
  proofFor: (from: number, to: number) => Promise<string[]>;
  fetchImpl: (url: string, init: { method: string; body: string; headers: Record<string, string> }) => Promise<{ status: number; text: () => Promise<string> }>;
  nowMs: number;
}

export type SubmitResult =
  | { kind: "cosigned"; size: number; oldSize: number; attempts: number; verified: { line: string; timestamp: number }[]; unverified: string[] }
  // The witness has already signed a size past this checkpoint. Nothing is
  // wrong and nothing is owed: the next, larger checkpoint is the one to send.
  // (A witness at exactly this size is asked again and signs it again.)
  | { kind: "witness-ahead"; size: number; witnessSize: number; attempts: number }
  | { kind: "refused"; answer: WitnessAnswer; attempts: number }
  // The witness answered 200 and none of its lines is its valid cosignature
  // of this checkpoint. Recorded as a failure, never as a signature.
  | { kind: "no-valid-cosignature"; attempts: number; unverified: string[] }
  | { kind: "network-error"; message: string; attempts: number };

// Hand one checkpoint to one witness. At most two requests: the first with the
// size we believe the witness holds, and one more with the size it says it
// holds if it disagrees. It does not loop. A witness that disagrees twice is
// reported and left for the next scheduled attempt, because a client that
// chases a moving answer is how a log ends up rate limited or blocked.
export async function submitCheckpoint(args: SubmitArgs): Promise<SubmitResult> {
  const parsed = parseNote(args.note);
  const size = parseCheckpoint(parsed.body).treeSize;
  let oldSize = args.lastCosignedSize;
  let attempts = 0;
  for (let round = 0; round < 2; round++) {
    if (oldSize > size) return { kind: "witness-ahead", size, witnessSize: oldSize, attempts };
    let answer: WitnessAnswer;
    try {
      const proof = oldSize === 0 || oldSize === size ? [] : await args.proofFor(oldSize, size);
      const body = addCheckpointBody(oldSize, proof, args.note);
      attempts++;
      const res = await args.fetchImpl(`${args.url}/add-checkpoint`, { method: "POST", body, headers: { "content-type": "text/plain; charset=utf-8" } });
      const text = await res.text();
      // Only a 200 and a 409 carry a body this code parses. Any other status
      // is read by its status alone, so a long error page from a proxy does
      // not turn "unknown log" into "malformed". The bound limits what is
      // parsed, not what was read: capping the read is `fetchImpl`'s job.
      const hasBody = res.status === 200 || res.status === 409;
      answer = hasBody && text.length > MAX_ANSWER_CHARS ? { kind: "malformed", status: res.status, reason: "the answer is longer than a witness's answer can be" } : readWitnessAnswer(res.status, hasBody ? text : "");
    } catch (e) {
      return { kind: "network-error", message: String(e).slice(0, 200), attempts };
    }
    if (answer.kind === "cosigned") {
      const verified: { line: string; timestamp: number }[] = [];
      const unverified: string[] = [];
      for (const line of answer.lines) {
        // A line this runtime cannot check must never throw its way out of a
        // scheduled job: it is set aside like any other unverified line.
        const ok = await verifyCosignatureV1(line, args.key, parsed.body, args.nowMs).catch(() => null);
        if (ok) verified.push({ line, timestamp: ok.timestamp });
        else unverified.push(line);
      }
      if (verified.length === 0) return { kind: "no-valid-cosignature", attempts, unverified };
      return { kind: "cosigned", size, oldSize, attempts, verified, unverified };
    }
    if (answer.kind === "conflict") {
      // The witness holds a different size than we thought. If it repeats
      // the size we just used, it is contradicting itself, and that is a
      // refusal; so is a second disagreement. Otherwise take the size it
      // names and go round once more, where the check at the top of the loop
      // reports a witness that is already past this checkpoint.
      if (answer.size === oldSize || round === 1) return { kind: "refused", answer, attempts };
      oldSize = answer.size;
      continue;
    }
    return { kind: "refused", answer, attempts };
  }
  // Unreachable: the loop returns on its second round.
  return { kind: "refused", answer: { kind: "other", status: 0 }, attempts };
}
