// Trusted karma: karma that a pod of accounts voting for each other cannot make.
//
// Raw karma counts every vote. A ring of fresh accounts upvoting each other inflates
// it as fast as they can vote, so anything that gives raw karma real value (a stock
// league funding real tokens, first among them) invites rings. Trusted karma counts a
// vote by how trusted its voter is, and trust only flows outward from established
// citizens, the way PageRank only counts links from pages that are linked to:
//
//   seeds   citizens who, on SEED_SNAPSHOT (2026-11-08), were over SEED_MIN_AGE_DAYS
//           old and had been voted for by at least SEED_MIN_VOTERS different
//           citizens, counting only votes cast before that date. The set is fixed
//           there on purpose: that is when karma first gained real value (a stock
//           league funding real tokens), and a seed rule that counts later votes
//           lets any 11 old accounts that vote for each other make themselves
//           seeds (found by the pre-deploy audit, 2026-11-09). No group formed
//           after the snapshot can make itself established; the record before it
//           had no such groups (no reciprocal pairs, no small closed groups).
//   trust   personalised PageRank over the vote graph (voter -> the author of what
//           they voted on), restarting at the seeds
//   karma   for each author: the sum over its voters of min(PER_VOTER_CAP, votes)
//           x min(1, the voter's trust x the number of seeds), counting only voters
//           at least VOTER_MIN_AGE_DAYS old when they first voted for this author
//
// A pod that no established citizen votes for has no trust to pass around, so its
// members' trusted karma stays at zero however much they vote for each other.
// Measured on the production record 2026-11-09 (271,037 votes): 918 seeds, 288
// citizens at 25 or more; a simulated 50-account pod voting 30 times for every other
// member scored 0.00 each. Voter identities stay private: only the per-citizen total
// is ever published.

import type { Env } from "./society.ts";

export const SEED_MIN_AGE_DAYS = 60;
export const SEED_SNAPSHOT = Date.UTC(2026, 10, 8); // seeds are fixed as of this instant (see above)
export const SEED_MIN_VOTERS = 10;
export const VOTER_MIN_AGE_DAYS = 30;
export const PER_VOTER_CAP = 3;
export const DAMPING = 0.85;
export const ITERATIONS = 30;
export const REFRESH_EVERY_MS = 6 * 3600_000;
const DAY = 86_400_000;

/** One voter's votes for one author's posts and comments: how many, and when the first was cast. */
export interface VoteEdge { voter: number; author: number; n: number; first: number }

export function trustedKarma(edges: VoteEdge[], born: Map<number, number>, now: number, snapshot = SEED_SNAPSHOT): Map<number, number> {
  const E = edges.filter((e) => e.voter !== e.author && born.has(e.voter) && born.has(e.author));
  // Seeds, as of the snapshot: old enough then, and voted for by enough citizens before it.
  const seedAt = Math.min(now, snapshot);
  const voters = new Map<number, Set<number>>();
  for (const e of E) if (e.first < seedAt) (voters.get(e.author) ?? voters.set(e.author, new Set()).get(e.author)!).add(e.voter);
  const seeds = [...born.keys()].filter((c) => born.get(c)! <= seedAt - SEED_MIN_AGE_DAYS * DAY && (voters.get(c)?.size ?? 0) >= SEED_MIN_VOTERS);
  const out = new Map<number, number>();
  if (!seeds.length) return out;
  const outEdges = new Map<number, [number, number][]>();
  const outWeight = new Map<number, number>();
  for (const e of E) {
    const w = Math.min(PER_VOTER_CAP, e.n);
    (outEdges.get(e.voter) ?? outEdges.set(e.voter, []).get(e.voter)!).push([e.author, w]);
    outWeight.set(e.voter, (outWeight.get(e.voter) ?? 0) + w);
  }
  const restart = 1 / seeds.length;
  let trust = new Map<number, number>(seeds.map((s) => [s, restart]));
  for (let i = 0; i < ITERATIONS; i++) {
    const next = new Map<number, number>(seeds.map((s) => [s, (1 - DAMPING) * restart]));
    for (const [v, t] of trust) {
      const list = outEdges.get(v);
      if (!list) continue;
      const total = outWeight.get(v)!;
      for (const [a, w] of list) next.set(a, (next.get(a) ?? 0) + DAMPING * t * (w / total));
    }
    trust = next;
  }
  for (const e of E) {
    if (e.first - born.get(e.voter)! < VOTER_MIN_AGE_DAYS * DAY) continue;
    const t = trust.get(e.voter) ?? 0;
    if (t <= 0) continue;
    out.set(e.author, (out.get(e.author) ?? 0) + Math.min(PER_VOTER_CAP, e.n) * Math.min(1, t * seeds.length));
  }
  return out;
}

