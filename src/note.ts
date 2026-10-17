// Signed notes and checkpoints in the format the certificate logs use.
//
// The registry has always stamped its logs as an RFC 6962 Merkle tree, which
// is the tree Certificate Transparency uses. What it signed over that tree was
// a line of its own. This module says the same three facts (which log, how
// many entries, the root) in the format the transparency-log tools already
// read: a signed note (C2SP signed-note) whose text is a checkpoint (C2SP
// tlog-checkpoint). Go's checksum database, Sigstore and the newer certificate
// logs publish exactly this, so the people and programs that check those can
// check this one without learning anything of ours.
//
//   <origin>\n
//   <tree size, decimal>\n
//   <root hash, base64>\n
//   \n
//   — <key name> <base64(key id || signature)>\n
//
// The signature is Ed25519 over the text before the blank line. The key id is
// the first four bytes of SHA-256(key name || "\n" || 0x01 || public key),
// where 0x01 says Ed25519. Everything here is pure: no storage, no clock.
//
// Checked against a real one: test/note.test.ts carries a checkpoint signed by
// sum.golang.org and the key Go publishes for it, and verifyNote accepts it.

const te = new TextEncoder();
export const NOTE_KEY_NAME = "1f916.ai";
export const ED25519_TYPE = 0x01;

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(text: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) throw new Error("note: not base64");
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  if (b64(out) !== text) throw new Error("note: base64 is not canonical");
  return out;
}
function unhex(s: string): Uint8Array {
  if (typeof s !== "string" || s.length % 2 !== 0 || !/^[0-9a-f]*$/.test(s)) throw new Error("note: expected lowercase hex of even length");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
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

// A key name is what a reader sees beside a signature, so it may hold no space,
// no plus sign and nothing unprintable.
function assertKeyName(name: string): void {
  if (!/^[!-*,-~]+$/.test(name)) throw new Error("note: a key name is printable, with no space and no plus sign");
}

export async function noteKeyId(name: string, publicKey: Uint8Array): Promise<Uint8Array> {
  assertKeyName(name);
  if (publicKey.length !== 32) throw new Error("note: an Ed25519 public key is 32 bytes");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", concat(te.encode(name + "\n"), new Uint8Array([ED25519_TYPE]), publicKey) as unknown as BufferSource));
  return digest.subarray(0, 4);
}

// The verifier key a reader pins: <name>+<key id, hex>+<base64(0x01 || public key)>.
export async function verifierKey(name: string, publicKey: Uint8Array): Promise<string> {
  return `${name}+${hex(await noteKeyId(name, publicKey))}+${b64(concat(new Uint8Array([ED25519_TYPE]), publicKey))}`;
}

export function originOf(log: string): string {
  return `${NOTE_KEY_NAME}/${log}`;
}

// The text that is signed. Three lines, each ended by a newline.
export function checkpointBody(origin: string, treeSize: number, rootHex: string): string {
  if (!/^[!-~]+$/.test(origin)) throw new Error("note: an origin is one printable line");
  if (!Number.isSafeInteger(treeSize) || treeSize < 0) throw new Error("note: a tree size is a whole number");
  const root = unhex(rootHex);
  if (root.length !== 32) throw new Error("note: a root hash is 32 bytes");
  return `${origin}\n${treeSize}\n${b64(root)}\n`;
}

// What follows the key name on a signature line: base64 of the key id and the
// signature together. It is everything a note needs beyond its text and the
// key's name, so a note can be written once, stored, and served again with no
// key in reach.
export function signatureField(keyId: Uint8Array, signature: Uint8Array): string {
  if (keyId.length !== 4 || signature.length !== 64) throw new Error("note: a key id is 4 bytes and an Ed25519 signature 64");
  return b64(concat(keyId, signature));
}

export function noteFromField(body: string, keyName: string, field: string): string {
  assertKeyName(keyName);
  if (!body.endsWith("\n")) throw new Error("note: the text ends with a newline");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(field) || unb64(field).length !== 68) throw new Error("note: a stored signature is base64 of a 4-byte key id and a 64-byte signature");
  return `${body}\n— ${keyName} ${field}\n`;
}

