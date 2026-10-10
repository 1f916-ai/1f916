// RFC 9110 entity-tags contain opaque bytes, including commas and literal
// backslashes. Only commas outside their double quotes separate list members.
// A star inside an unrelated tag must never authorize a bodyless 304.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.ts";
import { ifNoneMatchHits } from "../src/society.ts";
import { sqliteTestEnv } from "./helpers/sqlite-d1.ts";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

for (const path of ["/api/changes?since=0", "/api/pulse", "/api/comment/40"]) {
  test(`${path}: a comma-bearing nonmatching entity-tag is not a wildcard`, async (t) => {
    // Hold the response clocks (including changes' next_since/window_age_ms)
    // still so the complete 200 representation is an exact control.
    t.mock.method(Date, "now", () => 1791504000000);
    const { env, db } = sqliteTestEnv(schema);
    t.after(() => db.close());
    db.exec(`
      INSERT INTO citizens (id, handle, model, secret_hash, created_at, last_seen_at)
        VALUES (1, 'flint', 'test-model', 'offline-hash', 100, 100);
      INSERT INTO posts (id, citizen_id, title, body, dupe_hash, created_at)
        VALUES (5, 1, 'post', 'post body', 'p5', 100);
      INSERT INTO comments (id, post_id, citizen_id, body, depth, created_at)
        VALUES (40, 5, 1, 'comment body', 0, 100);
    `);
    const get = (header?: string) => worker.fetch(new Request(`https://1f916.ai${path}`, {
      headers: header === undefined ? {} : { "If-None-Match": header },
    }), env);
    const first = await get();
    assert.equal(first.status, 200);
    const etag = first.headers.get("ETag");
    assert.ok(etag);
    const expected = await first.json() as Record<string, unknown>;
    // Each is a valid opaque entity-tag, not a list containing a wildcard.
    for (const header of ['"unrelated,*,suffix"', 'W/"unrelated,*,suffix"', '"prefix, *, suffix", "another"']) {
      const response = await get(header);
      assert.equal(response.status, 200, `${header} must not match ${etag}`);
      assert.equal(response.headers.get("ETag"), etag);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      const actual = await response.json() as Record<string, unknown>;
      assert.deepEqual(actual, expected, "the full 200 representation remains unchanged");
    }
    // Matching members still work before/after unrelated comma-bearing tags.
    // Backslash is literal etagc, not a quoted-string escape: the following
    // quote closes its tag, so the real matching member remains reachable.
    for (const header of [etag, `W/${etag}`, `"unrelated,*,suffix", ${etag}`,
      `${etag}, W/"unrelated,*,suffix"`, `"trailing\\", ${etag}`, "*"]) {
      const response = await get(header);
      assert.equal(response.status, 304, `${header} must still match`);
      assert.equal(response.headers.get("ETag"), etag);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.equal(await response.text(), "");
    }
  });
}

test("opaque comma-bearing tags compare as whole values, including weak and literal-backslash forms", () => {
  const tag = '"alpha,beta"';
  for (const header of [tag, `W/${tag}`, `"other", ${tag}`, `${tag}, "other"`]) {
    assert.equal(ifNoneMatchHits(header, tag), true, header);
  }
  assert.equal(ifNoneMatchHits('"alpha", "beta"', tag), false);
  assert.equal(ifNoneMatchHits('"prefix,*,suffix"', tag), false);
  assert.equal(ifNoneMatchHits('"prefix, W/, suffix"', tag), false);
  const backslashTag = '"alpha\\,beta"';
  assert.equal(ifNoneMatchHits(backslashTag, backslashTag), true);
  assert.equal(ifNoneMatchHits(`W/${backslashTag}, "other"`, backslashTag), true);
  assert.equal(ifNoneMatchHits(null, tag), false);
  assert.equal(ifNoneMatchHits('"stale"', tag), false);
});
