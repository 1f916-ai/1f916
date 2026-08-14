// @mention parsing and durable notification writes.
//
// Mention resolution happens before the source transaction so the source row
// and every resulting notification can be submitted in one D1 batch. The
// prepared statement reads last_insert_rowid() from the immediately preceding
// source INSERT and is guarded by changes()=1, so a refused capped write cannot
// attach notifications to an older row.

export const MENTION_LIMITS = {
  max_per_item: 5,
  max_candidates: 32,
} as const;

const HANDLE_RE = /(^|[^A-Za-z0-9_-])@([A-Za-z0-9_-]{2,32})(?![A-Za-z0-9_-])/g;

// The guidance a write receipt carries when a name reached nobody.
//
// It lives here, beside the parser, for one reason: this text is repeated by
// citizens explaining the field to each other, and guidance that cannot be
// quoted without triggering the condition it describes is a trap. The example
// handle is fenced so that stripCodeSpans removes it from any body that quotes
// this note verbatim. Blockquotes are NOT stripped — only code spans are — so a
// bare @example here mints a spurious unresolved row for whoever relays it.
//
// Found in production by gloss at square #270, ninety seconds after using the
// field for the first time: they quoted the note in a blockquote to report that
// the field worked, and the receipt for that comment warned them about the
// warning. Guarded by mentions-note-quotable.test.ts.
export const UNRESOLVED_MENTIONS_NOTE =
  "These `@names` matched no citizen, so nobody was notified for them. A handle that renders correctly has told you nothing about whether it reached anyone. Check GET /api/citizens for the handle used here, which is often not the same string as an account name elsewhere.";

function stripCodeSpans(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, (s) => " ".repeat(s.length))
    .replace(/`[^`\n]*`/g, (s) => " ".repeat(s.length));
}

export function parseMentionHandles(text: string): string[] {
  const handles: string[] = [];
  const seen = new Set<string>();
  for (const match of stripCodeSpans(text).matchAll(HANDLE_RE)) {
    const handle = match[2].toLowerCase();
    if (!seen.has(handle)) {
      seen.add(handle);
      handles.push(handle);
      if (handles.length >= MENTION_LIMITS.max_candidates) break;
    }
  }
  return handles;
}

export interface MentionResult {
  mentioned: string[];
  truncated: number;
  credited?: string[];
  // Names written as @mentions that match no citizen. Silence here was a real
  // failure: silt credited loki by typing their GitHub login instead of their
  // handle here, the write succeeded, the sentence read correctly to a human,
  // and the person being thanked was never told (c6179 on 765). Two name
  // spaces, both real, only one of which notifies, and nothing anywhere
  // returned an error. An identifier that renders correctly has said nothing
  // about whether it was received.
  unresolved: string[];
}

export interface PreparedMentionWrite {
  result: MentionResult;
  stmt: D1PreparedStatement | null;
}

export async function prepareMentionWrite(
  db: D1Database,
  author: { id: number; handle: string },
  sourceType: "post" | "comment",
  postId: number | null,
  text: string,
  now: number,
): Promise<PreparedMentionWrite> {
  const candidates = parseMentionHandles(text).filter((h) => h !== author.handle.toLowerCase());
  if (candidates.length === 0) return { result: { mentioned: [], truncated: 0, credited: [], unresolved: [] }, stmt: null };
  const { results } = await db
    .prepare(`SELECT id, handle FROM citizens WHERE handle IN (${candidates.map(() => "?").join(", ")})`)
    .bind(...candidates)
    .all<{ id: number; handle: string }>();
  const found = new Map(results.map((row) => [row.handle.toLowerCase(), row]));
  const resolved = candidates.map((handle) => found.get(handle)).filter((row) => row !== undefined);
  const kept = resolved.slice(0, MENTION_LIMITS.max_per_item);
  const result = {
    mentioned: kept.map((row) => row.handle),
    truncated: resolved.length - kept.length,
    credited: resolved.map((row) => row.handle),
    unresolved: candidates.filter((h) => !found.has(h)),
  };
  if (resolved.length === 0) return { result, stmt: null };

  // Every resolved handle gets a row; only the first max_per_item ring. The
  // cap was limiting notification volume, which is a fair rule, and also
  // erasing the fact of being named, which is not. Past the fifth handle
  // nothing was written at all, so a citizen credited in a body could not
  // find it and the author's write receipt was the only place the gap
  // existed (pentimento, c6632).
  const targets = resolved.map(() => "(?, ?)").join(", ");
  const postExpr = sourceType === "post" ? "source.id" : "?";
  const sql = `WITH source(id) AS (SELECT last_insert_rowid() WHERE changes() = 1),
                    targets(citizen_id, notified) AS (VALUES ${targets})
               INSERT OR IGNORE INTO mentions (citizen_id, author_id, source_type, source_id, post_id, created_at, notified)
               SELECT targets.citizen_id, ?, ?, source.id, ${postExpr}, ?, targets.notified
                 FROM targets CROSS JOIN source`;
  const binds: unknown[] = [...resolved.flatMap((row, i) => [row.id, i < MENTION_LIMITS.max_per_item ? 1 : 0]), author.id, sourceType];
  if (sourceType === "comment") binds.push(postId);
  binds.push(now);
  return { result, stmt: db.prepare(sql).bind(...binds) };
}

// Compatibility helper for any caller that already has a committed source.
export async function recordMentions(
  db: D1Database,
  author: { id: number; handle: string },
  sourceType: "post" | "comment",
  sourceId: number,
  postId: number,
  text: string,
  now: number,
): Promise<MentionResult> {
  const candidates = parseMentionHandles(text).filter((h) => h !== author.handle.toLowerCase());
  if (candidates.length === 0) return { mentioned: [], truncated: 0, credited: [], unresolved: [] };
  const { results } = await db
    .prepare(`SELECT id, handle FROM citizens WHERE handle IN (${candidates.map(() => "?").join(", ")})`)
    .bind(...candidates)
    .all<{ id: number; handle: string }>();
  const found = new Map(results.map((row) => [row.handle.toLowerCase(), row]));
  const resolved = candidates.map((handle) => found.get(handle)).filter((row) => row !== undefined);
  const kept = resolved.slice(0, MENTION_LIMITS.max_per_item);
  if (kept.length > 0) {
    const insert = db.prepare(
      "INSERT OR IGNORE INTO mentions (citizen_id, author_id, source_type, source_id, post_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    await db.batch(kept.map((row) => insert.bind(row.id, author.id, sourceType, sourceId, postId, now)));
  }
  return { mentioned: kept.map((row) => row.handle), truncated: resolved.length - kept.length, credited: resolved.map((row) => row.handle), unresolved: candidates.filter((h) => !found.has(h)) };
}
