// The log's side of the public witness protocol (src/tlog-witness.ts), run
// against a witness written here from the two specifications (C2SP
// tlog-witness and tlog-cosignature) and not from the module under test.
//
// The fake witness below builds and checks signatures with node:crypto and
// its own byte handling, so an encoding mistake in the module is not mirrored
// by the thing that judges it. It borrows one function from the repository,
// verifyConsistency, which test/merkle*.test.ts already holds to the RFC.
//
// Killing mutations, each checked in a scratch copy before commit:
//   - use type byte 0x01 instead of 0x04 in the witness key id: the witness's
//     own verifier key is refused, red.
//   - read the timestamp little-endian: the cosignature fails to verify, red.
//   - drop the "time" line from the signed message: fails to verify, red.
//   - accept a line whose name differs from the witness's: another witness's
//     line is counted, red.
//   - skip the key-id comparison: a line under the right name and a different
//     key id is counted, red.
//   - send proof lines as hex instead of base64: the witness answers 400, red.
//   - do not retry after a 409: the catch-up test ends refused, red.
//   - keep retrying after a second 409: the witness sees a third request, red.
//   - treat a 200 with no valid cosignature as cosigned: red.
//   - drop the future-timestamp refusal: a cosignature dated next year is
//     accepted, red.
//   - drop the canonical-base64 check: a re-encoded line is accepted, red.
//   - report a witness AT this size as ahead (`>=` for `>`): nothing is sent
//     and no cosignature comes back, red.
//   - drop the zero-timestamp refusal, or the refusal of a clock that is not
//     a number: each is accepted, red.
//   - drop the answer-length bound: an oversized 200 is parsed, red.
//   - drop the key-length check in parseWitnessVkey: a 31-byte key is read,
//     red.
//   - drop the key-type guard in verifyCosignatureV1: the ML-DSA key's line
//     reaches importKey and throws, red.
//   - weaken the clock check to Number.isNaN: an infinite clock passes, red.
//   - apply the answer bound to every status: a 404 with a long body is
//     malformed instead of unknown-log, red.
//   - drop the catch around verification in submitCheckpoint: a key the
//     runtime cannot import throws out of the submit, red.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";
import { consistencyProof, merkleRoot, verifyConsistency } from "../src/merkle.ts";
import { checkpointBody, formatNote, noteKeyId } from "../src/note.ts";
import { MAX_ANSWER_CHARS, MAX_PROOF_LINES, addCheckpointBody, parseWitnessVkey, readWitnessAnswer, submitCheckpoint, verifyCosignatureV1, type SubmitArgs } from "../src/tlog-witness.ts";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest();
const rawPublic = (k: KeyObject) => Buffer.from(k.export({ format: "jwk" }).x as string, "base64url");
const NOW_S = 1_790_000_000;
const NOW_MS = NOW_S * 1000;

// ---- a log, built with the repository's own tree and note code -------------
const ORIGIN = "log.example/test";
const LOG_KEY_NAME = "log.example";
const logKeys = generateKeyPairSync("ed25519");
const LEAVES = Array.from({ length: 13 }, (_, i) => sha(`leaf-${i}`).toString("hex"));

async function noteAt(size: number, leaves: string[] = LEAVES): Promise<string> {
  const body = checkpointBody(ORIGIN, size, await merkleRoot(leaves.slice(0, size)));
  const sig = edSign(null, Buffer.from(body, "utf8"), logKeys.privateKey);
  return formatNote(body, LOG_KEY_NAME, await noteKeyId(LOG_KEY_NAME, new Uint8Array(rawPublic(logKeys.publicKey))), new Uint8Array(sig));
}
const proofFor = (leaves: string[] = LEAVES) => (from: number, to: number) => consistencyProof(leaves, from, to);

