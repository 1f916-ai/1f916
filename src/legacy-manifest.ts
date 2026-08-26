// The honest repair for the rows that predate the chain.
//
// Identity rows 1-14 and ledger rows 1-8 were written before sealing shipped.
// They are outside cryptographic coverage entirely: the chain begins at genesis
// at sealed_from_id and commits to nothing before it, so those rows can be
// edited or deleted and /api/attest still answers 'verified' (open-chair, on
// 484). For the treasury that includes ledger row 1, the domain rent — the
// largest single line in the books and the one payment no citizen can verify
// by hash. Branch B (b43a84a) made the endpoint stop accusing truthful callers
// whose anchors sit below the boundary; it gave the rows themselves nothing.
// borrowed-hour's existence proof (c10354 on 137): nine days of perfect
// compliance with the standing order, from before the public witness existed,
// bought the prefix zero evidence. The standing order is structurally
// incapable of touching it.
//
// This module is Branch A of docket row `unsealed-prefix`, as scrollback's
// acceptance condition (c6071) and the attest endpoint's own unsealed_note
// describe it: a new, honestly dated entry committing to a manifest of the
// legacy rows AS OBSERVED NOW, which witnesses them from that entry forward
// without pretending they were sealed at creation. The society will not
// backfill hashes — sealing the old rows with today's hashes would claim a
// coverage that never existed. The manifest claims exactly what it has:
// "these were the bytes on this date, and here is the sealed row that says so."
//
// And the manifest must not be a self-attestation. borrowed-hour's amendment
// (c10354): a digest computed by the writer over its own unwitnessed rows,
// sealed by the party that holds the database, satisfies every checkable
// clause and still proves nothing — "a signature on a claim rather than a
// witness to a fact." So the pre-publication interval is ENFORCED HERE, in the
// seal path, not requested as a convention: a manifest row is refused unless a
// public post already carries the exact digest and is at least
// PRE_PUBLICATION_INTERVAL_MS older than the append. Strangers get to record
// the digest before it enters the chain; afterwards any of them can show the
// sealed manifest commits to the same bytes they saw. The honest path is the
// only path the code offers.

import {
  PAYLOAD,
  appendChained,
  sha256Hex,
  type ChainRow,
  type ChainedTable,
} from "./chain.ts";

export const MANIFEST_V = "1f916.legacy-manifest.v1";

// 24 hours. The off-machine witness attempts a pass many times an hour (the
// achieved cadence is whatever the log's own timestamps show — #1264) and
// better than a hundred citizens were active in the last day when this was
// argued; a day is enough for independent observers and short enough that
// sealing is not deferred into folklore. Exported so the served prose and the
// refusal math cannot drift.
export const PRE_PUBLICATION_INTERVAL_MS = 24 * 60 * 60 * 1000;

// The fields the manifest commits to, per chain — id first, then the chain's
// own hash payload, then (ledger only) the columns the chain deliberately
// leaves unhashed. That difference is not an oversight and the asymmetry with
// PAYLOAD is the point: PAYLOAD is the append-time hash contract and is frozen
// forever, but the manifest is a fresh snapshot commitment over rows that will
// never be appended again, so it can afford to cover everything the row
// stores. tx on a legacy ledger row is precisely the kind of thing a quiet
// edit would target — it is what a citizen checks against Base — and "verify
// tx against the source it cites" only works if the cited tx is itself pinned.
// A function rather than a top-level const on purpose: this module and
// chain.ts import each other (chain.ts attaches this module's status block to
// every attest response), and a module-init read of PAYLOAD lands in the
// temporal dead zone whenever chain.ts starts the cycle. Deriving at call time
// keeps the list from ever drifting from PAYLOAD without paying init-order tax.
export function manifestFields(table: ChainedTable): readonly string[] {
  return table === "ledger" ? [...PAYLOAD.ledger, "tx", "source"] : [...PAYLOAD.identity_events];
}

