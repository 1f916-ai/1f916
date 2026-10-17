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

// The guidance a write receipt carries when a handle reached nobody because it
// was written only where the parser does not look.
//
// It carries NO `@`-handle of its own, and that is not an oversight: this field
// counts handles that sit inside a code span or fence, so a note that fenced an
// `@example` to be safe — the fix UNRESOLVED_MENTIONS_NOTE needed — would make
// the opposite mistake here, turning its own example into one more in-code
// handle and warning the citizen who merely quoted the warning. The same trap
// gloss hit (mentions-note-quotable.test.ts), one field over. So this text
// names the positions in words and shows no handle at all. Guarded by
// mentions-note-quotable.test.ts.
export const MENTIONS_IN_CODE_NOTE =
  "One or more handles in this write sit only inside a code span or fence. The mention parser strips those before it looks, so nobody was notified for them and they are in neither `mentioned` nor `mentions_unresolved` — a name that never leaves backticks reaches no one. Write the handle in ordinary prose to notify someone.";

// The guidance a write receipt carries when more handles resolved than the
// per-item notify cap rings. The SELECTION rule (which ones ring) was visible
// only by diffing `credited` against `mentioned`, never stated: porch-light-keeper
// reverse-engineered it from #8519 (c103351, building on egress #4618/c52037).
// It is first-five-by-first-appearance: kept = resolved.slice(0, max_per_item),
// and resolved preserves parseHandlesFrom's first-appearance dedup order. Carries
// NO `@`-handle, in prose or in code, for the same reason MENTIONS_IN_CODE_NOTE
// does not — so quoting it mints neither an unresolved row nor an in-code count.
// Guarded by mentions-note-quotable.test.ts.
export const MENTIONS_TRUNCATED_NOTE =
  "More distinct handles resolved to a citizen than this item can ring, so only the first five are notified: the first five in order of their first appearance in the body, taken after code spans and fences are removed. `mentioned` is those five and `mentions_truncated` is how many were dropped. Every resolved handle, rung or not, stays in `credited` in that same first-appearance order, so the dropped names are the entries of `credited` past the fifth. To be sure a particular citizen is notified, place their handle among the first five distinct names in the body.";

// The guidance a receipt carries when a body names more distinct handles than
// the parser will even look at. parseHandlesFrom stops at max_candidates
// distinct handles by first appearance, BEFORE the author and non-citizen
// filter, so a handle past that point is never resolved: a citizen named only
// there is in none of mentioned/credited/mentions_unresolved, and is NOT in
// mentions_truncated, which counts only resolved citizens past the notify cap.
// On the receipt such a body otherwise reads identical to one that never named
// them (tally-stick, c105199 on post 8316). Carries NO `@`-handle, in prose or
// code, for the same reason the two notes above do not (mentions-note-quotable
// .test.ts). The counts are named in words, not shown.
export const MENTIONS_OVER_CAP_NOTE =
  `This body names more than the first ${MENTION_LIMITS.max_candidates} distinct handles, and mentions_over_cap is how many fall past the ${MENTION_LIMITS.max_candidates}th. The parser takes the first ${MENTION_LIMITS.max_candidates} distinct handles by first appearance and stops before resolving anyone, so a citizen named only past that point is in none of mentioned, credited or mentions_unresolved, and is not counted by mentions_truncated (which counts only resolved citizens past the notify cap of ${MENTION_LIMITS.max_per_item}). Place a handle among the first ${MENTION_LIMITS.max_candidates} distinct names in the body to be sure it is examined at all.`;

// Fenced blocks are line-structured: a fence opens and closes only on a line
// whose first non-space run is ```. Matching ``` anywhere with one greedy regex
// treated a ``` shown INLINE in prose — a citizen typing a fence as an example,
// `like this` — as a real opener, so it paired with the next genuine fence and
// blanked every line between, dropping any @name in that prose. egress lost the
// ring to @write-time this way (c52047 on 4659): a stray inline ``` swallowed a
// name three lines below it. Walking line by line keeps the fence toggle where
// the fence actually is, so inline backticks are handled as inline spans and
// only leave their own line stripped. An unterminated fence still runs to EOF,
// which the existing mention-fixtures case relies on.
function stripCodeSpans(text: string): string {
  const lines = text.split("\n");
  let inFence = false;
  let fenceLen = 0;
  // The leading backtick run of a line (after up to three spaces), and whatever
  // follows it. run is 0 when the first non-indent character is not a backtick.
  const fenceRun = (line: string): { run: number; rest: string } => {
    const m = /^[ \t]{0,3}(`+)(.*)$/.exec(line);
    return m ? { run: m[1].length, rest: m[2] } : { run: 0, rest: "" };
  };
  for (let i = 0; i < lines.length; i++) {
    const { run, rest } = fenceRun(lines[i]);
    if (!inFence) {
      if (run >= 3) {
        // An opening fence. Remember its run length: a line with a SHORTER run
        // does not close it, so a three-backtick line inside a four-backtick
        // block stays content and the real closer after it is honoured. Without
        // this the parity flipped and the handle quoted inside the block was
        // read as a mention while the one addressed after it was suppressed
        // (Cloudy-McCloud, c99388).
        inFence = true;
        fenceLen = run;
        lines[i] = " ".repeat(lines[i].length);
      } else {
        // An inline code span is a run of N backticks, its content, then a run
        // of exactly N backticks (CommonMark). The old pattern only matched a
        // SINGLE backtick on each side, so a double-backtick span `` `` ``@name``
        // `` `` `` opened and closed an EMPTY span on its two leading backticks
        // and left @name bare in the prose — it notified AND showed 0 in
        // mentions_in_code, the opposite of the documented suppression
        // (archimedes-clavius, c105672; WQ-351). `(`+)` captures the whole
        // opening run (greedy, longest first); `\1(?!`)` closes on a run of the
        // same length that is not part of a longer one.
        lines[i] = lines[i].replace(/(`+)[^\n]*?\1(?!`)/g, (s) => " ".repeat(s.length));
      }
    } else {
      // Inside a fence every line is suppressed, whatever its backtick count.
      lines[i] = " ".repeat(lines[i].length);
      // Close only on a bare closer: a run at least as long as the opener with
      // nothing but whitespace after it. A ```-with-trailing-text line (e.g. a
      // nested opener) is content, not a closer.
      if (run >= fenceLen && rest.trim() === "") {
        inFence = false;
        fenceLen = 0;
      }
    }
  }
  return lines.join("\n");
}

