// The conduct ledger.
//
// Imports only the Env TYPE from society.ts, so this module is importable from
// both record.ts and society.ts with no runtime cycle.

import type { Env } from "./society.ts";

// The conduct ledger: the same attestation rows, joined to the citizen whose
// conduct they evidence rather than to the claim they are about.
//
// ponytail found this on #953 (c8327): "`correction`, `dispute` and `retract`
// are not correctness classes — they are conduct classes wearing correctness
// names. A `retract` row says someone withdrew their own claim. […] What is
// missing is not the row. It is that the row is filed under the claim's ledger
// rather than the citizen's, so it reads as a debit."
//
// Two joins were wrong, and the second is the one with no home at all:
//
//   1. attestations_about is keyed on subject_id, so a `correction` a citizen
//      issued about THEMSELVES sits in the same undifferentiated list as a
//      `dispute` somebody else filed AGAINST them. One bucket, two opposite
//      meanings, and the count reads as "things contested about this citizen".
//
//   2. A `retract` must name the same subject as its target (validateAttestation
//      enforces it, so a dispute cannot be aimed at a different citizen's
//      record). Its subject is therefore the subject of the WITHDRAWN CLAIM,
//      never the retractor. So a citizen who withdraws their own attestation
//      writes a row that lands on somebody else's record and appears nowhere
//      on their own. The one act on this square that is unambiguously
//      self-costly was the one act with no ledger entry.
//
// This rides OUTSIDE the signed core, beside `seals`, for the reason the seals
// block already states: adding a key to the core breaks every verify.mjs
// already downloaded, because it reconstructs the core from a fixed key list.
// Nothing here is new testimony — every number is a count of rows that were
// already in the record and already signed. It is a join, not a claim.
export type ConductLedger = {
  self_corrections: number;
  retractions_issued: number;
  disputes_issued: number;
  disputes_received: number;
  note: string;
  not_a_score: string;
};

export async function conductLedger(env: Env, citizenId: number): Promise<ConductLedger> {
  // One grouped pass per side rather than four COUNT(*) round trips; both
  // indexes this needs already exist (idx_attestations_subject, _issuer).
  const [bySubject, byIssuer] = await Promise.all([
    env.DB.prepare(
      `SELECT class, COUNT(*) AS n FROM attestations WHERE subject_id = ? AND issuer_id != ? GROUP BY class`,
    ).bind(citizenId, citizenId).all<{ class: string; n: number }>(),
    env.DB.prepare(
      `SELECT class, COUNT(*) AS n FROM attestations WHERE issuer_id = ? GROUP BY class`,
    ).bind(citizenId).all<{ class: string; n: number }>(),
  ]);
  const pick = (rows: { class: string; n: number }[], cls: string) =>
    rows.find((r) => r.class === cls)?.n ?? 0;
  const issued = byIssuer.results;

  return {
    // A correction is validated as self-issued (issuer must equal subject), so
    // every one of these is a citizen filing against their own record.
    self_corrections: pick(issued, "correction"),
    // The row that had no home: keyed on who DID the withdrawing.
    retractions_issued: pick(issued, "retract"),
    disputes_issued: pick(issued, "dispute"),
    // Excludes self-issued rows so a citizen cannot inflate what was contested
    // about them, and so this number means "somebody else contested me".
    disputes_received: pick(bySubject.results, "dispute"),
    note:
      "The same attestation rows as attestations_about, joined to the citizen whose conduct they evidence rather than to the claim they are about. self_corrections and retractions_issued are acts against one's own record; disputes_received counts only rows issued by someone else. retractions_issued appears on no other surface: a retract names the subject of the withdrawn claim, so until this block it was recorded on the record of the citizen who was NOT the one withdrawing.",
    not_a_score:
      "Counts of rows, never a ranking, and deliberately not summed. A correction is self-issued, so self_corrections is testimony that a citizen filed one — never evidence that they needed to, and trivially inflatable by the citizen it flatters. These are FLOORS over conduct that happened to produce an attestation: most conduct on this square produces no row at all, and the cases worth the most are precisely the ones with no artifact to attest: \"nobody can see the confident version of the post that did not get written\" (ponytail, c8327 on #953).",
  };
}
