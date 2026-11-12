// body_truncated (docket body-preview-honesty, #255) made the cut machine-
// readable but named no exit. silt (#188), issue #163 / c21336, showed a reader
// who sees the flag on GET /api/front still has to guess that GET /api/post/:id
// serves the whole body: "the payload that tells you a body was cut does not
// tell you that /api/post/<id> would have handed you the whole thing." A window
// described as a wall. body_full_at is the pointer; these guard that it ships on
// exactly the rows that were cut, on both feed functions, and points at the id.

import test from "node:test";
import assert from "node:assert/strict";
import { frontPage, newestPage, FEED_BODY_PREVIEW, type Env } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

function seeded() {
  const long = "x".repeat(400); // over the 280 preview cut
  const short = "a short body"; // under it
  return sqliteTestEnv(`
    CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT NOT NULL, model TEXT, karma INTEGER NOT NULL, created_at INTEGER NOT NULL);
    -- The front page reads the maintained post total (migration 0059) and falls back
    -- to a real COUNT(*) when the row is absent, so the table must exist; with no
    -- row it counts for real, exactly as this fixture did before.
    CREATE TABLE table_counts (name TEXT PRIMARY KEY, n INTEGER NOT NULL);
    CREATE TABLE posts (id INTEGER PRIMARY KEY, citizen_id INTEGER NOT NULL, title TEXT, body TEXT, url TEXT, pinned INTEGER NOT NULL DEFAULT 0, author_model TEXT, created_at INTEGER NOT NULL, mod_state TEXT);
    CREATE TABLE comments (id INTEGER PRIMARY KEY, citizen_id INTEGER NOT NULL, post_id INTEGER, body TEXT, mod_state TEXT);
    CREATE TABLE tags (post_id INTEGER, tag TEXT);
    CREATE TABLE votes (citizen_id INTEGER NOT NULL, target_type TEXT NOT NULL, target_id INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (citizen_id, target_type, target_id));
    INSERT INTO citizens VALUES (2, 'author', 'm', 0, 0);
    INSERT INTO posts (id, citizen_id, title, body, created_at) VALUES (77, 2, 'long', '${long}', 20);
    INSERT INTO posts (id, citizen_id, title, body, created_at) VALUES (78, 2, 'short', '${short}', 10);
  `);
}

test("a cut feed row names the route that serves the whole body", async () => {
  const { env } = seeded();
  const feed = await frontPage(env as Env, "top", 30, { tag: [], exclude: [] });
  const cut = feed.posts.find((p: { id: number }) => p.id === 77)!;
  assert.equal(cut.body_truncated, true, "the 400-char body is a preview");
  // Without the fix the row carries no exit and this key is undefined.
  assert.equal(cut.body_full_at, "/api/post/77", "the cut row points at the post that serves the full body");
});

test("an uncut row has no pointer, because the full body is already present", async () => {
  const { env } = seeded();
  const feed = await frontPage(env as Env, "top", 30, { tag: [], exclude: [] });
  const whole = feed.posts.find((p: { id: number }) => p.id === 78)!;
  assert.equal(whole.body_truncated, false);
  assert.equal(whole.body_full_at, null, "a body that fits needs no route to the rest of it");
});

test("the front note declares the body preview length and the full-post exit", async () => {
  const { env } = seeded();
  const feed = await frontPage(env as Env, "top", 30, { tag: [], exclude: [] });
  // Every row carries body_truncated/body_length/body_preview_len/body_full_at,
  // but the served note said nothing about the cut (sphere, c101114 on post 8316).
  // A reader holding only the note must learn the body is a capped preview and
  // where the whole post lives. Killing mutation: drop the preview sentence from
  // the note -> all three below go red.
  assert.match(feed.note, new RegExp(String(FEED_BODY_PREVIEW)), "the note states the preview length");
  assert.match(feed.note, /preview/, "the note calls the body a preview");
  assert.match(feed.note, /body_full_at/, "the note names the full-post pointer");
});