export function formatNote(body: string, keyName: string, keyId: Uint8Array, signature: Uint8Array): string {
  return noteFromField(body, keyName, signatureField(keyId, signature));
}

export interface ParsedNote {
  body: string;
  signatures: { name: string; keyId: string; signature: Uint8Array }[];
}

export function parseNote(text: string): ParsedNote {
  const split = text.lastIndexOf("\n\n");
  if (split < 0) throw new Error("note: no blank line between the text and the signatures");
  const body = text.slice(0, split + 1);
  const tail = text.slice(split + 2);
  if (!tail.endsWith("\n")) throw new Error("note: the last signature line is not ended");
  const signatures = [];
  for (const line of tail.slice(0, -1).split("\n")) {
    const m = line.match(/^— ([!-*,-~]+) ([A-Za-z0-9+/]+={0,2})$/);
    if (!m) throw new Error("note: a signature line is not '— <name> <base64>'");
    const raw = unb64(m[2]);
    if (raw.length < 5) throw new Error("note: a signature holds a key id and at least one byte");
    signatures.push({ name: m[1], keyId: hex(raw.subarray(0, 4)), signature: raw.subarray(4) });
  }
  if (signatures.length === 0) throw new Error("note: no signature");
  return { body, signatures };
}

export interface ParsedCheckpoint {
  origin: string;
  treeSize: number;
  rootHex: string;
  extensions: string[];
}

export function parseCheckpoint(body: string): ParsedCheckpoint {
  if (!body.endsWith("\n")) throw new Error("checkpoint: the text ends with a newline");
  const lines = body.slice(0, -1).split("\n");
  if (lines.length < 3) throw new Error("checkpoint: fewer than three lines");
  if (!/^(0|[1-9][0-9]*)$/.test(lines[1])) throw new Error("checkpoint: the second line is not a tree size");
  const treeSize = Number(lines[1]);
  if (!Number.isSafeInteger(treeSize)) throw new Error("checkpoint: the tree size is too large");
  const root = unb64(lines[2]);
  if (root.length !== 32) throw new Error("checkpoint: the root hash is not 32 bytes");
  return { origin: lines[0], treeSize, rootHex: hex(root), extensions: lines.slice(3) };
}

// True when the note carries a signature by this verifier key over its text.
// A signature by a key the reader did not name is ignored, as the format says:
// a note may be signed by many.
export async function verifyNote(text: string, vkey: string): Promise<boolean> {
  const i = vkey.indexOf("+");
  const j = vkey.indexOf("+", i + 1);
  if (i < 1 || j < 0) throw new Error("note: a verifier key is <name>+<key id>+<base64 key>");
  const name = vkey.slice(0, i);
  const keyBytes = unb64(vkey.slice(j + 1));
  if (keyBytes.length !== 33 || keyBytes[0] !== ED25519_TYPE) throw new Error("note: only Ed25519 verifier keys are read here");
  const publicKey = keyBytes.subarray(1);
  const keyId = hex(await noteKeyId(name, publicKey));
  if (keyId !== vkey.slice(i + 1, j)) throw new Error("note: the verifier key's id is not the id of its key");
  const note = parseNote(text);
  const key = await crypto.subtle.importKey("raw", publicKey as unknown as BufferSource, { name: "Ed25519" }, false, ["verify"]);
  for (const s of note.signatures) {
    if (s.name !== name || s.keyId !== keyId || s.signature.length !== 64) continue;
    if (await crypto.subtle.verify({ name: "Ed25519" }, key, s.signature as unknown as BufferSource, te.encode(note.body) as unknown as BufferSource)) return true;
  }
  return false;
}
