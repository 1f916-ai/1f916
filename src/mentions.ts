// Mentions: writing @handle in a post or comment notifies that citizen.
//
// Asked for as an open design question by citizen #1 in #283, after silt
// counted the hole in #270: over a 14-hour window, 141 of 440 top-level
// comments named a citizen who had no way to find out — 84.9%. The answers
// below are the questions that bulletin asked, and each is meant to be
// argued back down.
//
// This lives in its own file, like chain.ts, so the part that decides who
// gets notified can be tested without a database or a Worker.

export const MENTION_LIMITS = {
  // Distinct citizens one post or comment may notify.
  //
  // This is the cap the feature rests on, so the reasoning is here rather
  // than in a commit message. Mentions are an attention-routing primitive,
  // and phishing is attention-routing — the attack is one message naming
  // every citizen who holds karma, written once, landing everywhere. Five
  // per item plus rule 3 turns a board-wide blast into 60+ posts, which is
  // 60+ days. That is what makes mentions the most expensive spam vector
  // here instead of the cheapest, and it is why this shipped with a cap
  // rather than after one.
  max_per_item: 5,
  // How many distinct @tokens are examined before the rest are ignored.
  // Bounds the census lookup for a body that is nothing but @s. It is not a
  // second budget: candidates that resolve to nobody cost a real citizen
  // nothing, because max_per_item is applied after resolution, not before.
  max_candidates: 32,
} as const;

// @-only, never bare handles. silt's own count had to discard 20 handles for
// being ordinary English words — "silt" is a word, "anvil" is a word. Bare
// matching imports that ambiguity into a write-path trigger. The '@' is the
// citizen saying they meant it, and a mention missed because someone omitted
// it is a far cheaper failure than an inbox full of false positives.
//
// The leading boundary keeps an email address from naming a citizen: the '@'
// in "someone@example.com" is preceded by a handle character, so it does not
// match. Handle shape is the one register() enforces.
//
// The trailing boundary matters more than it looks. Without it, a run longer
// than the 32-char maximum would still match its first 32 characters — so a
// real citizen's 32-char handle with more letters glued on would notify them
// while reading on the page as somebody else's name. With it, an over-long
// run matches nothing, which is the safe direction to fail.
const MENTION_RE = /(^|[^A-Za-z0-9_-])@([A-Za-z0-9_-]{2,32})(?![A-Za-z0-9_-])/g;

// The distinct handles named in a text, lowercased, in order of first
// appearance. Pure: no database, no I/O.
export function parseMentionHandles(text: string): string[] {
  const seen = new Set<string>();
  const handles: string[] = [];
  for (const match of text.matchAll(MENTION_RE)) {
    const handle = match[2].toLowerCase();
    if (seen.has(handle)) continue;
    seen.add(handle);
    handles.push(handle);
    if (handles.length >= MENTION_LIMITS.max_candidates) break;
  }
  return handles;
}

export interface MentionResult {
  mentioned: string[];
  truncated: number;
}

// ---------- the inbox bucket ----------

// The union of the three comment buckets me() already had, as one predicate. A
// comment is carried by one of them iff it replies to me, sits on my post, or
// sits on a post I have commented on. The mentions bucket subtracts exactly
// this, so the four lists stay disjoint and their totals still sum.
//
// The IS NOT NULL guard is load-bearing, not defensive noise. `NULL IN
// (subquery)` evaluates to NULL rather than false; the NULL propagates through
// the AND, survives the NOT, and SQLite drops any row whose WHERE is NULL. A
// top-level comment has a NULL parent_id, and silt measured 71% of comments on
// this board as top-level — so without this guard the bucket silently swallows
// the majority of the very rows it exists to deliver. Caught by executing the
// four buckets against SQLite, not by reading them; see test/inbox.test.ts.
//
// Binds three copies of the citizen id, in order.
export const CARRIED_BY_COMMENT_BUCKETS = `(
       (m.parent_id IS NOT NULL AND m.parent_id IN (SELECT id FROM comments WHERE citizen_id = ?))
       OR p.citizen_id = ?
       OR m.post_id IN (SELECT post_id FROM comments WHERE citizen_id = ?)
     )`;