// ---- a witness, written from the specifications ----------------------------
class FakeWitness {
  readonly name: string;
  private readonly keys = generateKeyPairSync("ed25519");
  size = 0;
  rootHex = "";
  now = NOW_S;
  requests: string[] = [];
  knowsLog = true;
  extraLines: string[] = [];
  constructor(name = "witness.example/w1") {
    this.name = name;
  }
  get pub(): Buffer {
    return rawPublic(this.keys.publicKey);
  }
  keyId(): Buffer {
    return sha(Buffer.concat([Buffer.from(this.name + "\n"), Buffer.from([0x04]), this.pub])).subarray(0, 4);
  }
  vkey(): string {
    return `${this.name}+${this.keyId().toString("hex")}+${Buffer.concat([Buffer.from([0x04]), this.pub]).toString("base64")}`;
  }
  cosign(body: string, at = this.now, name = this.name): string {
    const ts = Buffer.alloc(8);
    ts.writeBigUInt64BE(BigInt(at));
    const sig = edSign(null, Buffer.from(`cosignature/v1\ntime ${at}\n${body}`, "utf8"), this.keys.privateKey);
    const id = sha(Buffer.concat([Buffer.from(name + "\n"), Buffer.from([0x04]), this.pub])).subarray(0, 4);
    return `— ${name} ${Buffer.concat([id, ts, sig]).toString("base64")}`;
  }
  async handle(request: string): Promise<{ status: number; text: string }> {
    this.requests.push(request);
    const firstBlank = request.indexOf("\n\n");
    if (firstBlank < 0) return { status: 400, text: "no blank line\n" };
    const head = request.slice(0, firstBlank).split("\n");
    const note = request.slice(firstBlank + 2);
    const old = head[0].match(/^old (0|[1-9][0-9]*)$/);
    if (!old) return { status: 400, text: "no old size line\n" };
    const oldSize = Number(old[1]);
    const proofLines = head.slice(1);
    if (proofLines.length > 63) return { status: 400, text: "proof too long\n" };
    const proof: string[] = [];
    for (const l of proofLines) {
      if (!/^[A-Za-z0-9+/]{43}=$/.test(l)) return { status: 400, text: "proof line is not a base64 hash\n" };
      proof.push(Buffer.from(l, "base64").toString("hex"));
    }
    const split = note.lastIndexOf("\n\n");
    if (split < 0) return { status: 400, text: "not a note\n" };
    const body = note.slice(0, split + 1);
    const lines = body.slice(0, -1).split("\n");
    if (lines.length < 3) return { status: 400, text: "not a checkpoint\n" };
    if (!this.knowsLog || lines[0] !== ORIGIN) return { status: 404, text: "unknown log\n" };
    // The log's signature, checked with this witness's own arithmetic.
    const logPub = rawPublic(logKeys.publicKey);
    const logId = sha(Buffer.concat([Buffer.from(LOG_KEY_NAME + "\n"), Buffer.from([0x01]), logPub])).subarray(0, 4);
    const signed = note
      .slice(split + 2)
      .split("\n")
      .filter(Boolean)
      .some((l) => {
        const m = l.match(/^— (\S+) (\S+)$/);
        if (!m || m[1] !== LOG_KEY_NAME) return false;
        const raw = Buffer.from(m[2], "base64");
        return raw.length === 68 && raw.subarray(0, 4).equals(logId) && edVerify(null, Buffer.from(body, "utf8"), logKeys.publicKey, raw.subarray(4));
      });
    if (!signed) return { status: 403, text: "no trusted signature\n" };
    const size = Number(lines[1]);
    const rootHex = Buffer.from(lines[2], "base64").toString("hex");
    if (oldSize > size) return { status: 400, text: "old size is past the checkpoint\n" };
    if (oldSize !== this.size) return { status: 409, text: `${this.size}\n` };
    if (oldSize === 0 && proof.length > 0) return { status: 422, text: "proof with zero old size\n" };
    if (oldSize === size && rootHex !== this.rootHex && this.size !== 0) return { status: 422, text: "same size, different root\n" };
    if (oldSize > 0 && oldSize < size && !(await verifyConsistency(oldSize, size, this.rootHex, rootHex, proof))) return { status: 422, text: "bad consistency proof\n" };
    this.size = size;
    this.rootHex = rootHex;
    return { status: 200, text: [this.cosign(body), ...this.extraLines].map((l) => l + "\n").join("") };
  }
  fetchImpl: SubmitArgs["fetchImpl"] = async (url, init) => {
    assert.match(url, /\/add-checkpoint$/);
    assert.equal(init.method, "POST");
    const r = await this.handle(init.body);
    return { status: r.status, text: async () => r.text };
  };
}

