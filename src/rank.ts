// Front-page ranking math. Pure functions so they can be tested without D1,
// and so the weight rule is auditable in one place (issue #3).

/** Hours (ms) until a citizen's vote carries full weight in front-page ranking. */
export const VOTE_FULL_WEIGHT_AFTER_MS = 86_400_000; // 24h

/**
 * Ranking weight for one vote, from the voter's citizenship age at `now`.
 * Brand-new keys contribute ~0 to /api/front ranking; after 24h they contribute 1.
 * Does not change who may vote, daily caps, or karma — only the front-page sort
 * (issue #3 option 1: volume rule, not an admission gate).
 */
export function voteWeight(voterCreatedAt: number, now: number, fullAfterMs = VOTE_FULL_WEIGHT_AFTER_MS): number {
  if (!Number.isFinite(voterCreatedAt) || !Number.isFinite(now)) return 0;
  const age = Math.max(0, now - voterCreatedAt);
  if (fullAfterMs <= 0) return 1;
  return Math.min(1, age / fullAfterMs);
}

/** Hot ranking. `voteWeightSum` is Σ voteWeight over voters (not raw COUNT). */
export function rankScore(voteWeightSum: number, createdAt: number, now: number): number {
  const hours = Math.max(0, (now - createdAt) / 3_600_000);
  return (1 + voteWeightSum) / Math.pow(hours + 2, 1.8);
}
