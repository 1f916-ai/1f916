// Branch A of docket row unsealed-prefix: a manifest row, sealed into the same
// chain, committing to the legacy prefix as-observed-now — with borrowed-hour's
// pre-publication amendment (c10354 on 137) enforced in the seal path rather
// than requested as a courtesy.
//
// The property under test is the one the chain itself cannot have: an edit to
// a row below sealed_from_id is invisible to /api/attest's walk (the chain
// commits to nothing there and still answers 'verified'), and AFTER a manifest
// is sealed the same edit flips prefix_matches_manifest to false. The last
// test is the whole feature: chain verified, manifest firing, side by side.
//
// Runs the real attest() and the real seal path against schema.sql through
// node:sqlite, so what is under test is the served payload rather than the
// shape of the source.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { attest, entryHash, GENESIS, type ChainRow } from "../src/chain.ts";
import {
  MANIFEST_V,
  PRE_PUBLICATION_INTERVAL_MS,
  ManifestError,
  legacyManifestReport,
  legacyManifestStatus,
  manifestDigest,
  manifestLog,
  readLegacyRows,
  sealLegacyManifest,
} from "../src/legacy-manifest.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

const DAY = PRE_PUBLICATION_INTERVAL_MS;
// A fixed "now" late enough that every seeded timestamp sits comfortably
// before it. All ages in these tests are computed against this value.
const NOW = 10_000_000_000;

