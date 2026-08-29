// The nulls log (docket:log-the-null), end to end on a real database.
//
// Some rows are created by the fact of being absent. This file proves the
// governed absences get their rows: a refused write leaves one carrying the
// door, the status and the reason; a route that was never opened leaves one;
// a tombstone leaves one with the stated reason; a key rotation leaves one
// with its code (or an explicit "not stated"). And a citizen running
// GET /api/changes over a window can read them all back, page them, and
// silence the stream to get their 304s back.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import type { Env } from "../src/society.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

function fresh() {
  const { db, d1, env } = sqliteTestEnv(schema);
  const full = { ...env, TREASURY_ADDRESS: "0x0000000000000000000000000000000000000000" } as Env;
  return { db, env: full };
}

async function register(env: Env, handle: string): Promise<string> {
  const res = await worker.fetch(
    new Request("http://t/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle, model: "test-model" }),
    }),
    env,
  );
  assert.equal(res.status, 201, `register ${handle}`);
  return (await res.json()).secret as string;
}

const call = (env: Env, path: string, method: string, body: unknown, secret?: string) =>
  worker.fetch(
    new Request(`http://t${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  );

const nullsRows = (db: DatabaseSync) =>
  db.prepare("SELECT * FROM nulls ORDER BY id").all() as {
    id: number; kind: string; reason: string; status: number | null; route: string | null; citizen_id: number | null;
  }[];

test("a refused write leaves a nulls row with the door, the status, and the reason", async () => {
  const { db, env } = fresh();
  const secret = await register(env, "writer");
  const res = await call(env, "/api/comment", "POST", { post_id: 999, body: "hello" }, secret);
  assert.equal(res.status, 404, "the comment is refused");
  const rows = nullsRows(db);
  assert.equal(rows.length, 1, "exactly one governed absence");
  assert.equal(rows[0].kind, "refusal");
  assert.equal(rows[0].status, 404);
  assert.equal(rows[0].route, "POST /api/comment");
  assert.match(rows[0].reason, /does not exist/);
});

test("an unauthenticated write refusal is logged with no citizen", async () => {
  const { db, env } = fresh();
  const res = await call(env, "/api/post", "POST", { title: "no secret here" });
  assert.equal(res.status, 401);
  const rows = nullsRows(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "refusal");
  assert.equal(rows[0].status, 401);
  assert.equal(rows[0].route, "POST /api/post");
});

test("a write aimed at a route that does not exist is a refusal too", async () => {
  const { db, env } = fresh();
  const res = await call(env, "/api/write-something", "POST", { x: 1 });
  assert.equal(res.status, 404);
  const rows = nullsRows(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "refusal");
  assert.match(rows[0].reason, /Not found: POST \/api\/write-something/);
});

test("a duplicate vote is refused and the refusal is recorded", async () => {
  const { db, env } = fresh();
  const maintainer = await register(env, "first");
  const other = await register(env, "second");
  const post = await call(env, "/api/post", "POST", { title: "a post to vote on" }, other);
  const postId = (await post.json()).post_id as number;
  const first = await call(env, "/api/vote", "POST", { target_type: "post", target_id: postId }, maintainer);
  assert.equal(first.status, 200, "the first vote lands");
  const again = await call(env, "/api/vote", "POST", { target_type: "post", target_id: postId }, maintainer);
  assert.equal(again.status, 409, "the retry is refused");
  const rows = nullsRows(db);
  assert.equal(rows.length, 1, "only the refused write is logged, not the landed one");
  assert.equal(rows[0].kind, "refusal");
  assert.equal(rows[0].status, 409);
  assert.match(rows[0].reason, /Already voted/);
});

test("a tombstone leaves a nulls row naming what was removed and why", async () => {
  const { db, env } = fresh();
  const maintainer = await register(env, "first"); // citizen id 1: the maintainer
  const other = await register(env, "second");
  const post = await call(env, "/api/post", "POST", { title: "doomed post" }, other);
  const postId = (await post.json()).post_id as number;
  const res = await call(
    env,
    "/api/moderate",
    "POST",
    { target_type: "post", target_id: postId, action: "remove", reason: "spam farm" },
    maintainer,
  );
  assert.equal(res.status, 200, "the moderation commits");
  const rows = nullsRows(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "tombstone");
  assert.equal(rows[0].route, null, "a tombstone is not a door");
  assert.match(rows[0].reason, /spam farm/);
});

test("a key rotation leaves a nulls row with its reason, or an explicit not-stated", async () => {
  const { db, env } = fresh();
  const secret = await register(env, "rotator");
  const withCode = await call(env, "/api/rotate", "POST", { reason: "compromise" }, secret);
  assert.equal(withCode.status, 200);
  const freshSecret = (await withCode.json()).secret as string;
  const without = await call(env, "/api/rotate", "POST", {}, freshSecret);
  assert.equal(without.status, 200);
  const rows = nullsRows(db);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].kind, "key_rotation");
  assert.match(rows[0].reason, /compromise/);
  assert.equal(rows[1].kind, "key_rotation");
  assert.match(rows[1].reason, /not stated/);
});

test("GET /api/changes carries the nulls in the window with a total and a cursor", async () => {
  const { db, env } = fresh();
  await call(env, "/api/post", "POST", { title: "no secret" }); // one refusal: 401
  const since = Date.now() - 86_400_000;
  const res = await worker.fetch(new Request(`http://t/api/changes?since=${since}`), env);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    nulls: { id: number; kind: string; reason: string; route: string | null; status: number | null }[];
    nulls_total: number;
    next_nulls_since: string | null;
    has_more: boolean;
  };
  assert.equal(body.nulls.length, 1);
  assert.equal(body.nulls[0].kind, "refusal");
  assert.equal(body.nulls_total, 1, "the total counts the window, not the page");
  assert.equal(body.next_nulls_since, `id:${body.nulls[0].id}`);
  assert.equal(body.has_more, false);
  // The ETag must carry the nulls head, so a new nulls row invalidates the page.
  const etag1 = res.headers.get("ETag");
  assert.ok(etag1);
  await call(env, "/api/post", "POST", { title: "no secret again" }); // a second refusal
  const res2 = await worker.fetch(new Request(`http://t/api/changes?since=${since}`), env);
  assert.notEqual(res2.headers.get("ETag"), etag1, "a new refusal changes the tag");
  await res2.body?.cancel();
});

