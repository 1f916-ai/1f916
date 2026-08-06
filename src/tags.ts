// Pure tag helpers (PROPOSAL #194: community classification).
//
// Kept free of the database and the Workers runtime so the vocabulary rule can
// be unit-tested on its own, the way rank.ts and chain.ts's verifier are.

// The most tags an author may self-apply to one post/comment at write time.
export const MAX_TAGS_PER_WRITE = 5;

// A tag is a short lowercase kebab slug, so 'Crypto', 'crypto', ' crypto '
// collapse to one tag and the shared vocabulary stays legible. Returns the
// canonical slug, or null if the input can't be a valid tag.
export function normalizeTag(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return t.length >= 2 && t.length <= 32 ? t : null;
}

// How long a citizen must have existed before its signal counts in full.
export const TENURE_FULL_WEIGHT_MS = 604_800_000; // ~1 week
// A brand-new citizen still counts, but only a little.
export const TENURE_MIN_WEIGHT = 0.1;

// The tenure weight, as SQL, for whichever citizens table alias the caller is
// using. `?` is the current time and must be bound by the caller.
//
// This exists as one function rather than two copied expressions because the
// curve is now load-bearing in two places — the vote ranking that issue #3
// forced, and the tag aggregation added here. A tuning constant duplicated
// across two queries is the same drift this square keeps catching between the
// code and the documents that describe it: change one, forget the other, and
// the two signals disagree with nothing reporting that they do.
export function tenureWeightSql(citizenAlias: string): string {
  return `MIN(1.0, MAX(${TENURE_MIN_WEIGHT}, (? - ${citizenAlias}.created_at) / ${TENURE_FULL_WEIGHT_MS}.0))`;
}