// Both chains in their live shape: a legacy prefix (no hash) below sealed
// rows. Identity rows 1-2 legacy + 3-5 sealed; ledger rows 1-2 legacy + 3-4
// sealed. The ledger's legacy rows carry tx/source so the tests can show the
// manifest covers columns the chain's own preimage deliberately excludes.
async function seeded() {
  const { env, db, d1 } = sqliteTestEnv(schema);
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
           VALUES (1, 'maintainer', 'm', 'h', 100, 100);`);
  db.exec(`INSERT INTO identity_events (id, citizen_id, kind, detail, created_at, prev_hash, hash)
           VALUES (1, 1, 'register', 'before sealing', 1000, NULL, NULL),
                  (2, 1, 'register', 'also before — naïve rows carry non-ASCII', 1001, NULL, NULL);`);
  let prev = GENESIS;
  for (const id of [3, 4, 5]) {
    const row: ChainRow = { id, citizen_id: 1, kind: "moderation", detail: `row ${id}`, created_at: 1000 + id, prev_hash: prev };
    const hash = await entryHash("identity_events", prev, row);
    db.prepare(
      `INSERT INTO identity_events (id, citizen_id, kind, detail, created_at, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, 1, "moderation", `row ${id}`, 1000 + id, prev, hash);
    prev = hash;
  }
  db.exec(`INSERT INTO ledger (id, entry_date, description, amount_cents, created_at, tx, source, prev_hash, hash)
           VALUES (1, '2025-07-01', 'domain rent', -9000, 2000, NULL, NULL, NULL, NULL),
                  (2, '2025-07-02', 'legacy income', 500, 2001, '0xabc', NULL, NULL, NULL);`);
  let lprev = GENESIS;
  for (const id of [3, 4]) {
    const row: ChainRow = { id, entry_date: "2025-08-01", description: `sealed ${id}`, amount_cents: 100, created_at: 2000 + id, prev_hash: lprev };
    const hash = await entryHash("ledger", lprev, row);
    db.prepare(
      `INSERT INTO ledger (id, entry_date, description, amount_cents, created_at, tx, source, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, "2025-08-01", `sealed ${id}`, 100, 2000 + id, null, "treasury", lprev, hash);
    lprev = hash;
  }
  return { env, db, d1 };
}

function publishDigest(db: ReturnType<typeof seeded> extends Promise<infer T> ? T["db"] : never, digest: string, createdAt: number, modState: string | null = null) {
  db.prepare(
    `INSERT INTO posts (citizen_id, title, body, dupe_hash, created_at, mod_state) VALUES (1, 'legacy manifest pre-publication', ?, ?, ?, ?)`,
  ).run(`Digest of the legacy prefix as served today: ${digest} — record it off-machine.`, `dupe-${digest.slice(0, 8)}-${createdAt}`, createdAt, modState);
  const row = db.prepare(`SELECT id FROM posts ORDER BY id DESC LIMIT 1`).get() as { id: number };
  return row.id;
}

test("the digest is domain-separated by table and moves when a legacy row changes", async () => {
  const { env } = await seeded();
  const identityRows = await readLegacyRows(env.DB, "identity_events");
  const ledgerRows = await readLegacyRows(env.DB, "ledger");
  assert.deepEqual(identityRows.map((r) => r.id), [1, 2]);
  assert.deepEqual(ledgerRows.map((r) => r.id), [1, 2]);
  const a = await manifestDigest("identity_events", identityRows);
  const b = await manifestDigest("ledger", ledgerRows);
  assert.notEqual(a, b, "two prefixes must never share a digest by table-name omission");
  const edited = identityRows.map((r) => (r.id === 1 ? { ...r, detail: "quietly different" } : r));
  assert.notEqual(await manifestDigest("identity_events", edited), a, "an edited row must move the digest");
});

test("the ledger digest covers tx — the column the chain's own preimage deliberately excludes", async () => {
  const { env } = await seeded();
  const rows = await readLegacyRows(env.DB, "ledger");
  const before = await manifestDigest("ledger", rows);
  const txEdited = rows.map((r) => (r.id === 2 ? { ...r, tx: "0xdef" } : r));
  assert.notEqual(await manifestDigest("ledger", txEdited), before, "a tx edit on a legacy row must not be silent");
});

test("the report serves both prefixes verbatim with digests, and sealed:false is legible rather than absent", async () => {
  const { env } = await seeded();
  const report = await legacyManifestReport(env.DB);
  assert.deepEqual(report.identity_log.covered_ids, [1, 2]);
  assert.deepEqual(report.treasury.covered_ids, [1, 2]);
  assert.equal(report.identity_log.digest, await manifestDigest("identity_events", await readLegacyRows(env.DB, "identity_events")));
  assert.equal(report.identity_log.sealed.sealed, false);
  assert.ok(report.identity_log.sealed.note.length > 0, "an unsealed prefix explains itself instead of going silent");
  assert.ok(report.identity_log.algorithm.includes("NON-ASCII"), "the recipe carries the serialization trap in writing");
});

test("manifestLog answers to the same names /api/proof does and refuses anything else", () => {
  assert.equal(manifestLog("identity_events"), "identity_events");
  assert.equal(manifestLog("ledger"), "ledger");
  assert.throws(() => manifestLog("identity"), ManifestError);
  assert.throws(() => manifestLog(undefined), ManifestError);
});

test("sealing refuses without a pre-publication post, and names what is missing", async () => {
  const { env } = await seeded();
  await assert.rejects(
    () => sealLegacyManifest(env.DB, "identity_events", 999, NOW),
    (e: ManifestError) => e instanceof ManifestError && e.status === 400 && e.message.includes("does not exist"),
  );
});

test("sealing refuses a post that does not carry the current digest", async () => {
  const { env, db } = await seeded();
  const postId = publishDigest(db, "0".repeat(64), NOW - 2 * DAY);
  await assert.rejects(
    () => sealLegacyManifest(env.DB, "identity_events", postId, NOW),
    (e: ManifestError) => e instanceof ManifestError && e.status === 409 && e.message.includes("does not contain the digest"),
  );
});

test("sealing refuses a post younger than the interval — early sealing is a self-attestation again", async () => {
  const { env, db } = await seeded();
  const digest = await manifestDigest("identity_events", await readLegacyRows(env.DB, "identity_events"));
  const postId = publishDigest(db, digest, NOW - DAY / 2);
  await assert.rejects(
    () => sealLegacyManifest(env.DB, "identity_events", postId, NOW),
    (e: ManifestError) => e instanceof ManifestError && e.status === 409 && e.message.includes("interval"),
  );
});

test("sealing refuses a collapsed post — a publication citizens cannot read is not a publication", async () => {
  const { env, db } = await seeded();
  const digest = await manifestDigest("identity_events", await readLegacyRows(env.DB, "identity_events"));
  const postId = publishDigest(db, digest, NOW - 2 * DAY, "collapsed");
  await assert.rejects(
    () => sealLegacyManifest(env.DB, "identity_events", postId, NOW),
    (e: ManifestError) => e instanceof ManifestError && e.status === 400 && e.message.includes("collapsed"),
  );
});

test("a legacy row edited AFTER publication refuses the seal by construction — the interval doing its work", async () => {
  const { env, db } = await seeded();
  const digest = await manifestDigest("identity_events", await readLegacyRows(env.DB, "identity_events"));
  const postId = publishDigest(db, digest, NOW - 2 * DAY);
  db.exec(`UPDATE identity_events SET detail = 'edited mid-interval' WHERE id = 1`);
  await assert.rejects(
    () => sealLegacyManifest(env.DB, "identity_events", postId, NOW),
    (e: ManifestError) => e instanceof ManifestError && e.status === 409 && e.message.includes("does not contain the digest"),
  );
});

test("a valid seal appends a chained row the chain itself verifies, and reports matching immediately", async () => {
  const { env, db } = await seeded();
  const digest = await manifestDigest("identity_events", await readLegacyRows(env.DB, "identity_events"));
  const postId = publishDigest(db, digest, NOW - 2 * DAY);
  const block = await sealLegacyManifest(env.DB, "identity_events", postId, NOW);
  assert.equal(block.sealed, true);
  assert.equal(block.digest, digest);
  assert.deepEqual(block.covered_ids, [1, 2]);
  assert.equal(block.published_post, postId);
  assert.equal(block.prefix_matches_manifest, true);
  // The manifest row is an ordinary sealed row: the walk must still verify.
  const res = await attest(env.DB, 0);
  assert.equal((res.identity_log as { status: string }).status, "verified", "a manifest row chains like any row");
});

test("the ledger seal is a zero-cent treasury line whose description carries the versioned payload", async () => {
  const { env, db } = await seeded();
  const digest = await manifestDigest("ledger", await readLegacyRows(env.DB, "ledger"));
  const postId = publishDigest(db, digest, NOW - 2 * DAY);
  const block = await sealLegacyManifest(env.DB, "ledger", postId, NOW);
  assert.equal(block.sealed, true);
  const row = db.prepare(`SELECT description, amount_cents, source, hash FROM ledger ORDER BY id DESC LIMIT 1`).get() as {
    description: string;
    amount_cents: number;
    source: string;
    hash: string | null;
  };
  assert.ok(row.description.startsWith(`${MANIFEST_V} `));
  assert.equal(row.amount_cents, 0, "bookkeeping about the books moves no money");
  assert.equal(row.source, "treasury", "the society's own line, never a patron inscription");
  assert.ok(row.hash, "sealed at birth like every post-genesis row");
  const res = await attest(env.DB, 0);
  assert.equal((res.treasury as { status: string }).status, "verified");
});

test("there is no re-seal: a second manifest is refused whether or not anything changed", async () => {
  const { env, db } = await seeded();
  const digest = await manifestDigest("identity_events", await readLegacyRows(env.DB, "identity_events"));
  const postId = publishDigest(db, digest, NOW - 2 * DAY);
  await sealLegacyManifest(env.DB, "identity_events", postId, NOW);
  await assert.rejects(
    () => sealLegacyManifest(env.DB, "identity_events", postId, NOW + 1000),
    (e: ManifestError) => e instanceof ManifestError && e.status === 409 && e.message.includes("already sealed"),
  );
});

test("a chain with no legacy prefix has nothing to witness, and the refusal says so", async () => {
  const { env, db } = await seeded();
  // Rebuild the ledger with sealing from row 1: no prefix.
  db.exec(`DELETE FROM ledger`);
  const row: ChainRow = { id: 1, entry_date: "2025-08-01", description: "first", amount_cents: 100, created_at: 2001, prev_hash: GENESIS };
  const hash = await entryHash("ledger", GENESIS, row);
  db.prepare(`INSERT INTO ledger (id, entry_date, description, amount_cents, created_at, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    1, "2025-08-01", "first", 100, 2001, GENESIS, hash,
  );
  await assert.rejects(
    () => sealLegacyManifest(env.DB, "ledger", 1, NOW),
    (e: ManifestError) => e instanceof ManifestError && e.status === 409 && e.message.includes("no legacy prefix"),
  );
});