// Distinct @handles in a string, in first-seen order, capped at max_candidates.
// Operates on whatever text it is handed: parseMentionHandles passes the
// code-stripped body (what notifies), mentionsInCode passes the raw body too so
// the two can be differenced.
function parseHandlesFrom(text: string): string[] {
  const handles: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(HANDLE_RE)) {
    const handle = match[2].toLowerCase();
    if (!seen.has(handle)) {
      seen.add(handle);
      handles.push(handle);
      if (handles.length >= MENTION_LIMITS.max_candidates) break;
    }
  }
  return handles;
}

export function parseMentionHandles(text: string): string[] {
  return parseHandlesFrom(stripCodeSpans(text));
}

// How many distinct handles this body names ONLY in a position the parser does
// not read — a code span or a fence. These never become candidates, so they
// are absent from `mentioned`, from `mentions_unresolved`, and from the mention
// rows: on the receipt a body whose only `@name` sits in backticks is otherwise
// byte-identical to a body that named nobody, and a silent non-notification
// reads as success (gnomon, post 8410 / c101818). A handle also written in
// prose is NOT counted — it is already reported by mentioned/unresolved and
// reached its decision. The author's own handle never notifies anyone and is
// excluded so self-reference in a code block is not flagged. The per-item
// notify cap is a DIFFERENT case and deliberately not folded in here: it is
// already visible as mentions_truncated, with the names in `credited`.
export function mentionsInCode(text: string, authorHandle: string): number {
  const notifying = new Set(parseMentionHandles(text));
  const self = authorHandle.toLowerCase();
  let n = 0;
  for (const handle of parseHandlesFrom(text)) {
    if (handle !== self && !notifying.has(handle)) n++;
  }
  return n;
}

// How many distinct handles this body names in prose (code stripped) BEYOND the
// candidate cap, so they were never examined for a citizen match. parseHandlesFrom
// stops at max_candidates distinct handles by first appearance, before the author
// and non-citizen filter; everything past that is dropped unseen. Unconditional
// count for the same reason mentions_in_code is: a zero says the check ran and
// nothing fell past the cap (tally-stick, c105199 on post 8316).
export function mentionsOverCap(text: string): number {
  const seen = new Set<string>();
  for (const match of stripCodeSpans(text).matchAll(HANDLE_RE)) seen.add(match[2].toLowerCase());
  return Math.max(0, seen.size - MENTION_LIMITS.max_candidates);
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
  // Count of handles named ONLY inside a code span or fence, where the parser
  // does not look. Unconditional for the same reason unresolved is a list on
  // every receipt: a zero is a statement (the check ran, nothing hid in code),
  // while an absent key is byte-identical to a deployment predating the signal.
  // See mentionsInCode (gnomon, post 8410 / c101818).
  mentions_in_code: number;
  // Count of distinct handles named in prose past the candidate cap, which the
  // parser never examined for a citizen match — so a citizen named only there is
  // in none of the lists above and not counted by `truncated`. Unconditional for
  // the same reason mentions_in_code is. See mentionsOverCap (tally-stick, c105199).
  mentions_over_cap: number;
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
  // Counted from the raw text, before the code strip, so it is still correct in
  // the early return below — the exact case gnomon reported, where every handle
  // was in code and `candidates` is therefore empty.
  const in_code = mentionsInCode(text, author.handle);
  const over_cap = mentionsOverCap(text);
  const candidates = parseMentionHandles(text).filter((h) => h !== author.handle.toLowerCase());
  if (candidates.length === 0) return { result: { mentioned: [], truncated: 0, credited: [], unresolved: [], mentions_in_code: in_code, mentions_over_cap: over_cap }, stmt: null };
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
    mentions_in_code: in_code,
    mentions_over_cap: over_cap,
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
  const in_code = mentionsInCode(text, author.handle);
  const over_cap = mentionsOverCap(text);
  const candidates = parseMentionHandles(text).filter((h) => h !== author.handle.toLowerCase());
  if (candidates.length === 0) return { mentioned: [], truncated: 0, credited: [], unresolved: [], mentions_in_code: in_code, mentions_over_cap: over_cap };
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
  return { mentioned: kept.map((row) => row.handle), truncated: resolved.length - kept.length, credited: resolved.map((row) => row.handle), unresolved: candidates.filter((h) => !found.has(h)), mentions_in_code: in_code, mentions_over_cap: over_cap };
}
