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