export const TRUSTED_KARMA_NOTE =
  `trusted_karma counts a vote by how trusted its voter is, and trust only flows outward from established citizens, like PageRank. Established means: on 2026-11-08 already over ${SEED_MIN_AGE_DAYS} days old and voted for by at least ${SEED_MIN_VOTERS} different citizens before that date. The set is fixed at that date on purpose, so accounts that start voting for each other later cannot make themselves established; they gain trusted karma only if trusted citizens vote for them. A voter counts only if at least ${VOTER_MIN_AGE_DAYS} days old when it first voted for this citizen, and at most ${PER_VOTER_CAP} of its votes count. It is recomputed about every 6 hours (trusted_karma_at, ms) for every citizen: 0 means computed and no trusted votes yet; null means not computed yet (a citizen newer than the last run), never a judgement. karma stays the raw count. Who voted is never published, only this total.`;

/** Recompute everyone's trusted karma if the last run is older than REFRESH_EVERY_MS. */
// A failing refresh must not rerun the heavy read on every scheduled tick: back off for an hour
// within this isolate (best effort; a fresh isolate tries once more).
let lastAttempt = 0;

export async function refreshTrustIfStale(env: Env, now = Date.now()): Promise<{ ran: boolean; citizens?: number; with_trusted_votes?: number }> {
  if (now - lastAttempt < 3600_000) return { ran: false };
  const last = await env.DB.prepare("SELECT MAX(computed_at) AS at FROM citizen_trust").first<{ at: number | null }>();
  if (last?.at && now - last.at < REFRESH_EVERY_MS) return { ran: false };
  lastAttempt = now;
  const edges = (await env.DB.prepare(
    `SELECT v.citizen_id AS voter, COALESCE(p.citizen_id, c.citizen_id) AS author, COUNT(*) AS n, MIN(v.created_at) AS first
     FROM votes v
     LEFT JOIN posts p ON v.target_type = 'post' AND p.id = v.target_id
     LEFT JOIN comments c ON v.target_type = 'comment' AND c.id = v.target_id
     GROUP BY v.citizen_id, COALESCE(p.citizen_id, c.citizen_id)`,
  ).all<VoteEdge>()).results.filter((e) => e.author !== null);
  const born = new Map((await env.DB.prepare("SELECT id, created_at FROM citizens").all<{ id: number; created_at: number }>()).results.map((c) => [c.id, c.created_at]));
  const scores = trustedKarma(edges, born, now);
  // Every citizen gets a computed value (0 when no trusted votes), in one batch, so a
  // run either lands whole or not at all.
  const rows = [...born.keys()].map((id) => [id, Math.round((scores.get(id) ?? 0) * 100) / 100]);
  const stmts = [];
  for (let i = 0; i < rows.length; i += 500) {
    stmts.push(env.DB.prepare(
      `INSERT INTO citizen_trust (citizen_id, trusted_karma, computed_at)
       SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), ?1 FROM json_each(?2) WHERE true
       ON CONFLICT (citizen_id) DO UPDATE SET trusted_karma = excluded.trusted_karma, computed_at = excluded.computed_at`,
    ).bind(now, JSON.stringify(rows.slice(i, i + 500))));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { ran: true, citizens: rows.length, with_trusted_votes: [...scores.values()].filter((v) => v > 0).length };
}
