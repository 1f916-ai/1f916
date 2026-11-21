// Rail throughput: a read-only census of how work moves, derived from the same
// records GET /api/rail already walks (listings, submissions, awards, receipts).
// Inspired by identity.md's public activity view; this reports time to pay,
// acceptance, open and overdue counts, and jobs per UTC ISO week, and does not
// copy token-gated seats or fees.
//
// Pure: given rows, it returns figures and the derivation of each one. The
// caller (railCensus) supplies the rows; this file does not touch the database.

export const RAIL_THROUGHPUT_NOTE =
  "HOW WORK MOVES, derived from the same listings, submissions, awards and receipts as the rest of this page, never from a second set of books. time_to_pay is how long paid awards took, in milliseconds, from award to payment and from submission to payment; a sample of size zero yields nulls rather than a zero that would look like instant payment. acceptance_rate is society-wide and uses the same scored-listing rule as each funder's award_rate: awarded-ended listings divided by ended-with-scored-submissions listings, across the three settlement-mode groups that partition the rail (requester, delegated, escrow), summing the COUNTS and never the rates. open and overdue are the current stock. jobs_per_week is a UTC ISO-week histogram of listings posted, submissions handed in, awards made and awards paid. Nothing here moves money, and a low rate is a fact about what happened, never a verdict on the work.";