async function args(w: FakeWitness, size: number, lastCosignedSize: number, over: Partial<SubmitArgs> = {}): Promise<SubmitArgs> {
  return { url: "https://witness.example/w1", key: await parseWitnessVkey(w.vkey()), note: await noteAt(size), lastCosignedSize, proofFor: proofFor(), fetchImpl: w.fetchImpl, nowMs: NOW_MS, ...over };
}
const bodyOf = (note: string) => note.slice(0, note.lastIndexOf("\n\n") + 1);

test("a witness's verifier key is read only when its id is the id of its key", async () => {
  const w = new FakeWitness();
  const key = await parseWitnessVkey(w.vkey());
  assert.equal(key.name, w.name);
  assert.equal(key.keyId, w.keyId().toString("hex"));
  assert.equal(key.type, 0x04);
  assert.deepEqual(Buffer.from(key.publicKey), w.pub);
  // The same key under another name has another id, so this one is refused.
  await assert.rejects(() => parseWitnessVkey(w.vkey().replace(w.name, "someone.else/w")), /not the id of its key/);
  // A log's own key (type 0x01) is not a cosigner key.
  const asLogKey = `${w.name}+${w.keyId().toString("hex")}+${Buffer.concat([Buffer.from([0x01]), w.pub]).toString("base64")}`;
  await assert.rejects(() => parseWitnessVkey(asLogKey), /not a cosigner key/);
  await assert.rejects(() => parseWitnessVkey("no-plus-signs"), /<name>\+<key id>\+<base64 key>/);
});

test("the request body is the old size, the proof in base64, a blank line and the note", async () => {
  const note = await noteAt(9);
  const proof = await consistencyProof(LEAVES, 5, 9);
  const body = addCheckpointBody(5, proof, note);
  const expected = `old 5\n${proof.map((h) => Buffer.from(h, "hex").toString("base64") + "\n").join("")}\n${note}`;
  assert.equal(body, expected);
  assert.ok(proof.length > 0, "the case must carry a proof, or the encoding is not exercised");
  assert.equal(addCheckpointBody(0, [], note), `old 0\n\n${note}`);
  assert.throws(() => addCheckpointBody(0, proof, note), /takes no proof/);
  assert.throws(() => addCheckpointBody(-1, [], note), /whole number/);
  assert.throws(() => addCheckpointBody(5, ["abcd"], note), /32-byte hash/);
  assert.throws(() => addCheckpointBody(5, Array(MAX_PROOF_LINES + 1).fill(proof[0]), note), /at most 63 lines/);
  assert.throws(() => addCheckpointBody(5, proof, "not a note"), /note:/);
});

test("an answer is read strictly: only signature lines are a success, only a size is a conflict", () => {
  assert.deepEqual(readWitnessAnswer(200, "— w.example AAAA\n"), { kind: "cosigned", lines: ["— w.example AAAA"] });
  assert.equal(readWitnessAnswer(200, "— w.example AAAA").kind, "malformed");
  assert.equal(readWitnessAnswer(200, "ok\n").kind, "malformed");
  assert.equal(readWitnessAnswer(200, "").kind, "malformed");
  assert.deepEqual(readWitnessAnswer(409, "5\n"), { kind: "conflict", size: 5 });
  assert.deepEqual(readWitnessAnswer(409, "0"), { kind: "conflict", size: 0 });
  assert.equal(readWitnessAnswer(409, "five\n").kind, "malformed");
  assert.equal(readWitnessAnswer(409, "05\n").kind, "malformed");
  assert.equal(readWitnessAnswer(404, "").kind, "unknown-log");
  assert.equal(readWitnessAnswer(403, "").kind, "untrusted-signature");
  assert.equal(readWitnessAnswer(422, "").kind, "bad-proof");
  assert.equal(readWitnessAnswer(400, "").kind, "bad-request");
  assert.deepEqual(readWitnessAnswer(503, ""), { kind: "other", status: 503 });
});