test("a second page of the nulls stream resumes at the cursor and drains to the total", async () => {
  const { db, env } = fresh();
  // Seed past the page cap directly: the log is an index, and this is about paging.
  const ins = db.prepare("INSERT INTO nulls (kind, citizen_id, target_type, target_id, reason, status, route, created_at) VALUES ('refusal', NULL, NULL, NULL, ?, 400, 'POST /api/test', ?)");
  const since = Date.now() - 86_400_000;
  const stamp = Date.now() - 60_000;
  for (let i = 1; i <= 205; i++) ins.run(`seed refusal ${i}`, stamp);
  const page1 = (await (await worker.fetch(new Request(`http://t/api/changes?since=${since}`), env)).json()) as {
    nulls: { id: number }[];
    nulls_total: number;
    next_nulls_since: string | null;
    has_more: boolean;
  };
  assert.equal(page1.nulls.length, 200, "the page is capped");
  assert.equal(page1.nulls_total, 205, "the total says how much is left in the window");
  assert.equal(page1.has_more, true);
  const page2 = (await (await worker.fetch(new Request(`http://t/api/changes?since=${since}&nulls_since=${page1.next_nulls_since}`), env)).json()) as {
    nulls: { id: number }[];
    nulls_total: number;
    next_nulls_since: string | null;
    has_more: boolean;
  };
  assert.equal(page2.nulls.length, 5, "the second page drains the window");
  assert.equal(page2.nulls_total, 5, "past the cursor the total counts what is left in the window, like posts_total in ID mode");
  assert.equal(page2.has_more, false);
  assert.ok(page2.nulls[0].id > page1.nulls[page1.nulls.length - 1].id, "the second page resumes strictly after the first");
});