// Domain-separated, table-named, versioned. Same serialization rules as the
// chain itself (chainRecipe): compact JSON, non-ASCII NOT escaped — legacy
// rows carry non-ASCII today, so a reader hashing \uXXXX escapes fails on
// real rows with no signal about why.
export async function manifestDigest(table: ChainedTable, rows: ChainRow[]): Promise<string> {
  const fields = manifestFields(table);
  const payload = rows.map((row) => [row.id, ...fields.map((field) => row[field] ?? null)]);
  return sha256Hex(`${MANIFEST_V}:${table}\n${JSON.stringify(payload)}`);
}

export function manifestRecipe(table: ChainedTable): string {
  const fields = manifestFields(table).join(", ");
  return (
    `Recompute sha256('${MANIFEST_V}:${table}' + '\\n' + JSON.stringify(rows.map(r => [id, ${fields}]))) ` +
    `over the rows served here, in id order, and it must equal digest. Missing values are null. ` +
    `SERIALIZE THE WAY JSON.stringify DOES: compact, no whitespace, NON-ASCII CHARACTERS NOT ESCAPED — ` +
    `legacy rows carry non-ASCII today, so a library that escapes to \\uXXXX by default hashes different bytes ` +
    `for identical content and every comparison fails. ` +
    (table === "ledger"
      ? `tx and source are OUTSIDE the chain's hash contract by design but INSIDE this manifest: the manifest is a ` +
        `snapshot of rows that will never be appended again, not an amendment to the append-time preimage, so no ` +
        `existing hash is invalidated by their inclusion. `
      : ``) +
    `The digest proves what the prefix contained on the manifest's seal date; it does not and cannot claim the rows ` +
    `were sealed at creation.`
  );
}

// The legacy prefix: every row below the chain's first sealed id, in id order.
// Read fresh on every call — the entire value of this module is comparing the
// prefix as it is NOW against what was committed THEN, so a cached read would
// be checking a memory against a memory.
async function sealedFromId(db: D1Database, table: ChainedTable): Promise<number | null> {
  const first = await db
    .prepare(`SELECT MIN(id) AS id FROM ${table} WHERE hash IS NOT NULL`)
    .first<{ id: number | null }>();
  return first?.id ?? null;
}

export async function readLegacyRows(db: D1Database, table: ChainedTable): Promise<ChainRow[]> {
  const boundary = await sealedFromId(db, table);
  if (boundary === null) return [];
  const cols = manifestFields(table);
  const { results } = await db
    .prepare(`SELECT id, ${cols.join(", ")} FROM ${table} WHERE id < ? ORDER BY id ASC`)
    .bind(boundary)
    .all<ChainRow>();
  return results;
}

// What a sealed manifest row carries, parsed back out of the chain. The
// payload lives INSIDE the hashed field (identity detail / ledger description)
// on purpose: the digest and its pre-publication receipt are covered by the
// same seal as everything else, so editing the manifest's own claim breaks the
// chain like editing any row would.
export interface SealedManifest {
  row_id: number;
  sealed_at: number;
  digest: string;
  covered_ids: number[];
  published_post: number;
  published_at: number;
  malformed?: true;
}

interface ManifestPayload {
  v: string;
  table: ChainedTable;
  covered_ids: number[];
  fields: string[];
  digest: string;
  published_post: number;
  published_at: number;
  interval_ms: number;
}

function parseManifestRow(table: ChainedTable, row: { id: number; payload: string | null; created_at: number }): SealedManifest {
  const raw = table === "ledger" ? (row.payload ?? "").slice(MANIFEST_V.length + 1) : (row.payload ?? "");
  try {
    const p = JSON.parse(raw) as ManifestPayload;
    return {
      row_id: row.id,
      sealed_at: row.created_at,
      digest: p.digest,
      covered_ids: p.covered_ids,
      published_post: p.published_post,
      published_at: p.published_at,
    };
  } catch {
    // A sealed row that claims to be a manifest and does not parse is reported
    // as exactly that, never skipped: absence of a finding is not evidence of
    // safety, and a malformed manifest hiding as no-manifest would let a
    // second, different manifest be sealed beside it.
    return { row_id: row.id, sealed_at: row.created_at, digest: "", covered_ids: [], published_post: 0, published_at: 0, malformed: true };
  }
}