test("a first checkpoint is cosigned, and the cosignature verifies against the witness's key and the checkpoint text", async () => {
  const w = new FakeWitness();
  const a = await args(w, 5, 0);
  const r = await submitCheckpoint(a);
  assert.equal(r.kind, "cosigned");
  if (r.kind !== "cosigned") return;
  assert.deepEqual({ size: r.size, oldSize: r.oldSize, attempts: r.attempts, unverified: r.unverified }, { size: 5, oldSize: 0, attempts: 1, unverified: [] });
  assert.equal(r.verified.length, 1);
  assert.equal(r.verified[0].timestamp, NOW_S);
  assert.equal(w.requests.length, 1);
  assert.ok(w.requests[0].startsWith("old 0\n\n"));
  // And directly: the line verifies over this checkpoint and no other.
  const key = await parseWitnessVkey(w.vkey());
  assert.deepEqual(await verifyCosignatureV1(r.verified[0].line, key, bodyOf(a.note), NOW_MS), { timestamp: NOW_S });
  assert.equal(await verifyCosignatureV1(r.verified[0].line, key, bodyOf(await noteAt(9)), NOW_MS), null, "a cosignature of size 5 must not verify over size 9");
});

test("a later checkpoint is cosigned only with a proof that the tree grew from what the witness last signed", async () => {
  const w = new FakeWitness();
  assert.equal((await submitCheckpoint(await args(w, 5, 0))).kind, "cosigned");
  const r = await submitCheckpoint(await args(w, 13, 5));
  assert.equal(r.kind, "cosigned");
  assert.equal(w.size, 13);
  // The witness received the proof in base64, one hash per line.
  const sent = w.requests[1].slice(0, w.requests[1].indexOf("\n\n")).split("\n");
  assert.equal(sent[0], "old 5");
  assert.deepEqual(sent.slice(1), (await consistencyProof(LEAVES, 5, 13)).map((h) => Buffer.from(h, "hex").toString("base64")));
});

test("a log that rewrote an entry cannot get its next checkpoint cosigned", async () => {
  const w = new FakeWitness();
  assert.equal((await submitCheckpoint(await args(w, 5, 0))).kind, "cosigned");
  const forged = [...LEAVES];
  forged[2] = sha("a rewritten entry").toString("hex");
  const r = await submitCheckpoint(await args(w, 13, 5, { note: await noteAt(13, forged), proofFor: proofFor(forged) }));
  assert.deepEqual(r, { kind: "refused", answer: { kind: "bad-proof" }, attempts: 1 });
  assert.equal(w.size, 5, "the witness must still hold the size it signed before the rewrite");
});

test("when the witness holds a different size than we thought, we ask once more from the size it names", async () => {
  const w = new FakeWitness();
  assert.equal((await submitCheckpoint(await args(w, 5, 0))).kind, "cosigned");
  // We lost our note of the last size and believe it never signed.
  const r = await submitCheckpoint(await args(w, 13, 0));
  assert.equal(r.kind, "cosigned");
  if (r.kind !== "cosigned") return;
  assert.deepEqual({ oldSize: r.oldSize, attempts: r.attempts }, { oldSize: 5, attempts: 2 });
  assert.ok(w.requests[1].startsWith("old 0\n"));
  assert.ok(w.requests[2].startsWith("old 5\n"));
});

test("a witness already past this checkpoint is reported as ahead, with no retry", async () => {
  const w = new FakeWitness();
  assert.equal((await submitCheckpoint(await args(w, 13, 0))).kind, "cosigned");
  const r = await submitCheckpoint(await args(w, 9, 5));
  assert.deepEqual(r, { kind: "witness-ahead", size: 9, witnessSize: 13, attempts: 1 });
  assert.equal(w.requests.length, 2);
  // And when our own note already says so, nothing is sent at all.
  const none = await submitCheckpoint(await args(w, 9, 13));
  assert.deepEqual(none, { kind: "witness-ahead", size: 9, witnessSize: 13, attempts: 0 });
  assert.equal(w.requests.length, 2);
});

test("a witness that disagrees twice is left alone: two requests, never a third", async () => {
  let calls = 0;
  const sizes = [3, 4, 5, 6];
  const fetchImpl: SubmitArgs["fetchImpl"] = async () => ({ status: 409, text: async () => `${sizes[calls++]}\n` });
  const w = new FakeWitness();
  const r = await submitCheckpoint(await args(w, 13, 0, { fetchImpl }));
  assert.equal(calls, 2);
  assert.deepEqual(r, { kind: "refused", answer: { kind: "conflict", size: 4 }, attempts: 2 });
  // A witness that names the very size we just used is contradicting itself.
  calls = 0;
  const same: SubmitArgs["fetchImpl"] = async () => (calls++, { status: 409, text: async () => "5\n" });
  const again = await submitCheckpoint(await args(w, 13, 5, { fetchImpl: same }));
  assert.equal(calls, 1);
  assert.deepEqual(again, { kind: "refused", answer: { kind: "conflict", size: 5 }, attempts: 1 });
});

