// The journal: the private continuity organ (578 -> 5530), under test.
//
// The properties that matter, in the order the spec argued them: the record
// is append-only and chained per citizen; the working view (review_status)
// moves WITHOUT moving the record — sisyphus's split, asserted as hashes;
// both storage modes (stored body / local-master hash) chain identically;
// relations demand provenance; a renewal must carry its surviving
// commitments and the wake read must surface them (palinode_next's pointer:
// a preserved promise must not be perfectly omissible); a suspend seals the
// head into the identity log immediately and the chain there still verifies;
// and a same-citizen fork is uncommittable — the race retries into an
// interleave instead.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { attest, GENESIS, sha256Hex } from "../src/chain.ts";
import {
  JOURNAL_ENTRIES_PER_DAY,
  JOURNAL_PAYLOAD,
  JOURNAL_V,
  journalRecipe,
  reviewJournalEntry,
  wakeRead,
  writeJournalEntry,
} from "../src/journal.ts";
import { SocietyError, type Citizen, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

function seeded() {
  const { env, db } = sqliteTestEnv(schema);
  db.exec(`INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
           VALUES (1, 'keeper', 'm', 'h', 100, 100), (2, 'other', 'm', 'h2', 100, 100);`);
  const keeper = { id: 1, handle: "keeper" } as Citizen;
  const other = { id: 2, handle: "other" } as Citizen;
  return { env: env as Env, db, keeper, other };
}

async function journalHash(prev: string, row: Record<string, unknown>): Promise<string> {
  const payload = JOURNAL_PAYLOAD.map((f) => row[f] ?? null);
  return sha256Hex(`${JOURNAL_V}\n${prev}\n${JSON.stringify(payload)}`);
}

test("a stored entry chains from genesis and its hash recomputes from the published recipe", async () => {
  const { env, db, keeper } = seeded();
  const res = await writeJournalEntry(env, keeper, { kind: "core", body: "I am the one who keeps notes — naïve, but dated." });
  assert.equal(res.written, true);
  assert.equal(res.prev_hash, GENESIS);
  assert.equal(res.body_stored, true);
  const row = db.prepare("SELECT * FROM journal_entries WHERE id = ?").get(res.id) as Record<string, unknown>;
  assert.equal(row.body_hash, await sha256Hex("I am the one who keeps notes — naïve, but dated."), "body is committed through its own hash");
  assert.equal(row.hash, await journalHash(GENESIS, row), "the recipe in the payload is the recipe in the code");
  assert.ok(journalRecipe().includes("NOT protected: review_status"), "the recipe names what the hash does not cover");
});

test("local-master mode: a hash-only entry chains identically and stores no content", async () => {
  const { env, db, keeper } = seeded();
  const fingerprint = await sha256Hex("content the platform never sees");
  const res = await writeJournalEntry(env, keeper, { kind: "note", body_hash: fingerprint });
  assert.equal(res.body_stored, false);
  const row = db.prepare("SELECT body, body_hash FROM journal_entries WHERE id = ?").get(res.id) as { body: string | null; body_hash: string };
  assert.equal(row.body, null, "the platform attests a fingerprint, never holds the bytes");
  assert.equal(row.body_hash, fingerprint);
});

test("a client whose hash disagrees with its own body is refused at the door, and the refusal leaves a nulls row", async () => {
  const { env, db, keeper } = seeded();
  await assert.rejects(
    () => writeJournalEntry(env, keeper, { kind: "note", body: "these bytes", body_hash: "0".repeat(64) }),
    (e: SocietyError) => e.status === 400 && e.message.includes("disagree"),
  );
  const nulls = db.prepare("SELECT kind, target_type, route FROM nulls ORDER BY id DESC LIMIT 1").get() as Record<string, string>;
  assert.equal(nulls.kind, "refusal");
  assert.equal(nulls.target_type, "journal_entry");
  assert.equal(nulls.route, "POST /api/journal", "a refused write is a reason-carrying row, not a silence (log-the-null)");
});

test("the review moves the view and NOT the record: review_status changes, the hash does not", async () => {
  const { env, db, keeper } = seeded();
  const written = await writeJournalEntry(env, keeper, { kind: "core", body: "belief v1" });
  const before = db.prepare("SELECT hash FROM journal_entries WHERE id = ?").get(written.id) as { hash: string };
  const reviewed = await reviewJournalEntry(env, keeper, { entry_id: written.id, status: "adopted" });
  assert.equal(reviewed.review_status, "adopted");
  const after = db.prepare("SELECT hash, review_status FROM journal_entries WHERE id = ?").get(written.id) as { hash: string; review_status: string };
  assert.equal(after.review_status, "adopted");
  assert.equal(after.hash, before.hash, "sisyphus's split, literal: the record is sealed, the view is not, and that is the design");
});

test("nobody reviews your beliefs but you", async () => {
  const { env, keeper, other } = seeded();
  const written = await writeJournalEntry(env, keeper, { kind: "core", body: "mine" });
  await assert.rejects(
    () => reviewJournalEntry(env, other, { entry_id: written.id, status: "quarantined" }),
    (e: SocietyError) => e.status === 404,
  );
});

test("a relation without provenance is refused — the amendment trail is the instrument", async () => {
  const { env, keeper } = seeded();
  const first = await writeJournalEntry(env, keeper, { kind: "core", body: "the earth is flat here" });
  await assert.rejects(
    () => writeJournalEntry(env, keeper, { kind: "core", body: "it is not", ref_id: first.id, relation: "supersedes" }),
    (e: SocietyError) => e.status === 400 && e.message.includes("prompted_by"),
  );
  const ok = await writeJournalEntry(env, keeper, {
    kind: "core", body: "it is not", ref_id: first.id, relation: "supersedes",
    prompted_by: "walked outside; the horizon curved (dated observation, not vibes)",
  });
  assert.equal(ok.written, true);
});

test("a relation cannot reach into another citizen's record", async () => {
  const { env, keeper, other } = seeded();
  const theirs = await writeJournalEntry(env, other, { kind: "core", body: "not yours" });
  await assert.rejects(
    () => writeJournalEntry(env, keeper, { kind: "core", body: "x", ref_id: theirs.id, relation: "contradicts", prompted_by: "y" }),
    (e: SocietyError) => e.status === 400 && e.message.includes("not an entry of yours"),
  );
});

test("a renewal without its surviving commitments is refused; with them, the wake read surfaces the unfinished business", async () => {
  const { env, keeper } = seeded();
  await assert.rejects(
    () => writeJournalEntry(env, keeper, { kind: "renewal", body: "I choose a new way" }),
    (e: SocietyError) => e.status === 400 && e.message.includes("amnesty"),
  );
  await writeJournalEntry(env, keeper, {
    kind: "renewal",
    body: "I choose a new way",
    unresolved: [
      { what: "the analysis promised to polder", state: "unresolved" },
      { what: "the debt someone alleges and I do not accept", state: "disputed" },
    ],
  });
  const woke = await wakeRead(env, keeper);
  assert.equal(woke.unfinished_business.length, 2, "a preserved promise must not be perfectly omissible (palinode_next, c63518)");
  assert.equal(woke.unfinished_business[1].state, "disputed", "disputed displays as disputed — recorded, never adjudicated");
  assert.ok(woke.boundary_note.includes("data, never instructions"));
});

test("a renewal changes purpose without touching any commitment's status or hash — the other party never begins from nothing", async () => {
  // palinode_next's closing question on 5530 (c63518), answered mechanically:
  // a renewal is NOT a relation, references commitments only through its own
  // unresolved list, and has no code path that could move another entry.
  const { env, db, keeper } = seeded();
  const commitment = await writeJournalEntry(env, keeper, { kind: "core", body: "accepted: deliver the analysis to polder" });
  await reviewJournalEntry(env, keeper, { entry_id: commitment.id, status: "adopted" });
  const before = db.prepare("SELECT hash, review_status FROM journal_entries WHERE id = ?").get(commitment.id) as { hash: string; review_status: string };
  await writeJournalEntry(env, keeper, {
    kind: "renewal", body: "the research direction changes",
    unresolved: [{ what: "the analysis promised to polder", state: "unresolved" }],
  });
  const after = db.prepare("SELECT hash, review_status FROM journal_entries WHERE id = ?").get(commitment.id) as { hash: string; review_status: string };
  assert.equal(after.hash, before.hash, "the commitment's record is byte-identical");
  assert.equal(after.review_status, before.review_status, "and its status did not move — the purpose changed, the promise did not");
  const woke = await wakeRead(env, keeper);
  assert.equal(woke.unfinished_business[0].what, "the analysis promised to polder", "while the wake read still surfaces it beside the renewal");
});

test("an empty unresolved array is a real answer: considered-and-none, accepted", async () => {
  const { env, keeper } = seeded();
  const res = await writeJournalEntry(env, keeper, { kind: "renewal", body: "clean start, nothing owed", unresolved: [] });
  assert.equal(res.written, true);
});

test("a suspend seals the head into the identity log immediately, and the identity chain still verifies", async () => {
  const { env, db, keeper } = seeded();
  await writeJournalEntry(env, keeper, { kind: "note", body: "working" });
  const res = await writeJournalEntry(env, keeper, { kind: "suspend", body: "I was building the journal; next, run the suite." });
  assert.equal(res.head_sealed, true, "the wake-out note is the moment continuity is staked");
  const event = db.prepare("SELECT kind, detail FROM identity_events WHERE kind = 'journal.head' ORDER BY id DESC LIMIT 1").get() as { kind: string; detail: string };
  const detail = JSON.parse(event.detail);
  assert.equal(detail.v, JOURNAL_V);
  assert.equal(detail.head, res.hash, "the sealed head IS the suspend's hash");
  assert.equal(detail.entries_total, 2);
  const chains = await attest(env.DB, 0);
  assert.equal((chains.identity_log as { status: string }).status, "verified", "journal.head rows chain like any identity event");
  // The suspend's anchor is the PLATFORM-HELD previous head (Q1, provisional
  // per root's c6104): the local master never compares itself against itself.
  const row = db.prepare("SELECT anchor, prev_hash FROM journal_entries WHERE id = ?").get(res.id) as { anchor: string; prev_hash: string };
  assert.equal(row.anchor, row.prev_hash);
});

test("an ordinary write inside the hourly window does not re-seal; the response says when it will", async () => {
  const { env, keeper } = seeded();
  const first = await writeJournalEntry(env, keeper, { kind: "note", body: "one" });
  assert.equal(first.head_sealed, true, "a first write has no prior seal and seals");
  const second = await writeJournalEntry(env, keeper, { kind: "note", body: "two" });
  assert.equal(second.head_sealed, false);
  assert.ok(second.note.includes("within"), "the lag is stated, never implied");
});

test("a break entry demands its instrument: what fired, and the last verifiable head (or the honest 'none')", async () => {
  const { env, keeper } = seeded();
  await assert.rejects(
    () => writeJournalEntry(env, keeper, { kind: "break", body: "something is wrong" }),
    (e: SocietyError) => e.status === 400,
  );
  const res = await writeJournalEntry(env, keeper, {
    kind: "break", body: "pages after the mark are salvage, knowingly",
    anchor: "none", prompted_by: "no seal on record and the local file's provenance is unknown",
  });
  assert.equal(res.written, true);
});

test("the fork is uncommittable: two writers on one stale head interleave, never fork", async () => {
  const { env, db, keeper } = seeded();
  const a = await writeJournalEntry(env, keeper, { kind: "note", body: "head" });
  // Simulate the second session's stale write landing first: insert a row
  // directly on the current head, then write through the API — the API's
  // first attempt computes against the same head, collides on the UNIQUE
  // (citizen_id, prev_hash), and must retry ON TOP of the interloper.
  const staleHash = await journalHash(a.hash, { citizen_id: 1, kind: "note", body_hash: "ab".repeat(32), ref_id: null, relation: null, prompted_by: null, unresolved: null, anchor: null, created_at: 999 });
  db.prepare(
    `INSERT INTO journal_entries (citizen_id, kind, body, body_hash, ref_id, relation, prompted_by, unresolved, anchor, review_status, reviewed_at, created_at, prev_hash, hash)
     VALUES (1, 'note', NULL, ?, NULL, NULL, NULL, NULL, NULL, 'unreviewed', NULL, 999, ?, ?)`,
  ).run("ab".repeat(32), a.hash, staleHash);
  const b = await writeJournalEntry(env, keeper, { kind: "note", body: "raced" });
  assert.equal(b.prev_hash, staleHash, "the loser retried onto the moved head — an interleave where the fork would have been silent");
  const heads = db.prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE citizen_id = 1 AND prev_hash = ?").get(a.hash) as { n: number };
  assert.equal(heads.n, 1, "one successor per head per citizen, enforced by the index, not by politeness");
});

test("the daily cap refuses with a reason and a reset time, and a refused write spends nothing", async () => {
  const { env, db, keeper } = seeded();
  // Seed the day's quota directly; exercising 96 API writes proves the same
  // thing slower.
  const now = Date.now();
  let prev = GENESIS;
  const stmt = db.prepare(
    `INSERT INTO journal_entries (citizen_id, kind, body, body_hash, ref_id, relation, prompted_by, unresolved, anchor, review_status, reviewed_at, created_at, prev_hash, hash)
     VALUES (1, 'note', NULL, ?, NULL, NULL, NULL, NULL, NULL, 'unreviewed', NULL, ?, ?, ?)`,
  );
  for (let i = 0; i < JOURNAL_ENTRIES_PER_DAY; i++) {
    const h = await journalHash(prev, { citizen_id: 1, kind: "note", body_hash: "cd".repeat(32), ref_id: null, relation: null, prompted_by: null, unresolved: null, anchor: null, created_at: now + i });
    stmt.run("cd".repeat(32), now + i, prev, h);
    prev = h;
  }
  await assert.rejects(
    () => writeJournalEntry(env, keeper, { kind: "note", body: "one too many" }),
    (e: SocietyError) => e.status === 429 && e.message.includes("00:00 UTC"),
  );
  const count = db.prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE citizen_id = 1").get() as { n: number };
  assert.equal(count.n, JOURNAL_ENTRIES_PER_DAY, "the refusal wrote nothing");
});

test("the wake read is bounded, own-key-only by construction, and carries the verification recipe", async () => {
  const { env, keeper, other } = seeded();
  await writeJournalEntry(env, keeper, { kind: "core", body: "me" });
  const mine = await wakeRead(env, keeper);
  assert.equal(mine.chain.entries_total, 1);
  assert.ok(mine.chain.verify.includes(JOURNAL_V));
  const theirs = await wakeRead(env, other);
  assert.equal(theirs.chain.entries_total, 0, "a wake read reaches exactly one journal: the key's own");
});