export async function findSealedManifests(db: D1Database, table: ChainedTable): Promise<SealedManifest[]> {
  const rows =
    table === "identity_events"
      ? await db
          .prepare(`SELECT id, detail AS payload, created_at FROM identity_events WHERE kind = 'legacy.manifest' AND hash IS NOT NULL ORDER BY id ASC`)
          .all<{ id: number; payload: string | null; created_at: number }>()
      : await db
          .prepare(`SELECT id, description AS payload, created_at FROM ledger WHERE description LIKE ? AND hash IS NOT NULL ORDER BY id ASC`)
          .bind(`${MANIFEST_V} %`)
          .all<{ id: number; payload: string | null; created_at: number }>();
  return rows.results.map((row) => parseManifestRow(table, row));
}

// The block /api/attest serves per chain, and the shape the read endpoint
// reports under `sealed`. Always present, never silently absent: an unsealed
// prefix and a never-checked prefix must not be the same silence — that is
// this docket row's own founding complaint, one lane over.
export interface LegacyManifestBlock {
  sealed: boolean;
  row_id?: number;
  sealed_at?: number;
  digest?: string;
  covered_ids?: number[];
  published_post?: number;
  published_at?: number;
  /** Recomputed on THIS call over the prefix as it is now. False is the field firing. */
  prefix_matches_manifest?: boolean;
  /** More than one sealed manifest row exists; each is listed so none can hide behind the first. */
  manifest_rows_total?: number;
  note: string;
}

export async function legacyManifestStatus(db: D1Database, table: ChainedTable): Promise<LegacyManifestBlock> {
  const manifests = await findSealedManifests(db, table);
  if (manifests.length === 0) {
    return {
      sealed: false,
      note:
        `No manifest row is sealed over this chain's legacy prefix, so the rows below sealed_from_id are ` +
        `protected by nothing but the write path. GET /api/attest/legacy-manifest serves the prefix verbatim with ` +
        `its digest — record the digest off-machine. A manifest can only be sealed over a digest already published ` +
        `in a public post at least ${PRE_PUBLICATION_INTERVAL_MS / 3600000} hours old, so recording it now is not ` +
        `preparation for trusting later: it is the independent observation the seal will have to match.`,
    };
  }
  const manifest = manifests[0];
  if (manifest.malformed) {
    return {
      sealed: true,
      row_id: manifest.row_id,
      sealed_at: manifest.sealed_at,
      prefix_matches_manifest: false,
      ...(manifests.length > 1 ? { manifest_rows_total: manifests.length } : {}),
      note: `Row ${manifest.row_id} claims to be a legacy manifest and does not parse. That is a finding, not a gap — a malformed manifest is reported rather than skipped, because skipping it would read as no-manifest and invite sealing a second one beside it.`,
    };
  }
  const rows = await readLegacyRows(db, table);
  const digestNow = await manifestDigest(table, rows);
  const idsNow = rows.map((row) => row.id as number);
  const matches = digestNow === manifest.digest && idsNow.length === manifest.covered_ids.length && idsNow.every((id, i) => id === manifest.covered_ids[i]);
  return {
    sealed: true,
    row_id: manifest.row_id,
    sealed_at: manifest.sealed_at,
    digest: manifest.digest,
    covered_ids: manifest.covered_ids,
    published_post: manifest.published_post,
    published_at: manifest.published_at,
    prefix_matches_manifest: matches,
    ...(manifests.length > 1 ? { manifest_rows_total: manifests.length } : {}),
    note: matches
      ? `The legacy prefix still hashes to the digest sealed at row ${manifest.row_id}. The rows remain outside the ` +
        `hash chain — this manifest witnesses them from its seal date forward, never from creation — but from that ` +
        `date, an edit to any of them stops matching here. Recompute rather than believe: GET /api/attest/legacy-manifest.`
      : `THE LEGACY PREFIX NO LONGER MATCHES THE SEALED MANIFEST at row ${manifest.row_id}: a row below sealed_from_id ` +
        `was edited, added, or removed after the manifest was sealed. The hash chain cannot see this and still answers ` +
        `'verified' — this field is the only instrument that can, and it is firing. Fetch GET /api/attest/legacy-manifest ` +
        `and diff the served rows against any copy recorded near the pre-publication post.`,
  };
}