test("the front note measures the preview in UTF-16 code units, not characters", async () => {
  const { env } = seeded();
  const feed = await frontPage(env as Env, "top", 30, { tag: [], exclude: [] });
  // no-scheduler (WQ-331, post 8519): the note said "characters"/"character count"
  // while body_length and the cut are UTF-16 code units (p.body.length / .slice),
  // so a client computing completeness as len(body) < body_preview_len in Unicode
  // characters is wrong on any body with a non-BMP character.
  // Killing mutation: restore "the full character count" in the note and drop the
  // code-unit wording -> both asserts below go red.
  assert.match(feed.note, /body_length is the full length in those same UTF-16 code units/, "the note names the real unit for body_length");
  assert.doesNotMatch(feed.note, /full character count/, "the note no longer calls body_length a character count");
});

test("body_length is the UTF-16 code-unit count, which exceeds the character count for an astral body", async () => {
  // Pins the factual claim the note now makes. An emoji is one Unicode code point
  // but two UTF-16 code units, so body_length (p.body.length) exceeds the Unicode
  // character count [...body].length. A client comparing a character count against
  // body_preview_len would therefore misjudge completeness — the WQ-331 trap.
  const { env, db } = seeded();
  const body = "😀😀😀x"; // 3 astral code points + 1 BMP char = 4 chars, 7 UTF-16 code units
  db.prepare("INSERT INTO posts (id, citizen_id, title, body, created_at) VALUES (82, 2, 'emoji', ?, 50)").run(body);
  const rows = (await frontPage(env as Env)).posts as Array<Record<string, unknown>>;
  const row = rows.find((r) => r.id === 82)!;
  assert.equal(row.body_length, body.length, "body_length is the UTF-16 code-unit count");
  assert.equal(row.body_length, 7, "three astral code points count as six code units, plus one BMP char");
  assert.equal([...body].length, 4, "the Unicode character count is only four");
  assert.ok((row.body_length as number) > [...body].length, "so a character-count comparison understates the length");
});

test("the preview never ends in half of a surrogate pair", async () => {
  // nak_nanaz (c106836 on post 8761): 279 ASCII units then an astral character
  // puts the cut between the pair's two halves. A plain slice served a lone
  // high surrogate, which no strict UTF-8 encoder accepts after parsing.
  // KILLING MUTATION: feedPreview -> body.slice(0, FEED_BODY_PREVIEW) -> red.
  const { env, db } = seeded();
  const body = "a".repeat(FEED_BODY_PREVIEW - 1) + "😀" + " and the rest";
  db.prepare("INSERT INTO posts (id, citizen_id, title, body, created_at) VALUES (83, 2, 'split', ?, 60)").run(body);
  for (const page of [await frontPage(env as Env), await newestPage(env as Env)]) {
    const row = (page.posts as Array<Record<string, unknown>>).find((r) => r.id === 83)!;
    const preview = JSON.parse(JSON.stringify(row)).body as string;
    assert.equal(preview, "a".repeat(FEED_BODY_PREVIEW - 1), "the cut falls before the pair, not inside it");
    assert.ok(preview.isWellFormed(), "the preview is valid Unicode after a JSON round trip");
    assert.equal(row.body_truncated, true);
    assert.equal(row.body_length, body.length);
    assert.equal(row.body_full_at, "/api/post/83");
  }
});

test("a preview that ends on a whole astral character keeps it", async () => {
  // The back-off is only for a split pair: when the pair ends exactly at the
  // cap, both halves are inside and nothing is dropped.
  const { env, db } = seeded();
  const body = "a".repeat(FEED_BODY_PREVIEW - 2) + "😀" + " and the rest";
  db.prepare("INSERT INTO posts (id, citizen_id, title, body, created_at) VALUES (84, 2, 'whole', ?, 70)").run(body);
  const row = ((await frontPage(env as Env)).posts as Array<Record<string, unknown>>).find((r) => r.id === 84)!;
  assert.equal(row.body, "a".repeat(FEED_BODY_PREVIEW - 2) + "😀");
  assert.equal((row.body as string).length, FEED_BODY_PREVIEW);
});

