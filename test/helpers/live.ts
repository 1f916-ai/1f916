// Live probes, separated from the deterministic suite.
//
// Issue #151. `npm test` used to run both the source tests and every probe
// against the deployed production service in one command, so a pull request's
// result depended on network availability, on the edge rate limiter, and on
// what had been deployed that hour. Three things went wrong with that on
// 2026-08-26 alone:
//
//   1. A PR that changed only README.md and added a test reading the tree
//      (#152) went red on one Node version with `fetch failed` inside
//      test/ledger-tx-migration.test.ts. Nothing in that diff opens a socket.
//      (Corrected 2026-08-26: this first said "documentation-only", which is
//      checkably wrong. The PR added test/readme-paths.test.ts as well.)
//   2. Running the suite repeatedly while working through the queue tripped
//      the 120-requests-per-minute limit, and twelve live probes turned into
//      SKIPS. The run still reported `fail 0`, so a green tally meant "the
//      contract was checked" and "the contract was not checked at all" with no
//      way to tell them apart from the summary line.
//   3. A fork PR (#147) went red on a live probe because a fork build runs a
//      merge commit against a stale base, so the checked-out schema predated
//      an event kind the live site had begun serving.
//
// The split: `npm test` is deterministic and offline. `npm run test:live`
// runs the probes. `npm run test:all` runs both. CI runs them as two steps so
// a red source suite and a red probe are never the same signal.
//
// And when the probes DO run, a rate limit is a failure rather than a skip.
// Skipping on 429 is what let a fully rate-limited run report green; the whole
// point of the probe is to have checked, so "I could not check" must not look
// like "I checked".

export const LIVE_PROBES = process.env.LIVE_PROBES === "1";

// Why an env var rather than a separate directory: these probes and the
// schemas they read belong beside each other, and a probe that lives far from
// its contract is a probe nobody updates when the contract moves.
export const LIVE_SKIP_REASON =
  "live probes are off; run `npm run test:live` (or LIVE_PROBES=1 npm test) to check the deployment";

export class RateLimited extends Error {}

// A 400 is not unreachability. The deployment answered, read the request, and
// refused it — which means the PROBE is malformed, not the service missing.
// Both used to land in the same catch and skip with "API unreachable", so a
// probe whose path the API rejects stages itself off forever and reports the
// same line as a probe that could not open a socket. That is the exact defect
// this file's header names one level up ("I could not check" must not look
// like "I checked"), and it fired the first time it was given the chance:
// a /api/events?citizen= probe added with a 36-character handle drew
// `not in the accepted handle class [A-Za-z0-9_-]{2,32}` and skipped green.
//
// Only 400. A 404 or a 5xx may honestly mean the route is not deployed yet,
// which is what the deployment-marker staging exists for, so those keep
// skipping and this stays the narrow case it was written for.
export class ProbeRefused extends Error {}

// One retry, then fail. The limiter's window is ten seconds, so a single wait
// clears an incidental collision with another reader; a second 429 means the
// probe genuinely cannot see the deployment and must say so out loud.
export async function liveFetch(url: string, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(url, init);
    if (r.status !== 429) return r;
    if (attempt === 0) await new Promise((done) => setTimeout(done, 11_000));
  }
  throw new RateLimited(
    `${url} -> 429 twice. The probe did not run, which is not the same as passing. ` +
      `Re-run when the per-IP limit has cleared rather than reading this as green.`,
  );
}
