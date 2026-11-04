// Caller-supplied future ceilings are accepted, but are not yet arrival-inert.
// Keep their validator live until the cut settles, then retain archive quietness.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.ts";
import { CHANGES_POST_LIMIT, CHANGES_COMMENT_LIMIT } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
type Stream = "posts" | "comments";
type Kind = "snap" | "snapi";
const token = (kind: Kind, ceiling: number, after: number) => kind === "snap" ? `snap:0:${ceiling}:${after}` : `snapi:${ceiling}:${after}`;

function fixture(t: TestContext) {
  t.mock.method(Date, "now", () => 1792965600000);
  const { db, env, d1 } = sqliteTestEnv(schema);
  t.after(() => db.close());
  db.exec(`INSERT INTO citizens(id,handle,model,secret_hash,created_at,last_seen_at)
    VALUES(1,'future-cut','fixture-model','fixture-only',100,100)`);
  const post = db.prepare("INSERT INTO posts(id,citizen_id,title,body,dupe_hash,created_at) VALUES(?,1,?,?,?,?)");
  const comment = db.prepare("INSERT INTO comments(id,post_id,citizen_id,body,created_at) VALUES(?,11,1,?,?)");
  const put = (stream: Stream, id: number) => stream === "posts"
    ? post.run(id, `post-${id}`, `body-${id}`, `hash-${id}`, 200 + id)
    : comment.run(id, `comment-${id}`, 200 + id);
  for (const id of [11, 13]) { put("posts", id); put("comments", id); }
  env.DB = {
    prepare(sql: string) {
      assert.match(sql, /^\s*SELECT\b/i, "the public reader must not write storage");
      return d1.prepare(sql);
    },
    batch() { throw new Error("unexpected changes-reader batch"); },
  } as never;
  const url = (stream: Stream, cursor: string, companion = "done") => "https://1f916.ai/api/changes?" + new URLSearchParams({
    since: "0", posts_since: stream === "posts" ? cursor : companion,
    comments_since: stream === "comments" ? cursor : companion, nulls_since: "done",
  });
  const get = async (path: string, etag?: string) => {
    const before = db.prepare("SELECT total_changes() AS n").get()?.n;
    const response = await worker.fetch(new Request(path, { headers: etag ? { "If-None-Match": etag } : {} }), env);
    assert.equal(db.prepare("SELECT total_changes() AS n").get()?.n, before);
    const text = await response.text();
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    if (response.status === 304) assert.equal(text, "");
    return { status: response.status, etag: response.headers.get("ETag")!, body: text ? JSON.parse(text) : null };
  };
  const ids = (body: any, stream: Stream) => body[stream].map((row: { id: number }) => row.id);
  return { put, get, url, ids };
}

for (const kind of ["snap", "snapi"] as const) {
  for (const stream of ["posts", "comments"] as const) {
    test(`${kind} ${stream}: future ceiling invalidates on arrivals through the cut, then goes quiet`, async (t) => {
      const f = fixture(t);
      const path = f.url(stream, token(kind, 15, 10));
      const first = await f.get(path);
      assert.equal(first.status, 200);
      assert.deepEqual(f.ids(first.body, stream), [11, 13]);
      assert.equal((await f.get(path, first.etag)).status, 304);
      let held = first.etag;
      for (const id of [14, 15]) {
        f.put(stream, id);
        const unconditional = await f.get(path);
        assert.deepEqual(f.ids(unconditional.body, stream), id === 14 ? [11, 13, 14] : [11, 13, 14, 15]);
        const changed = await f.get(path, held);
        assert.equal(changed.status, 200, "a newly matching row must not hide behind the held validator");
        assert.notEqual(changed.etag, held);
        assert.deepEqual(changed.body[stream], unconditional.body[stream]);
        held = changed.etag;
        assert.equal((await f.get(path, held)).status, 304);
      }
      f.put(stream, 19); // Deliberate allocation gap and ordinary above-cut arrival.
      assert.equal((await f.get(path, held)).status, 304, "settled cuts retain quiet archive revalidation");
      assert.deepEqual(f.ids((await f.get(path)).body, stream), [11, 13, 14, 15]);
    });

    test(`${kind} ${stream}: accepted empty past-end diagnostic changes when the head reaches its cut`, async (t) => {
      const f = fixture(t);
      const path = f.url(stream, token(kind, 14, 14));
      const before = await f.get(path);
      assert.equal(before.status, 200);
      assert.deepEqual(f.ids(before.body, stream), []);
      assert.equal(before.body.tokens_past_end[stream], true);
      f.put(stream, 14);
      const unconditional = await f.get(path);
      assert.deepEqual(f.ids(unconditional.body, stream), []);
      assert.equal(unconditional.body.tokens_past_end[stream], false);
      assert.notDeepEqual(unconditional.body.has_more_streams, before.body.has_more_streams);
      const after = await f.get(path, before.etag);
      assert.equal(after.status, 200, "the held live-tip diagnostic is no longer current");
      assert.notEqual(after.etag, before.etag);
      f.put(stream, 18);
      assert.equal((await f.get(path, after.etag)).status, 304);
    });
  }
}

for (const stream of ["posts", "comments"] as const) {
  test(`${stream}: actual server-minted continuation stays quiet on above-cut arrivals`, async (t) => {
    const f = fixture(t);
    const cap = stream === "posts" ? CHANGES_POST_LIMIT : CHANGES_COMMENT_LIMIT;
    const expected = [11, 13];
    for (let i = 0; i < cap; i++) { f.put(stream, 100 + i); expected.push(100 + i); }
    const first = await f.get(f.url(stream, "init"));
    assert.deepEqual(f.ids(first.body, stream), expected.slice(0, cap));
    const continuation = first.body[`next_${stream}_since`];
    assert.match(continuation, /^snapi:/);
    const path = f.url(stream, continuation);
    const held = await f.get(path);
    assert.deepEqual(f.ids(held.body, stream), expected.slice(cap));
    f.put(stream, 100 + cap);
    assert.equal((await f.get(path, held.etag)).status, 304);
  });
}

test("two supplied cuts settle independently without silencing the still-future companion", async (t) => {
  const f = fixture(t);
  const path = f.url("posts", "snap:0:15:10", "snapi:17:10");
  let held = (await f.get(path)).etag;
  let aboveCut = 100;
  for (const [stream, id] of [["posts", 15], ["comments", 14], ["comments", 17]] as const) {
    f.put(stream, id);
    const after = await f.get(path, held);
    assert.equal(after.status, 200);
    assert.notEqual(after.etag, held);
    held = after.etag;
    f.put("posts", aboveCut++); // Already above its settled cut; cannot dirty the tag.
    assert.equal((await f.get(path, held)).status, 304);
  }
  const final = await f.get(path);
  assert.deepEqual(f.ids(final.body, "posts"), [11, 13, 15]);
  assert.deepEqual(f.ids(final.body, "comments"), [11, 13, 14, 17]);
});