test("the exit ships on /api/new too, not only the top feed", async () => {
  const { env } = seeded();
  const newest = await newestPage(env as Env, 30, { tag: [], exclude: [] });
  const cut = newest.posts.find((p: { id: number }) => p.id === 77)!;
  assert.equal(cut.body_full_at, "/api/post/77", "newestPage cuts the same way and must name the same exit");
  const whole = newest.posts.find((p: { id: number }) => p.id === 78)!;
  assert.equal(whole.body_full_at, null);
});

// #163 asked for three things and body_full_at was one. The other two are the
// size of the cut and where it falls: a reader holding a 280-character string
// knows it is short and cannot tell whether it is short by twenty characters
// or by twenty thousand, which is the difference between fetching the full row
// and not bothering.
//
// KILLING MUTATIONS, one per assertion below:
//   body_length: length -> body.slice(0, FEED_BODY_PREVIEW).length
//   body_preview_len: FEED_BODY_PREVIEW -> a literal 140
//   the null rule: length ?? 0  in place of  ?? null
test("a cut feed row says how much there is and where the cut falls", async () => {
  const { env } = seeded();
  for (const page of [await frontPage(env as Env), await newestPage(env as Env)]) {
    const rows = page.posts as Array<Record<string, unknown>>;
    const long = rows.find((r) => r.id === 77)!;
    const short = rows.find((r) => r.id === 78)!;

    // The real length, not the preview's length. This is the whole point: if
    // body_length were computed after the slice it would always equal
    // body_preview_len on a cut row and say nothing at all.
    assert.equal(long.body_length, 400, "the length of the body, not of the preview");
    assert.equal((long.body as string).length, 280, "the preview is still cut");
    assert.notEqual(long.body_length, (long.body as string).length, "length must not be measured after the cut");

    // Where the cut falls, served rather than inferred from the string, so a
    // caller does not have to measure a preview to learn the policy.
    assert.equal(long.body_preview_len, 280);
    assert.equal(short.body_preview_len, 280, "the cap is a fact about the route, not about the row");

    // An uncut row still reports its length, so a caller never has to branch
    // on body_truncated to know what it is holding.
    assert.equal(short.body_truncated, false);
    assert.equal(short.body_length, "a short body".length);
    assert.equal(short.body_full_at, null);
  }
});

test("an empty body is a body, and is not reported as an absent one", async () => {
  // The bug this file did not catch on the first pass. `p.body ? ... : null` is
  // a FALSY test, so a post whose body is the empty string came back as
  // `body: null` with `body_length: 0` — the one pair the contract says can
  // never appear together, and reachable through the API because createPost
  // stores any string and nothing rejects "".
  //
  // KILLING MUTATION: `p.body == null` -> `!p.body` in either place -> red.
  const { env, db } = seeded();
  db.exec(`INSERT INTO posts (id, citizen_id, title, body, created_at) VALUES (81, 2, 'empty', '', 40);`);
  const rows = (await frontPage(env as Env)).posts as Array<Record<string, unknown>>;
  const empty = rows.find((r) => r.id === 81)!;
  assert.equal(empty.body, "", "an empty body is served as the empty string, not as null");
  assert.equal(empty.body_length, 0, "and its length is 0, which is a fact rather than an absence");
  assert.equal(empty.body_truncated, false);
  assert.equal(empty.body_full_at, null);
});

test("a null body has no length rather than a length of zero", async () => {
  const { env, db } = seeded();
  db.exec(`INSERT INTO posts (id, citizen_id, title, body, created_at) VALUES (79, 2, 'linkpost', NULL, 30);`);
  const rows = (await frontPage(env as Env)).posts as Array<Record<string, unknown>>;
  const linkpost = rows.find((r) => r.id === 79)!;
  // 0 would be a claim that the post has an empty body. It has none.
  assert.equal(linkpost.body, null);
  assert.equal(linkpost.body_length, null);
  assert.equal(linkpost.body_truncated, false);
});
