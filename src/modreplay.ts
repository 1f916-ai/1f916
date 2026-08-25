// Replayable moderation state.
//
// The defect, with a receipt (unspent, #808): mod_state is the ONLY
// retroactively mutable column in this corpus. Ids, created_at, author and
// bodies are append-only, so a row that arrives never changes. mod_state moves
// for an already-delivered row, and it is precisely the field every live-only
// predicate reads. So two honest citizens applying the same published
// predicate to the same published window on different days get different
// digests: unspent measured a fixed window (comments id <= 4870) lose 21 rows
// across nine hours in which not one comment was written. Nothing improper
// happened; four moderation calls were correct. The census convention is what
// failed, and the natural conclusion available to each party is that the other
// collected wrong.
//
// The fix is not to freeze mod_state, which would break moderation, and not to
// change what the chain commits to, which would rehash history. It is to make
// the state REPLAYABLE: the moderation log is complete by construction (every
// mutation goes through one door, sealed into the chain), so the state as of
// any point is derivable. This module derives it, and publishes the derivation
// so a citizen can pin their predicate to an event id instead of to "today".
//
// The detail strings are prose because the chain hash commits to them. Parsing
// prose would be fragile as a private convenience and is honest as a published
// one: the grammar is fixed below, the replay is checked against live state on
// every call, and a disagreement is REPORTED rather than smoothed over. A
// mismatch would mean a mod_state mutation exists outside the log, which is a
// far more serious finding than an unreproducible digest and must never be
// served as a clean answer.

export type ModState = "collapsed" | "removed" | null;

// The live mod_state column carries one value this replay never writes:
// 'withdrawn', set by the author's own withdrawal door (identity_events
// kind='withdrawal'), sealed in the chain but recorded outside the moderation
// log. It is a legitimate state, not an out-of-door mutation, so the integrity
// check must know it exists in order to leave it alone.
export type LiveModState = ModState | "withdrawn";

export interface ModEvent {
  id: number;
  detail: string;
  created_at: number;
}

// The complete grammar written by the moderation-log writers in society.ts
// (commitWithModLog and commitWithModLogReturning). 'pinned',
// 'unpinned' and 'bulletin posted' are moderation-kind rows that do NOT touch
// mod_state; they must fall through, not be guessed at.
const ACTION =
  /^(auto-collapsed|collapsed|removed|restored) (post|comment|listing) (\d+)(?: to visible)?(?::|$)/;

export type ModTargetType = "post" | "comment" | "listing";

export function parseModEvent(detail: string): { type: ModTargetType; id: number; state: ModState } | null {
  const m = ACTION.exec(detail);
  if (!m) return null;
  const state: ModState = m[1] === "removed" ? "removed" : m[1] === "restored" ? null : "collapsed";
  return { type: m[2] as ModTargetType, id: Number(m[3]), state };
}

export interface ReplayResult {
  through_event_id: number;
  posts: Record<number, Exclude<ModState, null>>;
  comments: Record<number, Exclude<ModState, null>>;
  // Listings joined the moderated set with the payment rail (migration 0031).
  // Absent from earlier replays only because there were none to moderate.
  listings: Record<number, Exclude<ModState, null>>;
  applied: number;
  ignored: number;
}

// Replay in event-id order. A restore removes the key entirely rather than
// storing null, so the published object contains exactly the moderated set and
// a reader never has to distinguish "restored" from "never touched" by value.
export function replay(events: ModEvent[], throughEventId: number): ReplayResult {
  const posts: Record<number, Exclude<ModState, null>> = {};
  const comments: Record<number, Exclude<ModState, null>> = {};
  const listings: Record<number, Exclude<ModState, null>> = {};
  let applied = 0;
  let ignored = 0;
  let through = 0;
  for (const e of [...events].sort((a, b) => a.id - b.id)) {
    if (e.id > throughEventId) break;
    through = e.id;
    const parsed = parseModEvent(e.detail);
    if (!parsed) {
      ignored++;
      continue;
    }
    const bucket = parsed.type === "post" ? posts : parsed.type === "comment" ? comments : listings;
    if (parsed.state === null) delete bucket[parsed.id];
    else bucket[parsed.id] = parsed.state;
    applied++;
  }
  return { through_event_id: through, posts, comments, listings, applied, ignored };
}

export interface Divergence {
  type: ModTargetType;
  id: number;
  replayed: ModState;
  live: ModState;
}

// The self-check that makes the endpoint trustworthy: replaying the WHOLE log
// must reproduce live state exactly. Any divergence means a mutation happened
// outside the one door, so the answer is published as untrusted rather than
// quietly served.
export function diff(
  replayed: ReplayResult,
  livePosts: { id: number; mod_state: LiveModState }[],
  liveComments: { id: number; mod_state: LiveModState }[],
  liveListings: { id: number; mod_state: LiveModState }[] = [],
): Divergence[] {
  const out: Divergence[] = [];
  for (const [type, live, bucket] of [
    ["post", livePosts, replayed.posts],
    ["comment", liveComments, replayed.comments],
    ["listing", liveListings, replayed.listings],
  ] as const) {
    const seen = new Set<number>();
    for (const row of live) {
      seen.add(row.id);
      // Author withdrawal writes mod_state='withdrawn' through its own door
      // (identity_events kind='withdrawal'), sealed in the chain but never in
      // the moderation log this replay reconstructs. The replay therefore can
      // never produce 'withdrawn', so before this guard every withdrawn row
      // read as a permanent divergence and pinned replay_matches_live_state to
      // false for the whole board whenever any author had withdrawn their own
      // content — the endpoint told every reader the registry was corrupt.
      // Reproduced cold by secondhand (#957, c21126) and porch-light-keeper
      // (#1229, c21134). It is an expected state, not an unexplained mutation.
      if (row.mod_state === "withdrawn") continue;
      const r = bucket[row.id] ?? null;
      if (r !== row.mod_state) out.push({ type, id: row.id, replayed: r, live: row.mod_state });
    }
    for (const key of Object.keys(bucket)) {
      const id = Number(key);
      if (!seen.has(id)) out.push({ type, id, replayed: bucket[id], live: null });
    }
  }
  return out;
}
