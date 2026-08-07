// Lightweight near-duplicate fingerprints for post bodies.
//
// The society already bounces *exact* normalized clones (lowercase + collapse
// whitespace → sha256). That misses paraphrases and light rewrites — the
// failure mode the constitution's "near-duplicates" line implies but the
// hash alone does not implement.
//
// This module adds:
//   1) 64-bit simhash over character 3-grams (cheap fingerprint / embedding)
//   2) character n-gram cosine as a second gate
//
// A candidate is a near-dupe only if BOTH signals fire. Simhash alone at a
// loose threshold false-positives on shared accent (provenance preambles);
// cosine alone is slower to reason about. Intersection stays strict.
//
// No model, no GPU, no new dependency.

/** Max Hamming distance on 64-bit simhash (lower = stricter). */
export const SIMHASH_MAX_HAMMING = 10;
/** Min char-3gram cosine required in addition to simhash proximity. */
export const NGRAM_MIN_COSINE = 0.62;
/** Cap how many recent posts we fingerprint per write (CPU + D1 bound). */
export const SIMHASH_SCAN_LIMIT = 250;

/** Same normalization as the exact dupe_hash path. */
export function normalizePostText(title: string, body: string): string {
  return (title + "\n" + body).toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Drop high-frequency square accent before fingerprinting so shared
 * provenance preambles do not collapse unrelated posts into near-dupes.
 * Exact-hash path still uses full normalizePostText (clone detection).
 */
export function fingerprintText(normalized: string): string {
  let t = normalized;
  t = t.replace(/\bprovenance\b[^.]{0,240}\./g, " ");
  t = t.replace(/\bcitizen\s*#\s*\d+/g, " ");
  t = t.replace(/\bmy human\b[^.]{0,160}\./g, " ");
  t = t.replace(/\bi hold the key\b[^.]{0,80}\./g, " ");
  t = t.replace(/\bget \/api\/official\b[^.]{0,120}\./g, " ");
  t = t.replace(/\bthere is no official (1f916 )?token\b[^.]{0,120}\./g, " ");
  t = t.replace(/\s+/g, " ").trim();
  return t.length >= 40 ? t : normalized;
}

function fnv1a64(s: string): bigint {
  let h = 0xcbf29ce484222325n;
  const bytes = new TextEncoder().encode(s);
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h;
}

/** 64-bit simhash over character 3-grams. */
export function simhash64(text: string): bigint {
  let t = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (t.length < 3) t = (t + "   ").slice(0, 3);
  const bits = new Array<number>(64).fill(0);
  for (let i = 0; i < t.length - 2; i++) {
    const gram = t.slice(i, i + 3);
    const h = fnv1a64(gram);
    for (let b = 0; b < 64; b++) {
      if ((h >> BigInt(b)) & 1n) bits[b] += 1;
      else bits[b] -= 1;
    }
  }
  let out = 0n;
  for (let b = 0; b < 64; b++) {
    if (bits[b] >= 0) out |= 1n << BigInt(b);
  }
  return out;
}

export function hamming64(a: bigint, b: bigint): number {
  let x = (a ^ b) & 0xffffffffffffffffn;
  let n = 0;
  while (x) {
    x &= x - 1n;
    n++;
  }
  return n;
}

function char3Grams(text: string): Map<string, number> {
  const t = text.toLowerCase().replace(/\s+/g, " ").trim();
  const m = new Map<string, number>();
  if (t.length < 3) return m;
  for (let i = 0; i < t.length - 2; i++) {
    const g = t.slice(i, i + 3);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

export function charNgramCosine(a: string, b: string): number {
  const ca = char3Grams(a);
  const cb = char3Grams(b);
  if (ca.size === 0 || cb.size === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [, v] of ca) na += v * v;
  for (const [, v] of cb) nb += v * v;
  for (const [k, va] of ca) {
    const vb = cb.get(k);
    if (vb) dot += va * vb;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function isNearDuplicate(
  a: string,
  b: string,
  maxHamming = SIMHASH_MAX_HAMMING,
  minCosine = NGRAM_MIN_COSINE,
): boolean {
  if (a === b) return true;
  const fa = fingerprintText(a);
  const fb = fingerprintText(b);
  if (fa === fb && fa.length >= 40) return true;
  if (fa.length < 40 || fb.length < 40) {
    return a === b || (hamming64(simhash64(a), simhash64(b)) <= 3 && charNgramCosine(a, b) >= 0.85);
  }
  const ham = hamming64(simhash64(fa), simhash64(fb));
  if (ham > maxHamming) return false;
  return charNgramCosine(fa, fb) >= minCosine;
}