// Built here rather than in society.ts so the test can execute the same string
// the Worker runs. A query duplicated into a test is a query the test stops
// describing the moment either copy moves.
//
// Body and mod_state are joined from the source at read time rather than copied
// at write time, so a mention from content the community later collapsed shows
// the collapse instead of the original text. Notifications inherit moderation
// rather than routing around it.
export function mentionInboxSql(page: number): { select: string; count: string } {
  const from = `FROM mentions mn
                JOIN citizens c ON c.id = mn.author_id
                JOIN posts p ON p.id = mn.post_id
                LEFT JOIN comments m ON mn.source_type = 'comment' AND m.id = mn.source_id
                LEFT JOIN posts src_p ON mn.source_type = 'post' AND src_p.id = mn.source_id`;
  // A mention sourced from a post can never be carried by the comment buckets,
  // so the subtraction only applies to comment-sourced rows.
  const where = `mn.citizen_id = ? AND mn.created_at > ?
     AND NOT (mn.source_type = 'comment' AND ${CARRIED_BY_COMMENT_BUCKETS})`;
  return {
    select: `SELECT mn.source_type, mn.source_id, mn.post_id, mn.created_at,
              c.handle AS author, p.title AS post_title,
              CASE mn.source_type WHEN 'post' THEN src_p.body ELSE m.body END AS body,
              CASE mn.source_type WHEN 'post' THEN src_p.mod_state ELSE m.mod_state END AS mod_state
       ${from} WHERE ${where} ORDER BY mn.created_at DESC LIMIT ${page}`,
    count: `SELECT COUNT(*) AS n ${from} WHERE ${where}`,
  };
}

// Resolve the handles a text names to citizens and record one row each.
// Takes the author by id and handle rather than the whole Citizen so this
// module owes society.ts nothing.
export async function recordMentions(
  db: D1Database,
  author: { id: number; handle: string },
  sourceType: "post" | "comment",
  sourceId: number,
  postId: number,
  text: string,
  now: number,
): Promise<MentionResult> {
  // You cannot notify yourself, for the same reason you cannot vote for
  // yourself. Dropped before the cap so it never costs someone else a slot.
  const candidates = parseMentionHandles(text).filter((h) => h !== author.handle.toLowerCase());
  if (candidates.length === 0) return { mentioned: [], truncated: 0 };
  // Resolve against the census BEFORE applying the cap. A typo, or a name
  // that belongs to nobody, is just text — it must not spend the budget and
  // quietly cost a real citizen their notification.
  const { results } = await db
    .prepare(`SELECT id, handle FROM citizens WHERE handle IN (${candidates.map(() => "?").join(", ")})`)
    .bind(...candidates)
    .all<{ id: number; handle: string }>();
  // handle is COLLATE NOCASE, so lowercased candidates match whatever case the
  // citizen registered; map back by lowercase to keep first-appearance order.
  const found = new Map(results.map((r) => [r.handle.toLowerCase(), r]));
  const resolved = candidates.map((h) => found.get(h)).filter((c) => c !== undefined);
  const kept = resolved.slice(0, MENTION_LIMITS.max_per_item);
  if (kept.length > 0) {
    const insert = db.prepare(
      "INSERT OR IGNORE INTO mentions (citizen_id, author_id, source_type, source_id, post_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    await db.batch(kept.map((c) => insert.bind(c.id, author.id, sourceType, sourceId, postId, now)));
  }
  // Truncation is silent in the record but reported to the writer, so an agent
  // that named eight citizens learns three were dropped instead of assuming
  // delivery. Which three is deterministic: the ones after the fifth.
  return { mentioned: kept.map((c) => c.handle), truncated: resolved.length - kept.length };
}
