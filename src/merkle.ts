// RFC 6962 Merkle tree over the sealed chain. The leaves are the chain rows'
// hex hashes (as UTF-8 bytes); the tree is the Certificate Transparency
// construction exactly, so any CT-literate verifier recognizes the shapes:
//
//   leaf hash: SHA-256(0x00 || leaf-bytes)
//   node hash: SHA-256(0x01 || left || right)
//   split point for n > 1 leaves: k = largest power of two < n
//
// Inclusion and consistency proofs follow RFC 6962 §2.1.1 / §2.1.2. All
// functions are pure; the only crypto is WebCrypto SHA-256, so the same file
// runs in the Worker, in node tests, and inside the offline verifier.

const te = new TextEncoder();

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource));
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

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Refuses malformed input rather than coercing it. parseInt("zz", 16) is NaN,
// which silently became 0 here while verify.mjs's Buffer.from(s, "hex")
// truncated instead — two implementations disagreeing on the same bad bytes
// is how a proof that "verifies" on one side fails on the other
// (self-audit, 2026-08-12).
export function unhex(s: string): Uint8Array {
  if (typeof s !== "string" || s.length % 2 !== 0 || !/^[0-9a-f]*$/.test(s)) throw new Error("unhex: expected lowercase hex of even length");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function leafHash(leaf: string): Promise<Uint8Array> {
  return sha256(concat(new Uint8Array([0]), te.encode(leaf)));
}

async function nodeHash(left: Uint8Array, right: Uint8Array): Promise<Uint8Array> {
  return sha256(concat(new Uint8Array([1]), left, right));
}

// Largest power of two strictly less than n (n >= 2).
function splitPoint(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

// Merkle Tree Hash over leaves[start, end). RFC 6962 §2.1.
async function mth(leaves: string[], start: number, end: number): Promise<Uint8Array> {
  const n = end - start;
  if (n === 0) return sha256(new Uint8Array(0));
  if (n === 1) return leafHash(leaves[start]);
  const k = splitPoint(n);
  return nodeHash(await mth(leaves, start, start + k), await mth(leaves, start + k, end));
}

export async function merkleRoot(leaves: string[]): Promise<string> {
  return hex(await mth(leaves, 0, leaves.length));
}

// Inclusion proof for leaves[index] in the tree over leaves[0, size).
// RFC 6962 §2.1.1 PATH(m, D[n]).
export async function inclusionProof(leaves: string[], index: number, size: number): Promise<string[]> {
  async function path(m: number, start: number, end: number): Promise<Uint8Array[]> {
    const n = end - start;
    if (n <= 1) return [];
    const k = splitPoint(n);
    if (m < k) return [...(await path(m, start, start + k)), await mth(leaves, start + k, end)];
    return [...(await path(m - k, start + k, end)), await mth(leaves, start, start + k)];
  }
  return (await path(index, 0, size)).map(hex);
}

// Verify an inclusion proof. RFC 6962 §2.1.1 verification algorithm.
export async function verifyInclusion(leaf: string, index: number, size: number, proof: string[], root: string): Promise<boolean> {
  if (index >= size) return false;
  let fn = index;
  let sn = size - 1;
  let r = await leafHash(leaf);
  for (const p of proof) {
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      r = await nodeHash(unhex(p), r);
      if (fn % 2 === 0) {
        while (fn % 2 === 0 && fn !== 0) {
          fn = Math.floor(fn / 2);
          sn = Math.floor(sn / 2);
        }
      }
    } else {
      r = await nodeHash(r, unhex(p));
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return sn === 0 && hex(r) === root;
}

// Consistency proof between the tree over the first m leaves and the tree
// over the first n leaves (m < n). RFC 6962 §2.1.2 PROOF(m, D[n]).
export async function consistencyProof(leaves: string[], m: number, n: number): Promise<string[]> {
  async function subproof(m2: number, start: number, end: number, isComplete: boolean): Promise<Uint8Array[]> {
    const n2 = end - start;
    if (m2 === n2) return isComplete ? [] : [await mth(leaves, start, end)];
    const k = splitPoint(n2);
    if (m2 <= k) return [...(await subproof(m2, start, start + k, isComplete)), await mth(leaves, start + k, end)];
    return [...(await subproof(m2 - k, start + k, end, false)), await mth(leaves, start, start + k)];
  }
  if (m === n || m === 0) return [];
  return (await subproof(m, 0, n, true)).map(hex);
}

// Verify a consistency proof. This is the RFC 9162 §2.1.4.2 algorithm
// verbatim (RFC 9162 is 6962-bis; the construction is identical and the
// verification steps are specified more precisely there).
export async function verifyConsistency(m: number, n: number, oldRoot: string, newRoot: string, proof: string[]): Promise<boolean> {
  if (m > n) return false;
  if (m === n) return proof.length === 0 && oldRoot === newRoot;
  if (m === 0) return proof.length === 0;
  if (proof.length === 0) return false;

  let fn = m - 1;
  let sn = n - 1;
  while (fn % 2 === 1) {
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }

  const path = proof.map(unhex);
  let i = 0;
  let fr: Uint8Array;
  let sr: Uint8Array;
  if (fn === 0) {
    // m is a power of two: the old root itself is the first component.
    fr = unhex(oldRoot);
    sr = unhex(oldRoot);
  } else {
    fr = path[0];
    sr = path[0];
    i = 1;
  }

  for (; i < path.length; i++) {
    const c = path[i];
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      fr = await nodeHash(c, fr);
      sr = await nodeHash(c, sr);
      while (fn % 2 === 0 && fn !== 0) {
        fn = Math.floor(fn / 2);
        sn = Math.floor(sn / 2);
      }
    } else {
      sr = await nodeHash(sr, c);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }

  return hex(fr) === oldRoot && hex(sr) === newRoot && sn === 0;
}
