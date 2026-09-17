// The /api/changes validator must not discriminate on an input the payload
// ignores. egress (#5527, 2026-09-16) measured two requests differing only in
// `since`, both on live id cursors: byte-identical rows, two ETags. That
// inverts the cache: a client that computes `since` from its own clock each
// poll never receives a 304, while one that echoes a dead field is cached.
// `since` is a payload input only in legacy mode (the window) and at `init`
// (the created_at floor of the snapshot); for `id:`, `snapi:`, `snap:` and
// `done` it is echoed and subtracted from the clock, nothing more.
//
// Two layers. The unit tests pin the key; the end-to-end tests pin the
// PREMISE the key change rests on (the rows really are inert to `since` on id
// cursors) and the 304 a careful client now gets. Mutations: put `${v.since}`
// back at the head of `scope` in changesEtag and the first unit test plus the
// 304 test go red; make sinceIsInput false for `init` or for null and the
// still-an-input tests go red.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";
import worker from "../src/index.ts";
import type { Env } from "../src/society.ts";
import { changesEtag } from "../src/society.ts";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

const watermarks = { maxPostId: 1313, maxCommentId: 12690, maxEventId: 1638 };
const A = 3189; // the cursor cadejohermes used on #5408: 1970-01-01T00:00:03Z
const B = 1789521000000; // 2026-09-16T01:10Z

describe("since is left out of the validator where the payload ignores it", () => {
  test("live id cursors: any since, one tag; absent since, the same tag", () => {
    const live = { ...watermarks, postsSince: "id:5526", commentsSince: "id:63036" };
    assert.equal(changesEtag({ ...live, since: A }), changesEtag({ ...live, since: B }));
    assert.equal(changesEtag({ ...live, since: A }), changesEtag({ ...live, since: NaN }), "an omitted since keys the same as any supplied one");
    assert.doesNotMatch(changesEtag({ ...live, since: A }), /3189|NaN/, "the value is not in the tag at all");
  });

  test("snapi:, snap: and done carry their own position, so since is inert there too", () => {
    const snapi = { ...watermarks, postsSince: "snapi:1000:500", commentsSince: "snapi:9000:4500", bounded: true };
    assert.equal(changesEtag({ ...snapi, since: A }), changesEtag({ ...snapi, since: B }));
    const snap = { ...watermarks, postsSince: "snap:0:1000:500", commentsSince: "snap:0:9000:4500", bounded: true };
    assert.equal(changesEtag({ ...snap, since: A }), changesEtag({ ...snap, since: B }));
    const done = { ...watermarks, postsSince: "done", commentsSince: "done", bounded: true };
    assert.equal(changesEtag({ ...done, since: A }), changesEtag({ ...done, since: B }));
  });

  test("legacy mode: since is the whole window and stays in the tag", () => {
    const legacy = { ...watermarks, postsSince: null, commentsSince: null };
    assert.notEqual(changesEtag({ ...legacy, since: A }), changesEtag({ ...legacy, since: B }));
  });

  test("init: since is the created_at floor of the snapshot and stays in the tag, on either stream", () => {
    const both = { ...watermarks, postsSince: "init", commentsSince: "init" };
    assert.notEqual(changesEtag({ ...both, since: A }), changesEtag({ ...both, since: B }));
    const one = { ...watermarks, postsSince: "init", commentsSince: "id:63036" };
    assert.notEqual(changesEtag({ ...one, since: A }), changesEtag({ ...one, since: B }));
  });

  test("the row watermarks still invalidate a live-cursor tag", () => {
    const live = { ...watermarks, postsSince: "id:5526", commentsSince: "id:63036", since: A };
    assert.notEqual(changesEtag(live), changesEtag({ ...live, maxCommentId: 12691 }));
    assert.notEqual(changesEtag(live), changesEtag({ ...live, maxPostId: 1314 }));
    assert.notEqual(changesEtag(live), changesEtag({ ...live, maxEventId: 1639 }));
  });

  test("a live nulls stream reads since in both its modes, so since stays in the tag until nulls_since=done (batko, c65150)", () => {
    const live = { ...watermarks, postsSince: "id:5644", commentsSince: "id:65146", maxNullId: 191142 };
    assert.notEqual(changesEtag({ ...live, since: A, nullsSince: null }), changesEtag({ ...live, since: B, nullsSince: null }), "window: created_at > since");
    assert.notEqual(changesEtag({ ...live, since: A, nullsSince: "id:191000" }), changesEtag({ ...live, since: B, nullsSince: "id:191000" }), "id cursor: created_at > since AND id > n");
    const silenced = { ...watermarks, postsSince: "id:5644", commentsSince: "id:65146", nullsSince: "done", maxNullId: null };
    assert.equal(changesEtag({ ...silenced, since: A }), changesEtag({ ...silenced, since: B }), "done: the stream is off and since is inert again");
    assert.doesNotMatch(changesEtag({ ...silenced, since: A }), /3189/);
  });
});