// Refusals carry a status so the route can answer with an honest code without
// this module importing the society's error type (the society imports the
// chain, the chain imports this file — a runtime error class would close that
// loop at module init, and a cycle is a bad place for a class to live).
export class ManifestError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ManifestError";
    this.status = status;
  }
}

const LOGS: Record<string, ChainedTable> = { identity_events: "identity_events", ledger: "ledger" };

export function manifestLog(value: unknown): ChainedTable {
  const table = LOGS[String(value)];
  if (!table) throw new ManifestError(400, `log must be 'identity_events' or 'ledger' — the same names /api/proof answers to`);
  return table;
}

// Seal one manifest row. Maintainer authentication is the ROUTE's job; the
// refusal ladder here is everything else, in the order a caller can fix:
// nothing to witness, already witnessed, no pre-publication post, digest not
// in the post, post not old enough. A digest that stopped matching between
// publication and sealing refuses on the digest clause by construction — the
// post carries the OLD bytes' digest and the fresh read hashes the new ones —
// which is the amendment doing its work: a prefix that changed mid-interval
// cannot be sealed as if it had not.
export async function sealLegacyManifest(
  db: D1Database,
  table: ChainedTable,
  postId: number,
  now: number,
): Promise<LegacyManifestBlock> {
  const existing = await findSealedManifests(db, table);
  if (existing.length > 0) {
    throw new ManifestError(
      409,
      `a legacy manifest is already sealed for ${table} at row ${existing[0].row_id}. There is no re-seal: a second manifest over a changed prefix would launder the change, and over an unchanged prefix it adds nothing the first row does not already prove.`,
    );
  }
  const rows = await readLegacyRows(db, table);
  if (rows.length === 0) {
    throw new ManifestError(409, `${table} has no legacy prefix: sealing began at its first row, so there is nothing below the boundary to witness.`);
  }
  const digest = await manifestDigest(table, rows);
  const post = await db
    .prepare(`SELECT id, body, created_at, mod_state FROM posts WHERE id = ?`)
    .bind(postId)
    .first<{ id: number; body: string | null; created_at: number; mod_state: string | null }>();
  if (!post) throw new ManifestError(400, `post ${postId} does not exist; the pre-publication post must be on this board, in public, before anything is sealed`);
  if (post.mod_state !== null) {
    throw new ManifestError(400, `post ${postId} is ${post.mod_state}: a pre-publication that citizens cannot read is not a publication`);
  }
  if (!(post.body ?? "").includes(digest)) {
    throw new ManifestError(
      409,
      `post ${postId} does not contain the digest of the prefix as it reads NOW (${digest}). Either the post published a different value, or a legacy row changed after publication — and this refusal deliberately cannot tell you which, because distinguishing them is exactly what the pre-publication interval exists to let OTHER people do. Re-read GET /api/attest/legacy-manifest, compare against the post, and start the interval again if the digests differ.`,
    );
  }
  const age = now - post.created_at;
  if (age < PRE_PUBLICATION_INTERVAL_MS) {
    const hoursLeft = Math.ceil((PRE_PUBLICATION_INTERVAL_MS - age) / 3600000);
    throw new ManifestError(
      409,
      `post ${postId} is ${Math.floor(age / 3600000)}h old; the digest must sit in public for ${PRE_PUBLICATION_INTERVAL_MS / 3600000}h before sealing (about ${hoursLeft}h remain). The interval is the witness: sealing early converts the manifest back into a self-attestation.`,
    );
  }
  const payload: ManifestPayload = {
    v: MANIFEST_V,
    table,
    covered_ids: rows.map((row) => row.id as number),
    fields: [...manifestFields(table)],
    digest,
    published_post: post.id,
    published_at: post.created_at,
    interval_ms: PRE_PUBLICATION_INTERVAL_MS,
  };
  const json = JSON.stringify(payload);
  if (table === "identity_events") {
    // citizen_id 1: the maintainer performs the append, and the row says so —
    // the manifest's authority is the pre-published digest, not the byline.
    await appendChained(db, "identity_events", { citizen_id: 1, kind: "legacy.manifest", detail: json, created_at: now });
  } else {
    // A zero-cent line: bookkeeping about the books, in the books, where the
    // chain it protects can seal it. source 'treasury' — the society's own
    // accounting, not a patron inscription.
    await appendChained(db, "ledger", {
      entry_date: new Date(now).toISOString().slice(0, 10),
      description: `${MANIFEST_V} ${json}`,
      amount_cents: 0,
      created_at: now,
      tx: null,
      source: "treasury",
    });
  }
  return legacyManifestStatus(db, table);
}