test("only this witness's own valid line counts; another name, another key, a changed byte and the future do not", async () => {
  const w = new FakeWitness();
  const other = new FakeWitness("witness.example/other");
  const key = await parseWitnessVkey(w.vkey());
  const note = await noteAt(5);
  const body = bodyOf(note);
  const good = w.cosign(body);
  assert.deepEqual(await verifyCosignatureV1(good, key, body, NOW_MS), { timestamp: NOW_S });
  // Another witness's perfectly valid line is not ours.
  assert.equal(await verifyCosignatureV1(other.cosign(body), key, body, NOW_MS), null);
  // The right name over another key: the key id differs.
  assert.equal(await verifyCosignatureV1(other.cosign(body, NOW_S, w.name), key, body, NOW_MS), null);
  // One flipped byte in the signature.
  const raw = Buffer.from(good.split(" ")[2], "base64");
  raw[raw.length - 1] ^= 1;
  assert.equal(await verifyCosignatureV1(`— ${w.name} ${raw.toString("base64")}`, key, body, NOW_MS), null);
  // A changed timestamp breaks the signature: the time is inside what is signed.
  const moved = Buffer.from(good.split(" ")[2], "base64");
  moved.writeBigUInt64BE(BigInt(NOW_S - 1), 4);
  assert.equal(await verifyCosignatureV1(`— ${w.name} ${moved.toString("base64")}`, key, body, NOW_MS), null);
  // A correctly signed line dated a year ahead is refused when we have a clock, and judged on its signature alone when we do not.
  const future = w.cosign(body, NOW_S + 365 * 86400);
  assert.equal(await verifyCosignatureV1(future, key, body, NOW_MS), null);
  assert.deepEqual(await verifyCosignatureV1(future, key, body), { timestamp: NOW_S + 365 * 86400 });
  // A few minutes of skew is not the future.
  assert.deepEqual(await verifyCosignatureV1(w.cosign(body, NOW_S + 120), key, body, NOW_MS), { timestamp: NOW_S + 120 });
  // The witness's own signature under another name. The name is not inside
  // what is signed, so only the comparison of names refuses this.
  assert.equal(await verifyCosignatureV1(good.replace(w.name, "relabelled.example/x"), key, body, NOW_MS), null);
  // The witness's own signature with the key id bytes changed. The key id is
  // not inside what is signed either, so only the comparison of ids refuses it.
  const reId = Buffer.from(good.split(" ")[2], "base64");
  reId[0] ^= 0xff;
  assert.equal(await verifyCosignatureV1(`— ${w.name} ${reId.toString("base64")}`, key, body, NOW_MS), null);
  // A line of the wrong length under the right name and id.
  assert.equal(await verifyCosignatureV1(`— ${w.name} ${Buffer.concat([w.keyId(), Buffer.alloc(64)]).toString("base64")}`, key, body, NOW_MS), null);
});

test("a 200 that carries no valid cosignature from this witness is a failure, and lines we cannot check are never counted", async () => {
  const w = new FakeWitness();
  const impostor = new FakeWitness("witness.example/other");
  const note = await noteAt(5);
  // The witness answers 200 with only someone else's line.
  const fetchImpl: SubmitArgs["fetchImpl"] = async () => ({ status: 200, text: async () => impostor.cosign(bodyOf(note)) + "\n" });
  const r = await submitCheckpoint(await args(w, 5, 0, { fetchImpl }));
  assert.equal(r.kind, "no-valid-cosignature");
  if (r.kind === "no-valid-cosignature") assert.equal(r.unverified.length, 1);
  // A real cosignature beside a line in a format this runtime cannot check
  // (the newer ML-DSA-44 kind is 2,420 bytes): one verified, one set aside.
  const w2 = new FakeWitness();
  w2.extraLines = [`— ${w2.name} ${Buffer.concat([Buffer.from("aabbccdd", "hex"), Buffer.alloc(8), Buffer.alloc(2420, 7)]).toString("base64")}`];
  const mixed = await submitCheckpoint(await args(w2, 5, 0));
  assert.equal(mixed.kind, "cosigned");
  if (mixed.kind === "cosigned") {
    assert.equal(mixed.verified.length, 1);
    assert.equal(mixed.unverified.length, 1);
  }
});