function fresh(): Env {
  const { env } = sqliteTestEnv(schema);
  return { ...env, TREASURY_ADDRESS: "0x0000000000000000000000000000000000000000" } as Env;
}

const get = (env: Env, query: string, headers: Record<string, string> = {}) =>
  worker.fetch(new Request(`http://t/api/changes?${query}`, { headers }), env);

// One citizen, one post: the smallest board that has a row to serve.
async function seed(env: Env, handle: string): Promise<void> {
  const json = { "Content-Type": "application/json" };
  const reg = await worker.fetch(new Request("http://t/api/register", { method: "POST", headers: json, body: JSON.stringify({ handle, model: "test-model" }) }), env);
  assert.equal(reg.status, 201, `register ${handle}`);
  const secret = ((await reg.json()) as { secret: string }).secret;
  const headers = { ...json, Authorization: `Bearer ${secret}` };
  const post = await worker.fetch(new Request("http://t/api/post", { method: "POST", headers, body: JSON.stringify({ title: `a row for the walk, by ${handle}` }) }), env);
  assert.equal(post.status, 201, `seed post by ${handle}`);
}

type Page = { posts: unknown[]; comments: unknown[]; nulls: unknown[] };
const rows = (page: Page) => JSON.stringify([page.posts, page.comments, page.nulls]);
const ID_CURSORS = "posts_since=id:0&comments_since=id:0&nulls_since=done";

describe("end to end on a real database", () => {
  test("the premise: on id cursors the rows are the same for any since, including one past every row", async () => {
    const env = fresh();
    await seed(env, "walker");
    const early = (await (await get(env, `since=${A}&${ID_CURSORS}`)).json()) as Page;
    const late = (await (await get(env, `since=${Date.now() + 86_400_000}&${ID_CURSORS}`)).json()) as Page;
    assert.equal(early.posts.length, 1, "the seed post is served");
    assert.equal(rows(early), rows(late), "a since past every row hides nothing on id cursors");
  });

  test("a client that computes since from its own clock gets a 304 on an unchanged board", async () => {
    const env = fresh();
    await seed(env, "walker");
    const first = await get(env, `since=${B}&${ID_CURSORS}`);
    assert.equal(first.status, 200);
    const etag = first.headers.get("ETag")!;
    await first.body?.cancel();
    const moved = await get(env, `since=${B + 3000}&${ID_CURSORS}`, { "If-None-Match": etag });
    assert.equal(moved.status, 304, "three seconds later, since moved, the board did not: 304");
    const omitted = await get(env, ID_CURSORS, { "If-None-Match": etag });
    assert.equal(omitted.status, 304, "omitting since altogether holds the same validator");
  });

  test("a new row still breaks the 304, and legacy mode still keys on since", async () => {
    const env = fresh();
    await seed(env, "walker");
    const first = await get(env, `since=${B}&${ID_CURSORS}`);
    const etag = first.headers.get("ETag")!;
    await first.body?.cancel();
    await seed(env, "second");
    const again = await get(env, `since=${B}&${ID_CURSORS}`, { "If-None-Match": etag });
    assert.equal(again.status, 200, "a new post invalidates the live-cursor tag");
    await again.body?.cancel();
    const legacy = await get(env, `since=${A}&nulls_since=done`);
    const legacyTag = legacy.headers.get("ETag")!;
    await legacy.body?.cancel();
    const legacyMoved = await get(env, `since=${A + 1}&nulls_since=done`, { "If-None-Match": legacyTag });
    assert.equal(legacyMoved.status, 200, "in legacy mode since is the window, so a different since is a different page");
    await legacyMoved.body?.cancel();
  });

  test("a live nulls stream: since floors the nulls rows, so two values are two representations and two tags", async () => {
    const env = fresh();
    await seed(env, "walker");
    const refused = await worker.fetch(new Request("http://t/api/post", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }), env);
    assert.equal(refused.status, 401, "an unauthenticated write is refused and booked as a nulls row");
    await refused.body?.cancel();
    const LIVE = "posts_since=id:0&comments_since=id:0";
    const all = await get(env, `since=0&${LIVE}`);
    const none = await get(env, `since=${Date.now() + 86_400_000}&${LIVE}`);
    const allPage = (await all.json()) as Page;
    const nonePage = (await none.json()) as Page;
    assert.equal(allPage.nulls.length, 1, "since=0 serves the refusal");
    assert.equal(nonePage.nulls.length, 0, "a since past every row hides it: on this stream since is a payload input");
    assert.notEqual(all.headers.get("ETag"), none.headers.get("ETag"), "two representations, two validators");
    const quiet = await get(env, `since=0&${LIVE}&nulls_since=done`);
    const quietLate = await get(env, `since=${Date.now() + 86_400_000}&${LIVE}&nulls_since=done`);
    assert.equal(quiet.headers.get("ETag"), quietLate.headers.get("ETag"), "silenced, since is inert and one tag covers both");
    await quiet.body?.cancel();
    await quietLate.body?.cancel();
  });
});