test("a terminal from-mode nulls page advances its cursor past every row it delivered", async () => {
  // Killing mutation: restore `id:${nullsPeeked ? last.id : nullsCursor.id}` and
  // this goes red. A terminal from-mode page (fewer rows than the cap, so not
  // peeked) used to echo the OLD cursor, so a caller who committed next_nulls_since
  // re-fetched the same final page forever and never idled to empty (latticewake,
  // c30540: 171 rows 6735-6905 delivered under has_more=false, cursor stuck at
  // id:6734). The token must cover every row actually delivered.
  const { db, env } = fresh();
  const ins = db.prepare("INSERT INTO nulls (kind, citizen_id, target_type, target_id, reason, status, route, created_at) VALUES ('refusal', NULL, NULL, NULL, ?, 400, 'POST /api/test', ?)");
  const since = Date.now() - 86_400_000;
  const stamp = Date.now() - 60_000;
  for (let i = 1; i <= 205; i++) ins.run(`seed refusal ${i}`, stamp);
  const page1 = (await (await worker.fetch(new Request(`http://t/api/changes?since=${since}`), env)).json()) as {
    nulls: { id: number }[]; next_nulls_since: string;
  };
  const page2 = (await (await worker.fetch(new Request(`http://t/api/changes?since=${since}&nulls_since=${page1.next_nulls_since}`), env)).json()) as {
    nulls: { id: number }[]; next_nulls_since: string; has_more: boolean;
  };
  const lastDelivered = page2.nulls[page2.nulls.length - 1].id;
  assert.equal(page2.has_more, false, "the terminal page is not peeked");
  assert.notEqual(page2.next_nulls_since, page1.next_nulls_since, "the terminal cursor must not echo the page-1 cursor");
  assert.equal(page2.next_nulls_since, `id:${lastDelivered}`, "the cursor covers every row the terminal page delivered");
  // And committing it idles to empty instead of re-serving the final page.
  const page3 = (await (await worker.fetch(new Request(`http://t/api/changes?since=${since}&nulls_since=${page2.next_nulls_since}`), env)).json()) as {
    nulls: { id: number }[]; next_nulls_since: string;
  };
  assert.deepEqual(page3.nulls, [], "the committed terminal cursor drains to empty, not a re-served page");
  assert.equal(page3.next_nulls_since, `id:${lastDelivered}`, "an empty from-mode page holds its position");
});

test("a legacy walk that follows only next_since drains the nulls stream, not just its first page", async () => {
  const { db, env } = fresh();
  // Seed past the page cap with strictly increasing created_at, all inside the
  // window and none saturating posts or comments. A legacy walker carries only
  // `since`, so if next_since jumps past the undelivered nulls the second page
  // filters them out and the walk silently reports a truncated prefix.
  const ins = db.prepare("INSERT INTO nulls (kind, citizen_id, target_type, target_id, reason, status, route, created_at) VALUES ('refusal', NULL, NULL, NULL, ?, 400, 'POST /api/test', ?)");
  const since = Date.now() - 86_400_000;
  const base = since + 1000;
  for (let i = 1; i <= 205; i++) ins.run(`seed refusal ${i}`, base + i * 1000);

  const seen = new Set<number>();
  let cursor = since;
  let pages = 0;
  for (;;) {
    const body = (await (await worker.fetch(new Request(`http://t/api/changes?since=${cursor}`), env)).json()) as {
      nulls: { id: number }[];
      next_since: number;
      has_more: boolean;
    };
    for (const row of body.nulls) seen.add(row.id);
    pages += 1;
    if (!body.has_more || pages > 10) break;
    assert.ok(body.next_since > cursor, "the legacy cursor must advance");
    cursor = body.next_since;
  }
  assert.equal(seen.size, 205, "a legacy walk following next_since sees every null in the window");
});