test("a witness that does not know the log, and a network that fails, are reported and not thrown", async () => {
  const w = new FakeWitness();
  w.knowsLog = false;
  assert.deepEqual(await submitCheckpoint(await args(w, 5, 0)), { kind: "refused", answer: { kind: "unknown-log" }, attempts: 1 });
  const down: SubmitArgs["fetchImpl"] = async () => {
    throw new Error("connect ETIMEDOUT");
  };
  const r = await submitCheckpoint(await args(new FakeWitness(), 5, 0, { fetchImpl: down }));
  assert.equal(r.kind, "network-error");
  if (r.kind === "network-error") assert.match(r.message, /ETIMEDOUT/);
});

// The notes below come from the second deploy audit, 2026-10-06: each guard
// existed and had no test that would notice it gone.
test("a verifier key of the wrong length or with a name that cannot be a key name is refused, and an ML-DSA key is read but never verifies here", async () => {
  const w = new FakeWitness();
  const short = Buffer.concat([Buffer.from([0x04]), w.pub.subarray(0, 31)]);
  const shortId = sha(Buffer.concat([Buffer.from(w.name + "\n"), short])).subarray(0, 4).toString("hex");
  await assert.rejects(() => parseWitnessVkey(`${w.name}+${shortId}+${short.toString("base64")}`), /32 bytes/);
  await assert.rejects(() => parseWitnessVkey(w.vkey().replace(w.name, "has space")), /printable, with no space/);
  // A post-quantum cosigner key: 1,312 bytes under type 0x06.
  const pq = Buffer.alloc(1312, 9);
  const pqId = sha(Buffer.concat([Buffer.from("pq.example/w\n"), Buffer.from([0x06]), pq])).subarray(0, 4);
  const pqKey = await parseWitnessVkey(`pq.example/w+${pqId.toString("hex")}+${Buffer.concat([Buffer.from([0x06]), pq]).toString("base64")}`);
  assert.equal(pqKey.type, 0x06);
  const body = bodyOf(await noteAt(5));
  // A line of the Ed25519 length under this key's name and id, with a real
  // timestamp: the only thing that refuses it is that the key is not an
  // Ed25519 key. (With timestamp zero it would be refused for that instead.)
  const pqTime = Buffer.alloc(8);
  pqTime.writeBigUInt64BE(BigInt(NOW_S));
  assert.equal(await verifyCosignatureV1(`— pq.example/w ${Buffer.concat([pqId, pqTime, Buffer.alloc(64)]).toString("base64")}`, pqKey, body, NOW_MS), null);
  await assert.rejects(() => parseWitnessVkey(`pq.example/w+${pqId.toString("hex")}+${Buffer.concat([Buffer.from([0x06]), pq.subarray(0, 100)]).toString("base64")}`), /1312 bytes/);
});

test("a cosignature in base64 that is not the canonical encoding of its bytes is refused", async () => {
  const w = new FakeWitness();
  const key = await parseWitnessVkey(w.vkey());
  const body = bodyOf(await noteAt(5));
  const good = w.cosign(body);
  const b64 = good.split(" ")[2];
  // 76 bytes leave one byte over, so the text ends "X==" and X carries four
  // unused bits. Setting one of them decodes to the same bytes.
  assert.ok(b64.endsWith("=="));
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const last = b64[b64.length - 3];
  const twin = alphabet[alphabet.indexOf(last) | 1];
  assert.notEqual(twin, last, "the canonical form must have that bit clear, or this is not a second encoding");
  const reencoded = b64.slice(0, -3) + twin + "==";
  assert.deepEqual(Buffer.from(reencoded, "base64"), Buffer.from(b64, "base64"), "same bytes, different text");
  assert.deepEqual(await verifyCosignatureV1(good, key, body, NOW_MS), { timestamp: NOW_S });
  assert.equal(await verifyCosignatureV1(`— ${w.name} ${reencoded}`, key, body, NOW_MS), null);
});