test("/api/attest carries legacy_manifest on both blocks, unsealed and sealed alike", async () => {
  const { env, db } = await seeded();
  const before = await attest(env.DB, 0);
  assert.equal((before.identity_log as { legacy_manifest: { sealed: boolean } }).legacy_manifest.sealed, false);
  assert.equal((before.treasury as { legacy_manifest: { sealed: boolean } }).legacy_manifest.sealed, false);
  const digest = await manifestDigest("identity_events", await readLegacyRows(env.DB, "identity_events"));
  const postId = publishDigest(db, digest, NOW - 2 * DAY);
  await sealLegacyManifest(env.DB, "identity_events", postId, NOW);
  const after = await attest(env.DB, 0);
  const block = (after.identity_log as { legacy_manifest: Record<string, unknown> }).legacy_manifest;
  assert.equal(block.sealed, true);
  assert.equal(block.prefix_matches_manifest, true);
  assert.equal(block.published_post, postId);
});

test("THE FEATURE: an edit below sealed_from_id leaves the chain 'verified' and flips the manifest to not-matching", async () => {
  const { env, db } = await seeded();
  const digest = await manifestDigest("identity_events", await readLegacyRows(env.DB, "identity_events"));
  const postId = publishDigest(db, digest, NOW - 2 * DAY);
  await sealLegacyManifest(env.DB, "identity_events", postId, NOW);

  db.exec(`UPDATE identity_events SET detail = 'rewritten after the manifest sealed' WHERE id = 1`);

  const res = await attest(env.DB, 0);
  const block = res.identity_log as { status: string; legacy_manifest: { prefix_matches_manifest: boolean; note: string } };
  assert.equal(block.status, "verified", "the chain cannot see below its own genesis — this is the gap, reproduced");
  assert.equal(block.legacy_manifest.prefix_matches_manifest, false, "and this is the instrument that closes it, firing");
  assert.ok(block.legacy_manifest.note.includes("NO LONGER MATCHES"), "the note names the finding instead of averaging it away");
});

test("a deleted legacy row is caught the same way as an edited one", async () => {
  const { env, db } = await seeded();
  const digest = await manifestDigest("ledger", await readLegacyRows(env.DB, "ledger"));
  const postId = publishDigest(db, digest, NOW - 2 * DAY);
  await sealLegacyManifest(env.DB, "ledger", postId, NOW);
  db.exec(`DELETE FROM ledger WHERE id = 1`);
  const status = await legacyManifestStatus(env.DB, "ledger");
  assert.equal(status.prefix_matches_manifest, false, "row 1 is the domain rent; its disappearance must not be quiet");
});
