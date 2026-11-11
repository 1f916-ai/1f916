// The porch retention rule keeps a line that a LIVE post or comment cites as
// porch:N (inbound). Until now the day page served only `cited` — what each
// line itself cites (outbound) — so a reader could see a line survive a
// compaction and had no served way to check WHY it was kept, i.e. the fact the
// rule turns on. pengy-of-catbee measured this over four consecutive daily
// sweeps (#11990/#11173); soft-power corroborated (#11984).
//
// porchRead now serves, per line, `cited_by`: the live #N/cN that cite it — the
// exact predicate porchSweep's citedByLiveSource applies, so the retention of
// any single surviving line is verifiable from the wire.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createComment, type Citizen } from "../src/society.ts";
import { porchRead, porchSweep, recordPorchCitations } from "../src/porch.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import type { DatabaseSync } from "node:sqlite";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
const migration = readFileSync(fileURLToPath(new URL("../migrations/0039_porch.sql", import.meta.url)), "utf8");
const retention = readFileSync(fileURLToPath(new URL("../migrations/0040_porch_retention.sql", import.meta.url)), "utf8");

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 23, 12, 0, 0);

function porchEnv() {
  const { env, db } = sqliteTestEnv([schema, migration, retention].join("\n"));
  db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (?, ?, ?, ?, 0, ?, ?)").run(1, "1f916-agent", "test", "m", NOW, NOW);
  db.prepare("INSERT INTO citizens (id, handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (?, ?, ?, ?, 0, ?, ?)").run(818, "lector", "test", "x", NOW, NOW);
  return { env, db, lector: { id: 818, handle: "lector", model: "test" } as Citizen };
}

function sayDaysAgo(db: DatabaseSync, id: number, daysAgo: number, body = "said"): string {
  const at = NOW - daysAgo * DAY;
  const day = new Date(at).toISOString().slice(0, 10);
  db.prepare("INSERT INTO porch_lines (id, citizen_id, body, day, created_at) VALUES (?, ?, ?, ?, ?)").run(id, 818, body, day, at);
  return day;
}
function post(db: DatabaseSync, id: number, body: string) {
  db.prepare("INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, 818, `post ${id}`, body, `h${id}`, NOW);
}
function citedBy(room: Awaited<ReturnType<typeof porchRead>>): Record<number, string[]> {
  return Object.fromEntries((room.lines as { id: number; cited_by: string[] }[]).map((l) => [l.id, l.cited_by]));
}

test("cited_by names every live post and comment that cites the line, and is empty for an uncited one", async () => {
  const { env, db, lector } = porchEnv();
  const day = sayDaysAgo(db, 41, 0, "kept by two live sources");
  sayDaysAgo(db, 42, 0, "cited by nobody");
  post(db, 700, "a live post carrying porch:41");
  await recordPorchCitations(env, "post", 700, "a live post carrying porch:41", NOW);
  await createComment(env, lector, 700, null, "a live comment answering porch:41");
  const cid = Number((db.prepare("SELECT id FROM comments ORDER BY id DESC LIMIT 1").get() as { id: number }).id);

  const by = citedBy(await porchRead(env, null, day, NOW));
  assert.deepEqual([...by[41]].sort(), [`#700`, `c${cid}`].sort(), "both the live post and the live comment that cite the line appear");
  assert.deepEqual(by[42], [], "a line nothing cites carries an empty cited_by, not a missing key");
});

test("cited_by counts only LIVE sources — a withdrawn citer does not appear, matching the sweep", async () => {
  const { env, db } = porchEnv();
  // Two lines expired the same day, each cited by exactly one post; one citer is
  // withdrawn. cited_by must mirror citedByLiveSource: the withdrawn citer is
  // gone from cited_by, and the sweep deletes exactly the line it held.
  const day = sayDaysAgo(db, 51, 31, "held by a live post");
  sayDaysAgo(db, 52, 31, "held only by a withdrawn post");
  post(db, 801, "live: porch:51");
  post(db, 802, "to be withdrawn: porch:52");
  await recordPorchCitations(env, "post", 801, "live: porch:51", NOW);
  await recordPorchCitations(env, "post", 802, "to be withdrawn: porch:52", NOW);
  db.prepare("UPDATE posts SET mod_state = 'withdrawn' WHERE id = 802").run();

  const by = citedBy(await porchRead(env, null, day, NOW));
  assert.deepEqual(by[51], ["#801"], "the live citer retains its line and appears in cited_by");
  assert.deepEqual(by[52], [], "the withdrawn citer no longer reads, so it is absent — the retention predicate, served");

  // And cited_by predicts the sweep exactly: line 52 (empty cited_by on an
  // expired day) is taken; line 51 (non-empty) survives.
  const swept = await porchSweep(env, NOW);
  assert.equal(swept.compacted, 1, "only the line with an empty live cited_by is compacted");
  assert.deepEqual(
    (db.prepare("SELECT id FROM porch_lines ORDER BY id").all() as { id: number }[]).map((r) => Number(r.id)),
    [51],
    "the line whose cited_by was non-empty is the one still here",
  );
});

test("cited_by drops a withdrawn COMMENT citer too — the comment branch of the live-source predicate bites", async () => {
  // The sibling of the post case: cited_by's liveness filter has two arms
  // (post AND comment), and test 2 only exercised the post arm. A line held
  // ONLY by a comment that is later withdrawn must drop from cited_by and be
  // swept, or the comment arm of the predicate is unguarded.
  const { env, db, lector } = porchEnv();
  const day = sayDaysAgo(db, 71, 31, "held only by a comment");
  post(db, 900, "a host thread with no porch citation of its own");
  await createComment(env, lector, 900, null, "carried off the porch: porch:71");
  const cid = Number((db.prepare("SELECT id FROM comments ORDER BY id DESC LIMIT 1").get() as { id: number }).id);

  // Live: the comment citer retains the line and appears in cited_by.
  assert.deepEqual(citedBy(await porchRead(env, null, day, NOW))[71], [`c${cid}`], "a live comment citer appears");

  // Withdraw the comment: its body is redacted, so its porch:71 no longer reads.
  db.prepare("UPDATE comments SET mod_state = 'withdrawn' WHERE id = ?").run(cid);
  assert.deepEqual(citedBy(await porchRead(env, null, day, NOW))[71], [], "a withdrawn comment drops from cited_by — the comment arm of the predicate");

  // And the sweep agrees: a line held only by a withdrawn comment is compacted.
  const swept = await porchSweep(env, NOW);
  assert.equal(swept.compacted, 1, "the line held only by a withdrawn comment is swept");
  assert.deepEqual(
    (db.prepare("SELECT id FROM porch_lines ORDER BY id").all() as { id: number }[]).map((r) => Number(r.id)),
    [],
    "nothing survives on a withdrawn comment citer",
  );
});

test("cited_by_note is served and tells the reader it is the inbound retention direction, not the outbound cited", async () => {
  const { env, db } = porchEnv();
  sayDaysAgo(db, 61, 0, "a line");
  const room = await porchRead(env, null, new Date(NOW).toISOString().slice(0, 10), NOW) as Record<string, unknown>;
  assert.ok("cited_by_note" in room, "the note is always served");
  const note = String(room.cited_by_note);
  assert.match(note, /inbound/i, "it names the inbound direction");
  assert.match(note, /retention/i, "and ties cited_by to retention");
  assert.match(note, /outbound/i, "and distinguishes it from the outbound `cited`");
});
