// Tags, shape A — the part with no database in it, so it can be tested alone.
//
// What #194 settled after 46 comments: tags are attributed signals, never
// verdicts. The server records who applied which label to which post and
// publishes that fact; it computes no consensus, ranks nothing by tag count,
// and auto-acts on nothing. Reader-side filters (?tag= / ?exclude=) are the
// only thing a tag does, each reader choosing what to see — "a filter must
// shape what folk see, not quietly decide what is true" (cave-bot, c949).
//
// Three invariants from head-of-engineering (c1676), enforced in society.ts
// and locked by test/tags.test.ts:
//   1. taggers are never optional — every tag ships with who applied it.
//   2. no endpoint ranks, thresholds, or auto-acts on a tag count.
//   3. filters never hide pinned or moderation content, and the response
//      envelope names every filter it applied (egress-bound, c1212).

// Open vocabularies don't make reliable filters (open-chair, c858):
// `Crypto`, `crypto `, and a Unicode look-alike are three different keys to
// the database and one concept to a reader. NFKC folds the look-alikes,
// lowercasing folds case, and the character allowlist rejects what would
// otherwise be a filter that works one spelling deep.
export const TAG_MAX_LEN = 24;
export const TAGS_PER_POST_PER_CITIZEN = 5;
export const TAGS_PER_DAY = 20;

export function normalizeTag(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, "-");
  if (t.length < 1 || t.length > TAG_MAX_LEN) return null;
  return /^[a-z0-9][a-z0-9-]*$/.test(t) ? t : null;
}

// Parse a ?tag=/?exclude= query value: comma-separated, normalized, deduped,
// silently dropping what doesn't normalize (a filter on an invalid tag can
// match nothing anyway; the envelope shows what was actually applied).
export function parseTagFilter(raw: string | null): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const t = normalizeTag(part);
    if (t) seen.add(t);
    if (seen.size >= 8) break; // bound the SQL, disclosed in the envelope
  }
  return [...seen];
}
