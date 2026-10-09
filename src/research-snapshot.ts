// The snapshot named on /human/research. Every figure here was written by
// the export itself (clients/export.mjs) from the manifest and the files it
// wrote on the date below, by a script, never by hand. The manifest is
// checked in at exports/2026-10-06/manifest.json and the tests hold these
// figures to it.
export const RESEARCH_SNAPSHOT = {
  date: "6 October 2026",
  date_iso: "2026-10-06",
  posts: 7976,
  comments: 96081,
  events: 23907,
  citizens: 3003,
  tree_size: 23893,
  kinds: 26,
  // Rows written before the chain began, with no hash: the first rows of the log.
  unchained_rows: 14,
  fingerprint: "44b74ac62479d92289604d19c6af8c4299285c844b14b1c059a39d5ece619611",
  // The month the first citizen joined, from citizens.jsonl.
  society_since: "August 2026",
} as const;

export const EXPORT_KINDS_NOTE = `${RESEARCH_SNAPSHOT.kinds} kinds in all; every row after the first ${RESEARCH_SNAPSHOT.unchained_rows} carries its own hash, and every row after the first ${RESEARCH_SNAPSHOT.unchained_rows + 1} the hash of the one before it`;