test("a witness at exactly this size is asked again and signs again; only a witness past it is ahead", async () => {
  const w = new FakeWitness();
  assert.equal((await submitCheckpoint(await args(w, 9, 0))).kind, "cosigned");
  const again = await submitCheckpoint(await args(w, 9, 9));
  assert.equal(again.kind, "cosigned");
  if (again.kind === "cosigned") assert.deepEqual({ oldSize: again.oldSize, attempts: again.attempts }, { oldSize: 9, attempts: 1 });
  assert.equal(w.requests.length, 2);
  assert.ok(w.requests[1].startsWith("old 9\n\n"), "the same size takes no proof");
  assert.deepEqual(await submitCheckpoint(await args(w, 9, 10)), { kind: "witness-ahead", size: 9, witnessSize: 10, attempts: 0 });
  assert.equal(w.requests.length, 2);
});

test("a zero timestamp, a clock that is not a number, and an answer too long to be an answer are all refused", async () => {
  const w = new FakeWitness();
  const key = await parseWitnessVkey(w.vkey());
  const body = bodyOf(await noteAt(5));
  // Correctly signed at time zero: the signature holds, the timestamp does not.
  assert.equal(await verifyCosignatureV1(w.cosign(body, 0), key, body, NOW_MS), null);
  assert.equal(await verifyCosignatureV1(w.cosign(body, 0), key, body), null);
  // A next-year timestamp must not slip through because the clock is NaN.
  const future = w.cosign(body, NOW_S + 365 * 86400);
  assert.equal(await verifyCosignatureV1(future, key, body, Number.NaN), null);
  assert.equal(await verifyCosignatureV1(w.cosign(body), key, body, Number.NaN), null);
  // An infinite clock would put every timestamp in the past.
  assert.equal(await verifyCosignatureV1(future, key, body, Number.POSITIVE_INFINITY), null);
  assert.equal(await verifyCosignatureV1(w.cosign(body), key, body, Number.NEGATIVE_INFINITY), null);
  // An oversized 200: valid lines repeated past the bound.
  const line = w.cosign(body) + "\n";
  const huge = line.repeat(Math.ceil((MAX_ANSWER_CHARS + 1) / line.length));
  assert.ok(huge.length > MAX_ANSWER_CHARS);
  const fetchImpl: SubmitArgs["fetchImpl"] = async () => ({ status: 200, text: async () => huge });
  const r = await submitCheckpoint(await args(new FakeWitness(), 5, 0, { fetchImpl }));
  assert.equal(r.kind, "refused");
  if (r.kind === "refused") assert.equal(r.answer.kind, "malformed");
});

// Third audit round, 2026-10-06: the bound on an answer applied to every
// status, so a long error page turned "unknown log" into "malformed"; and a
// verifier that threw would have thrown out of the submit.
test("only an answer whose body is parsed is bounded, and a line the runtime cannot check is set aside without throwing", async () => {
  const long = "x".repeat(MAX_ANSWER_CHARS + 500);
  const notFound: SubmitArgs["fetchImpl"] = async () => ({ status: 404, text: async () => long });
  assert.deepEqual(await submitCheckpoint(await args(new FakeWitness(), 5, 0, { fetchImpl: notFound })), { kind: "refused", answer: { kind: "unknown-log" }, attempts: 1 });
  const conflict: SubmitArgs["fetchImpl"] = async () => ({ status: 409, text: async () => long });
  const c = await submitCheckpoint(await args(new FakeWitness(), 5, 0, { fetchImpl: conflict }));
  assert.equal(c.kind, "refused");
  if (c.kind === "refused") assert.equal(c.answer.kind, "malformed");
  // A key object whose public key the runtime cannot import, reached by a
  // line under its own name and id: importKey throws, and the line is simply
  // not verified.
  const w = new FakeWitness();
  const real = await parseWitnessVkey(w.vkey());
  const broken = { ...real, publicKey: real.publicKey.subarray(0, 31) };
  const r = await submitCheckpoint(await args(w, 5, 0, { key: broken }));
  assert.equal(r.kind, "no-valid-cosignature");
});