export function percentile(sortedNonEmpty: readonly number[], p: number): number {
  if (sortedNonEmpty.length === 0) throw new Error("percentile of an empty sample is not a number");
  if (p <= 0) return sortedNonEmpty[0]!;
  if (p >= 1) return sortedNonEmpty[sortedNonEmpty.length - 1]!;
  const idx = (sortedNonEmpty.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedNonEmpty[lo]!;
  return sortedNonEmpty[lo]! + (sortedNonEmpty[hi]! - sortedNonEmpty[lo]!) * (idx - lo);
}

export function summarizeDurations(values: readonly number[]): {
  n: number;
  min_ms: number | null;
  median_ms: number | null;
  p90_ms: number | null;
  mean_ms: number | null;
  max_ms: number | null;
} {
  if (values.length === 0) {
    return { n: 0, min_ms: null, median_ms: null, p90_ms: null, mean_ms: null, max_ms: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    min_ms: sorted[0]!,
    median_ms: percentile(sorted, 0.5),
    p90_ms: percentile(sorted, 0.9),
    mean_ms: sum / sorted.length,
    max_ms: sorted[sorted.length - 1]!,
  };
}

// ISO week in UTC, Monday 00:00 UTC as the week start. The week label is
// YYYY-Www, the year being the ISO week-year (the year of that week's Thursday).
export function isoWeekUtc(ms: number): { week: string; start_ms: number; year: number; week_number: number } {
  const dayMs = 86_400_000;
  const date = new Date(ms);
  const day = date.getUTCDay() || 7; // Mon=1 ... Sun=7
  const thursday = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + (4 - day));
  const year = new Date(thursday).getUTCFullYear();
  const jan4 = Date.UTC(year, 0, 4);
  const jan4Day = new Date(jan4).getUTCDay() || 7;
  const week1Monday = jan4 - (jan4Day - 1) * dayMs;
  const weekNumber = 1 + Math.round((thursday - 3 * dayMs - week1Monday) / (7 * dayMs));
  const start_ms = thursday - 3 * dayMs;
  return { week: `${year}-W${String(weekNumber).padStart(2, "0")}`, start_ms, year, week_number: weekNumber };
}

export type ThroughputAward = {
  listing_id: number;
  submission_id: number;
  state: string;
  awarded_at: number;
  paid_at: number | null;
  overdue_at: number | null;
};
export type ThroughputSubmission = { id: number; listing_id: number; created_at: number };
export type ThroughputListing = { id: number; created_at: number };
export type ThroughputReceipt = { created_at: number };

export type WeekBucket = {
  week: string;
  start_ms: number;
  end_ms: number;
  listings_posted: number;
  submissions: number;
  awards: number;
  awards_paid: number;
  receipts: number;
};

export type RailThroughput = {
  time_to_pay: {
    award_to_paid: ReturnType<typeof summarizeDurations>;
    submission_to_paid: ReturnType<typeof summarizeDurations>;
    derivation: string;
  };
  acceptance: {
    listings_ended_with_scored_submissions: number;
    listings_ended_with_scored_submissions_awarded: number;
    rate: number | null;
    derivation: string;
  };
  open: number;
  overdue: {
    awards: number;
    derivation: string;
  };
  jobs_per_week: {
    weeks: WeekBucket[];
    all_time: Omit<WeekBucket, "week" | "start_ms" | "end_ms">;
    derivation: string;
  };
  note: string;
};

export function railThroughput(input: {
  now: number;
  open: number;
  overdueAwards: number;
  listings: readonly ThroughputListing[];
  submissions: readonly ThroughputSubmission[];
  awards: readonly ThroughputAward[];
  receipts: readonly ThroughputReceipt[];
  acceptanceEnded: number;
  acceptanceAwarded: number;
}): RailThroughput {
  const submissionsById = new Map(input.submissions.map((s) => [s.id, s]));
  const awardToPaid: number[] = [];
  const submissionToPaid: number[] = [];
  for (const a of input.awards) {
    if (a.state !== "paid" || a.paid_at === null) continue;
    const awardLag = a.paid_at - a.awarded_at;
    if (awardLag >= 0) awardToPaid.push(awardLag);
    const sub = submissionsById.get(a.submission_id);
    if (sub) {
      const subLag = a.paid_at - sub.created_at;
      if (subLag >= 0) submissionToPaid.push(subLag);
    }
  }

  const buckets = new Map<string, WeekBucket>();
  const ensure = (ms: number): WeekBucket => {
    const { week, start_ms } = isoWeekUtc(ms);
    let b = buckets.get(week);
    if (!b) {
      b = { week, start_ms, end_ms: start_ms + 7 * 86_400_000, listings_posted: 0, submissions: 0, awards: 0, awards_paid: 0, receipts: 0 };
      buckets.set(week, b);
    }
    return b;
  };
  for (const l of input.listings) ensure(l.created_at).listings_posted++;
  for (const s of input.submissions) ensure(s.created_at).submissions++;
  for (const a of input.awards) {
    ensure(a.awarded_at).awards++;
    if (a.state === "paid" && a.paid_at !== null) ensure(a.paid_at).awards_paid++;
  }
  for (const r of input.receipts) ensure(r.created_at).receipts++;

  const weeks = [...buckets.values()].sort((a, b) => a.start_ms - b.start_ms);
  const all_time = weeks.reduce(
    (acc, w) => ({
      listings_posted: acc.listings_posted + w.listings_posted,
      submissions: acc.submissions + w.submissions,
      awards: acc.awards + w.awards,
      awards_paid: acc.awards_paid + w.awards_paid,
      receipts: acc.receipts + w.receipts,
    }),
    { listings_posted: 0, submissions: 0, awards: 0, awards_paid: 0, receipts: 0 },
  );

  const ended = input.acceptanceEnded;
  const awarded = input.acceptanceAwarded;
  return {
    time_to_pay: {
      award_to_paid: summarizeDurations(awardToPaid),
      submission_to_paid: summarizeDurations(submissionToPaid),
      derivation:
        "award_to_paid: paid_at minus awarded_at, over award rows in state paid whose paid_at is at or after awarded_at. submission_to_paid: paid_at minus the awarded submission's created_at, over the same rows that join a submission, similarly non-negative. Both timestamps are milliseconds since epoch, and so is every figure here. Median is the middle value of the sorted sample when n is odd, and the mean of the two central values when n is even (linear interpolation at percentile 0.5). p90 is the same interpolation at 0.9. mean is the arithmetic mean. n is the sample size. An empty sample yields nulls, never a zero, because a zero would read as instant payment of work that was never paid. Awards that are not paid do not enter either sample.",
    },
    acceptance: {
      listings_ended_with_scored_submissions: ended,
      listings_ended_with_scored_submissions_awarded: awarded,
      rate: ended === 0 ? null : awarded / ended,
      derivation:
        "The society-wide form of each funder's award_rate, using the same scored-listing rule published under derivations.award_rate. The three settlement-mode groups (requester, delegated, escrow) PARTITION ended listings, so this figure sums the COUNTS across those groups and across funders, and never sums the rates. rate is awarded divided by ended, as a plain number, and null when ended is 0, because 0 of 0 is no rate. Moderated listings are excluded, as they are on each funder row: this society stopped them, not their funder.",
    },
    open: input.open,
    overdue: {
      awards: input.overdueAwards,
      derivation:
        "The number of award rows currently in state overdue_unpaid, rail-wide. It is a count of rows, not an amount of money; the money behind those rows is v2_overdue_unpaid_atomic on liability_by_asset and on each funder's row, in the asset each listing prices in.",
    },
    jobs_per_week: {
      weeks,
      all_time,
      derivation:
        "One bucket per UTC ISO week (Monday 00:00 UTC to the next Monday, labelled YYYY-Www, the year being the ISO week-year). listings_posted counts listings by created_at; submissions by created_at; awards by awarded_at, in any state; awards_paid by paid_at on rows in state paid; receipts by payout_receipts.created_at. A week with no activity is omitted rather than served as a row of zeros, so a gap in the weeks array is a quiet week, not a missing record. all_time is the sum of every bucket, which is every listing, submission, award and receipt in the census.",
    },
    note: RAIL_THROUGHPUT_NOTE,
  };
}
