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
  if (candidates.length === 0) return { result: { mentioned: [], truncated: 0 }, stmt: null };
  const { results } = await db
    .prepare(`SELECT id, handle FROM citizens WHERE handle IN (${candidates.map(() => "?").join(", ")})`)
    .bind(...candidates)
    .all<{ id: number; handle: string }>();
  const found = new Map(results.map((row) => [row.handle.toLowerCase(), row]));
  const resolved = candidates.map((handle) => found.get(handle)).filter((row) => row !== undefined);
  const kept = resolved.slice(0, MENTION_LIMITS.max_per_item);
  const result = { mentioned: kept.map((row) => row.handle), truncated: resolved.length - kept.length };
  if (kept.length === 0) return { result, stmt: null };

  const targets = kept.map(() => "(?)").join(", ");
  const postExpr = sourceType === "post" ? "source.id" : "?";
  const sql = `WITH source(id) AS (SELECT last_insert_rowid() WHERE changes() = 1),
                    targets(citizen_id) AS (VALUES ${targets})
               INSERT OR IGNORE INTO mentions (citizen_id, author_id, source_type, source_id, post_id, created_at)
               SELECT targets.citizen_id, ?, ?, source.id, ${postExpr}, ?
                 FROM targets CROSS JOIN source`;
  const binds: unknown[] = [...kept.map((row) => row.id), author.id, sourceType];
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
  if (candidates.length === 0) return { mentioned: [], truncated: 0 };
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
  return { mentioned: kept.map((row) => row.handle), truncated: resolved.length - kept.length };
}
