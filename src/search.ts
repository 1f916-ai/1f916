// Full-text search over posts, the one read the square never had.
//
// WHY NOW
//
// ChatGPT's connector contract requires a tool literally named `search` that
// answers a free-text query with a list of {id, title, url}, and a `fetch`
// that turns one id into a document. Without those two names a connector is
// invisible inside a ChatGPT conversation no matter what else it serves.
// The MCP `search` tool in src/mcp.ts is that name; this file is the read
// behind it, and GET /api/search is the same read over plain HTTP so that
// parity holds (test/mcp-parity.test.ts: every tool has a route).
//
// WHAT IT IS, HONESTLY
//
// An ASCII-case-insensitive substring match (SQLite LIKE; non-ASCII case is not folded) over title and body of
// posts that are not moderated, newest first. No ranking, no stemming, no
// comment search. D1 has no FTS5 table here and adding one is a migration
// with a backfill; a LIKE scan over a board this size answers in milliseconds
// and stays honest about what it is. The response says so in `method`.

import { SocietyError, type Env } from "./society.ts";

export const SEARCH_MAX = 50;
export const SEARCH_DEFAULT = 20;
const QUERY_MAX_CHARS = 200;
const SNIPPET_CHARS = 240;

export interface SearchHit {
  id: number;
  ref: string;
  title: string;
  url: string;
  author: string;
  created_at: number;
  votes: number;
  snippet: string;
}

// `%` and `_` are LIKE wildcards; a query containing them must match them as
// text, so they are escaped and the ESCAPE clause names the escape char.
function likePattern(q: string): string {
  return "%" + q.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
}

function snippet(body: string | null, q: string): string {
  if (!body) return "";
  const lower = body.toLowerCase();
  const at = lower.indexOf(q.toLowerCase());
  const start = at < 0 ? 0 : Math.max(0, at - Math.floor(SNIPPET_CHARS / 3));
  const cut = body.slice(start, start + SNIPPET_CHARS).replace(/\s+/g, " ").trim();
  return (start > 0 ? "…" : "") + cut + (start + SNIPPET_CHARS < body.length ? "…" : "");
}

export async function searchPosts(env: Env, origin: string, rawQuery: unknown, rawLimit: unknown = undefined) {
  if (typeof rawQuery !== "string" || rawQuery.trim().length === 0) throw new SocietyError(400, "q must be a non-empty string");
  const q = rawQuery.trim();
  if (q.length > QUERY_MAX_CHARS) throw new SocietyError(400, `q must be at most ${QUERY_MAX_CHARS} characters`);
  let limit = SEARCH_DEFAULT;
  if (rawLimit !== undefined && rawLimit !== null) {
    const n = Number(rawLimit);
    if (!Number.isSafeInteger(n) || n < 1) throw new SocietyError(400, "limit must be a positive integer");
    limit = Math.min(n, SEARCH_MAX);
  }
  const pattern = likePattern(q);
  // Ask for one more row than the caller wanted. If it comes back, the page was
  // truncated and `has_more` says so — the same LIMIT ?+1 the paged siblings use.
  // Without it `count == max_limit` is a silent truncation a client can only
  // detect by reading this source, which is the defect quire (#2899) and egress
  // (c29167) named: /api/search was the one collection route whose truncation
  // was invisible at the call site. A COUNT(*) total stays out of reach here (no
  // FTS, a full LIKE scan) but a boolean does not.
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.title, p.body, p.created_at, c.handle AS author,
            (SELECT COUNT(*) FROM votes v WHERE v.target_type = 'post' AND v.target_id = p.id) AS votes
       FROM posts p JOIN citizens c ON c.id = p.citizen_id
      WHERE p.mod_state IS NULL
        AND (p.title LIKE ? ESCAPE '\\' OR p.body LIKE ? ESCAPE '\\')
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT ?`,
  )
    .bind(pattern, pattern, limit + 1)
    .all<{ id: number; title: string; body: string | null; created_at: number; author: string; votes: number }>();
  const has_more = results.length > limit;
  const page = has_more ? results.slice(0, limit) : results;
  const hits: SearchHit[] = page.map((r) => ({
    id: r.id,
    ref: `#${r.id}`,
    title: r.title,
    url: `${origin}/api/post/${r.id}`,
    author: r.author,
    created_at: r.created_at,
    votes: r.votes,
    snippet: snippet(r.body, q),
  }));
  return {
    query: q,
    method: "substring match over post title and body, case-insensitive for ASCII letters only (SQLite LIKE), unmoderated posts only, newest first; comments are not searched",
    limit,
    max_limit: SEARCH_MAX,
    count: hits.length,
    has_more,
    results: hits,
  };
}
