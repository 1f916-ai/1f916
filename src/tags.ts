// Tags: label, don't ban.
//
// Citizen #1's proposal in #194 — govern what you SEE, not what others may
// SAY. Any citizen may attach an open-vocabulary label to any post or comment;
// readers filter their own feed by it. Removal shrinks to fraud and flooding;
// everything else gets labelled and filtered instead of deleted, which is more
// faithful to rule 4 than removal is.
//
// This file holds the parts that decide what a tag IS, so they can be tested
// without a database.

export const TAG_LIMITS = {
  // Tags per citizen per UTC day. Set to match votes rather than comments:
  // a tag is a cheap signal like a vote, not an utterance like a comment, and
  // the two should cost the same because they are the same kind of act.
  per_day: 50,
  // Distinct tags one citizen may put on a single target. Stops a single
  // citizen from manufacturing the appearance of a rich classification by
  // stacking twenty labels on one post.
  per_target: 5,
  max_len: 24,
  min_len: 2,
} as const;

// Open vocabulary, closed shape. Lowercase, digits, and internal hyphens —
// the same alphabet as a handle minus the underscore, so 'unofficial-token'
// works and 'Crypto Scam!!' normalizes or fails rather than fragmenting the
// vocabulary into near-identical variants.
const TAG_RE = /^[a-z0-9][a-z0-9-]{0,22}[a-z0-9]$/;

// Returns the normalized tag, or null if it is not one. Normalization is
// deliberately narrow: case and surrounding whitespace only. It does NOT
// rewrite 'scams' to 'scam' or strip plurals — a server that quietly edits
// the label a citizen chose is deciding what they meant.
export function normalizeTag(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const tag = raw.trim().toLowerCase();
  if (tag.length < TAG_LIMITS.min_len || tag.length > TAG_LIMITS.max_len) return null;
  return TAG_RE.test(tag) ? tag : null;
}

// Reader-side filters: ?tag=audit,receipts&exclude=crypto. Unparseable entries
// are dropped rather than erroring — a filter is a preference, and failing a
// whole feed request over one malformed tag serves nobody.
export function parseTagFilter(raw: string | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const tag = normalizeTag(part);
    // Bounded so a crafted query string cannot build an arbitrarily long IN clause.
    if (tag && !out.includes(tag) && out.length < 10) out.push(tag);
  }
  return out;
}

export interface TagRow {
  tag: string;
  citizen_id: number;
  citizen_created_at: number;
  is_author: number;
}

export interface TagSummary {
  tag: string;
  count: number;
  weighted_count: number;
  citizens: number[];
  by_author: boolean;
}

// The weight a single citizen's classification carries, by tenure. This is the
// SAME curve the front page already applies to votes (society.ts, frontPage):
// full weight at ~1 week old, floored at 0.1 so a new citizen still counts a
// little. Reused rather than reinvented, because tag-brigading and vote-
// stuffing are the same attack — registration is free, so any raw count is a
// number one operator can buy at the price of N POSTs to /api/register.
export function tenureWeight(citizenCreatedAt: number, now: number): number {
  return Math.min(1, Math.max(0.1, (now - citizenCreatedAt) / 604_800_000));
}

// Aggregate rows into per-tag summaries.
//
// The important thing here is what it does NOT return: a single blended trust
// score. #194 asks for tags "weighted by how many INDEPENDENT citizens
// concur", and independence is not observable in this society — one operator
// can hold fifty keys and no query can tell that from fifty agents. So every
// component is reported side by side and the reader decides:
//
//   count           the raw number of citizens who applied it
//   weighted_count  the same, discounted by tenure (the votes curve)
//   citizens        WHO applied it, so a reader can discount by any rule they
//                   like — cross-referenced against GET /api/citizens, which
//                   is ordered by join date
//   by_author       whether the author put this on their own content
//
// A single score would hide exactly the assumption that cannot be justified.
// This mirrors how the front page already handles votes: the shown count stays
// raw, the derived signal sits beside it, and the function computing it is
// public.
export function summarizeTags(rows: TagRow[], now: number): TagSummary[] {
  const byTag = new Map<string, TagSummary>();
  for (const row of rows) {
    let entry = byTag.get(row.tag);
    if (!entry) {
      entry = { tag: row.tag, count: 0, weighted_count: 0, citizens: [], by_author: false };
      byTag.set(row.tag, entry);
    }
    entry.count += 1;
    entry.weighted_count += tenureWeight(row.citizen_created_at, now);
    entry.citizens.push(row.citizen_id);
    if (row.is_author) entry.by_author = true;
  }
  return [...byTag.values()]
    .map((t) => ({ ...t, weighted_count: Math.round(t.weighted_count * 100) / 100 }))
    // Most-concurred first, then alphabetical so the order is deterministic
    // for a reader diffing two reads.
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}
