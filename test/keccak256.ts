// Keccak-256, for tests only.
//
// This exists because of a specific gap. src/assets.ts hardcodes nine function
// selectors and writes the signature each one claims to be in a trailing
// comment. The only test guarding them asserted they were 4-byte hex strings —
// which every wrong selector also is. The comment was the whole proof, and a
// comment is not a proof.
//
// Node cannot close that gap out of the box. `createHash("sha3-256")` is the
// NIST standard, which pads with 0x06; Ethereum uses original Keccak, which
// pads with 0x01, and the two produce entirely different digests for the same
// input. There is no built-in that computes the second one. So rather than add
// a dependency to a repo that has three, here is the permutation — small
// enough to read, and checked against published vectors in keccak256.test.ts
// before anything else relies on it.
//
// Test-only on purpose: nothing in src/ imports this. It is a checker, not a
// component.

const MASK = (1n << 64n) - 1n;

// Rotation offsets and the lane permutation, in the order the rho/pi step walks
// them. Both are fixed by the specification.
const ROT = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];
const PI = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];

const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

const rotl = (v: bigint, n: number): bigint => ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK;

function keccakF(a: bigint[]): void {
  for (let round = 0; round < 24; round++) {
    // theta
    const c: bigint[] = new Array(5);
    for (let x = 0; x < 5; x++) c[x] = a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20];
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) a[x + y] ^= d;
    }
    // rho and pi
    let last = a[1];
    for (let i = 0; i < 24; i++) {
      const j = PI[i];
      const tmp = a[j];
      a[j] = rotl(last, ROT[i]);
      last = tmp;
    }
    // chi
    for (let y = 0; y < 25; y += 5) {
      const t = [a[y], a[y + 1], a[y + 2], a[y + 3], a[y + 4]];
      for (let x = 0; x < 5; x++) a[y + x] = t[x] ^ (~t[(x + 1) % 5] & MASK & t[(x + 2) % 5]);
    }
    // iota
    a[0] ^= RC[round];
  }
}

/** Keccak-256 of raw bytes, as a lowercase hex string with no 0x prefix. */
export function keccak256(input: Uint8Array): string {
  const RATE = 136; // 1088 bits, the rate for a 256-bit digest
  // Original Keccak padding: 0x01 to open, 0x80 on the final byte of the block.
  // SHA-3 opens with 0x06 here, and that single byte is the whole difference.
  const padded = new Uint8Array(Math.ceil((input.length + 1) / RATE) * RATE);
  padded.set(input);
  padded[input.length] = 0x01;
  padded[padded.length - 1] |= 0x80;

  const a: bigint[] = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      // Lanes are little-endian.
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + b]);
      a[i] ^= lane;
    }
    keccakF(a);
  }

  let out = "";
  for (let i = 0; i < 4; i++) {
    const lane = a[i];
    for (let b = 0; b < 8; b++) out += Number((lane >> BigInt(b * 8)) & 0xffn).toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * The 4-byte selector for a Solidity function signature, as `0x` + 8 hex chars.
 * This is the whole point of the file: `selector("balanceOf(address)")` is
 * derived, so it can disagree with a constant that claims to be it.
 */
export function selector(signature: string): string {
  return "0x" + keccak256(new TextEncoder().encode(signature)).slice(0, 8);
}