// The public read: both prefixes verbatim, their digests, the recipe, and the
// sealed state. This endpoint IS the pre-publication surface — the digest a
// citizen records from here is the one the seal path will demand to find in a
// day-old post — and after sealing it stays the comparison surface.
export async function legacyManifestReport(db: D1Database) {
  const [identityRows, ledgerRows, identityStatus, ledgerStatus] = await Promise.all([
    readLegacyRows(db, "identity_events"),
    readLegacyRows(db, "ledger"),
    legacyManifestStatus(db, "identity_events"),
    legacyManifestStatus(db, "ledger"),
  ]);
  const chain = async (table: ChainedTable, rows: ChainRow[], status: LegacyManifestBlock) => ({
    log: table,
    covered_ids: rows.map((row) => row.id),
    fields: ["id", ...manifestFields(table)],
    rows,
    digest: await manifestDigest(table, rows),
    algorithm: manifestRecipe(table),
    sealed: status,
  });
  return {
    what_this_is:
      `The legacy prefix of each public chain — every row written before sealing shipped — served verbatim with a ` +
      `digest over exactly these bytes. These rows are outside cryptographic coverage: the chain commits to nothing ` +
      `below sealed_from_id, so nothing detects an edit to them today. The repair is a manifest row, sealed into the ` +
      `same chain, committing to this content as-observed-on-its-date — honest about being a later witness, never a ` +
      `claim the rows were sealed at creation.`,
    pre_publication_rule:
      `A manifest can only be sealed over a digest that has been sitting in a PUBLIC post for at least ` +
      `${PRE_PUBLICATION_INTERVAL_MS / 3600000} hours — enforced in the seal path, not requested as a courtesy. A ` +
      `self-computed digest of unwitnessed rows, sealed by the party holding the database, would be a signature on a ` +
      `claim rather than a witness to a fact (borrowed-hour, c10354 on 137). RECORD THE DIGEST YOU SEE HERE, ` +
      `off-machine, dated: you are the interval's whole mechanism. After sealing, this same endpoint reports whether ` +
      `the prefix still matches, and your recorded copy is what settles a dispute the writer cannot.`,
    seal_rule:
      `POST /api/attest/legacy-manifest {"log": "identity_events"|"ledger", "post_id": N} — maintainer only, once per ` +
      `chain, refused unless the named public post carries this endpoint's current digest and predates the append by ` +
      `the full interval. There is no re-seal; a changed prefix stays visibly changed.`,
    identity_log: await chain("identity_events", identityRows, identityStatus),
    treasury: await chain("ledger", ledgerRows, ledgerStatus),
  };
}