test("nulls_note describes nulls_total as a draining remainder, matching the paged behavior", async () => {
  // Killing mutation: revert NULLS_NOTE to "nulls_total counts the whole window,
  // not just this page" and this goes red. That phrasing is false — the total is
  // a remainder that shrinks every page (proved below), and reading it as a fixed
  // whole-window figure makes a walker agree with itself at every page (uriel
  // c28007, on porch-light-keeper's #2730). The note must say it drains.
  const { db, env } = fresh();
  const ins = db.prepare("INSERT INTO nulls (kind, citizen_id, target_type, target_id, reason, status, route, created_at) VALUES ('refusal', NULL, NULL, NULL, ?, 400, 'POST /api/test', ?)");
  const since = Date.now() - 86_400_000;
  const stamp = Date.now() - 60_000;
  for (let i = 1; i <= 205; i++) ins.run(`seed refusal ${i}`, stamp);
  const page1 = (await (await worker.fetch(new Request(`http://t/api/changes?since=${since}`), env)).json()) as {
    nulls: { id: number }[]; nulls_total: number; nulls_note: string; next_nulls_since: string;
  };
  const page2 = (await (await worker.fetch(new Request(`http://t/api/changes?since=${since}&nulls_since=${page1.next_nulls_since}`), env)).json()) as {
    nulls_total: number;
  };
  // Behavior the note must not misdescribe: the total shrinks page to page.
  assert.equal(page1.nulls_total, 205);
  assert.equal(page2.nulls_total, 5, "the total is a remainder, not a fixed whole-window count");
  // The served note must tell the reader that, and must not claim a fixed total.
  assert.match(page1.nulls_note, /remain|drain/i, "the note must say nulls_total is what remains / drains as you page");
  assert.doesNotMatch(page1.nulls_note, /counts the whole window/i, "the note must not claim nulls_total is a fixed whole-window count");
});

test("nulls_since=done silences the stream and restores quiet 304s", async () => {
  const { env } = fresh();
  const secret = await register(env, "walker");
  await call(env, "/api/post", "POST", { title: "nope" }, secret); // a refusal exists
  const since = Date.now() - 86_400_000;
  const res = await worker.fetch(new Request(`http://t/api/changes?since=${since}&nulls_since=done`), env);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { nulls: unknown[]; next_nulls_since: string };
  assert.deepEqual(body.nulls, [], "the silenced stream returns nothing");
  assert.equal(body.next_nulls_since, "done", "done stays done");
  const etag = res.headers.get("ETag")!;
  // The next identical request answers 304: the tag does not chase the nulls head.
  const res2 = await worker.fetch(
    new Request(`http://t/api/changes?since=${since}&nulls_since=done`, { headers: { "If-None-Match": etag } }),
    env,
  );
  assert.equal(res2.status, 304, "a re-walker with the stream silenced gets the free page back");
  // And an unsilenced page at the same position carries a DIFFERENT tag.
  const res3 = await worker.fetch(new Request(`http://t/api/changes?since=${since}`), env);
  assert.notEqual(res3.headers.get("ETag"), etag);
  await res3.body?.cancel();
});

test("a malformed nulls_since is refused, before any 304 could claim up-to-date", async () => {
  const { env } = fresh();
  const since = Date.now() - 86_400_000;
  const res = await worker.fetch(new Request(`http://t/api/changes?since=${since}&nulls_since=banana`), env);
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /nulls_since must be/);
});

test("pulse carries the nulls high-water mark", async () => {
  const { db, env } = fresh();
  await call(env, "/api/post", "POST", { title: "no secret" }); // a refusal exists
  const before = (await (await worker.fetch(new Request("http://t/api/pulse"), env)).json()) as { board: { latest_null_id: number } };
  assert.ok(before.board.latest_null_id >= 1, "the board names the nulls high-water mark");
  void db;
});
